import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import {
  Application,
  DocumentType,
  Finding,
  nextOutcome,
} from "kalabasa-contract/schemas.js";
import { extractDocumentCached } from "../extraction/cache.js";
import { readPdfPages } from "../extraction/pdf.js";
import { checkRequiredFields, checkRequirements, compareAcrossDocuments } from "../rules/index.js";
import {
  ActivityResponse,
  ApiError,
  ApplicationsResponse,
  CreateApplicationResponse,
  FindingUpdate,
  Requirements,
  Stats,
} from "./schemas.js";
import { createStore } from "./store.js";
import { readApplicationChecklist } from "./checklist.js";

const apiDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(apiDirectory, "../..");
const repositoryRoot = path.resolve(backendRoot, "..");
const fixturesDirectory = path.join(repositoryRoot, "contract", "fixtures");
const frontendDirectory = path.join(repositoryRoot, "frontend", "dist");
const frontendIndex = path.join(frontendDirectory, "index.html");
const requirementsPath = path.join(repositoryRoot, "samples", "lgu_requirements.json");
const uploadRoot = path.join(backendRoot, ".cache", "uploads");
const requirements = Requirements.parse(JSON.parse(await fs.readFile(requirementsPath, "utf8")));

function sendParsed(response, schema, value, status = 200) {
  return response.status(status).json(schema.parse(value));
}

function sendError(response, status, message) {
  return sendParsed(response, ApiError, { error: message }, status);
}

async function loadFixtures() {
  const names = (await fs.readdir(fixturesDirectory)).filter((name) => name.endsWith(".json"));
  return Promise.all(names.map(async (name) =>
    Application.parse(JSON.parse(await fs.readFile(path.join(fixturesDirectory, name), "utf8")))));
}

const fixtureApplications = await loadFixtures();

function audit(store, application, action, details = {}) {
  return store.audit({
    application_id: application.id,
    action,
    actor: "reviewer",
    details,
    timestamp: new Date().toISOString(),
  });
}

function fixtureAudit(applications, auditEntries) {
  const entries = [...auditEntries];
  const auditedIds = new Set(auditEntries.map((entry) => entry.application_id));
  for (const application of applications) {
    if (auditedIds.has(application.id)) continue;
    const timestamp = application.created_at;
    entries.push({ application_id: application.id, action: "application_created", details: {}, timestamp });
    if (!["uploaded", "extracting"].includes(application.status)) {
      entries.push({ application_id: application.id, action: "application_processed", details: {}, timestamp });
    }
    if (application.status === "approved" || application.status === "returned") {
      entries.push({
        application_id: application.id,
        action: application.status === "approved" ? "application_approved" : "application_returned",
        details: {},
        timestamp,
      });
    }
  }
  return entries;
}

function activityText(entry) {
  switch (entry.action) {
    case "application_created": return "New application received";
    case "extraction_completed": return Number(entry.details?.findings) > 0 ? "Inconsistency flagged" : "Application processed";
    case "application_processed": return "Application processed";
    case "finding_updated": return "Finding reviewed";
    case "application_approved": return "Application approved";
    case "application_returned": return "Application returned for correction";
    default: return null;
  }
}

function uploadedDocuments(application, readPdf = readPdfPages) {
  const docs = application.documents.map((item) => item.document);
  const form = application.documents.find((item) => item.document === "application_form");
  if (!form) return docs;
  const filename = path.join(uploadRoot, application.id, `${form.document}.pdf`);
  return readPdf(filename).then(({ pages }) => [
    { document: form.document, checklist: readApplicationChecklist(pages) },
    ...docs.filter((document) => document !== form.document),
  ]);
}

export function createApp({
  store = createStore(fixtureApplications),
  mockMode = process.env.MOCK_MODE === "true",
  readPdf = readPdfPages,
  extractDocument = extractDocumentCached,
} = {}) {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (request, response) => response.json({ ok: true, mock_mode: mockMode }));

  app.get("/api/lgus/:id/requirements", (request, response) => {
    if (request.params.id !== requirements.lgu.id) return sendError(response, 404, "LGU not found.");
    return sendParsed(response, Requirements, requirements);
  });

  app.get("/api/applications", async (request, response, next) => {
    try {
      return sendParsed(response, ApplicationsResponse, await store.list());
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/activity", async (request, response, next) => {
    try {
      const requestedLimit = Number(request.query.limit ?? 10);
      const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(0, Math.floor(requestedLimit))) : 10;
      let entries = await store.recentAudit(5000);
      if (mockMode) entries = fixtureAudit(await store.list(), entries);
      const activity = entries
        .map((entry) => ({
          application_id: entry.application_id,
          action: entry.action,
          text: activityText(entry),
          timestamp: entry.timestamp,
        }))
        .filter((entry) => entry.text)
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .slice(0, limit);
      return sendParsed(response, ActivityResponse, activity);
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/stats", async (request, response, next) => {
    try {
      const applications = await store.list();
      let entries = await store.recentAudit(5000);
      if (mockMode) entries = fixtureAudit(applications, entries);
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const processedToday = entries.filter((entry) =>
        ["application_approved", "application_returned"].includes(entry.action)
        && new Date(entry.timestamp) >= startOfToday
        && new Date(entry.timestamp) <= new Date()).length;
      return sendParsed(response, Stats, {
        pending: applications.filter((application) => application.status === "ready_for_review").length,
        processed_today: processedToday,
        flagged: applications.filter((application) => application.status === "ready_for_review" && application.open_findings > 0).length,
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/applications", upload.array("files"), async (request, response, next) => {
    try {
      if (mockMode) {
        const fixture = fixtureApplications.find((item) =>
          item.id === request.body?.fixture || item.id === `app-${request.body?.fixture}`);
        const selected = fixture ?? fixtureApplications.find((item) => item.id === "app-set_05_demo_story");
        if (!selected) return sendError(response, 500, "No mock application fixture is available.");
        await store.save(selected);
        await audit(store, selected, "application_created", { mode: "mock" });
        return sendParsed(response, CreateApplicationResponse, { id: selected.id }, 201);
      }

      const files = request.files ?? [];
      const documentTypes = request.body.document_types ?? request.body["document_types[]"];
      const types = Array.isArray(documentTypes) ? documentTypes : documentTypes ? [documentTypes] : [];
      if (files.length === 0 || files.length !== types.length) {
        return sendError(response, 400, "Upload one PDF per document_types[] entry.");
      }
      const parsedTypes = types.map((type) => DocumentType.parse(type));
      if (new Set(parsedTypes).size !== parsedTypes.length) {
        return sendError(response, 400, "Only one PDF per document type can be uploaded.");
      }
      if (files.some((file) => file.mimetype !== "application/pdf" && !file.originalname.toLowerCase().endsWith(".pdf"))) {
        return sendError(response, 400, "Every uploaded document must be a PDF.");
      }

      const id = crypto.randomUUID();
      const directory = path.join(uploadRoot, id);
      await fs.mkdir(directory, { recursive: true });
      const documents = [];
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        await fs.writeFile(path.join(directory, `${parsedTypes[index]}.pdf`), file.buffer);
        documents.push({
          document: parsedTypes[index],
          filename: path.basename(file.originalname),
          pages: 1,
          method: "text_layer",
        });
      }

      const application = Application.parse({
        id,
        lgu_id: request.body.lgu_id ?? requirements.lgu.id,
        label: request.body.label ?? "Business Permit Application",
        status: "uploaded",
        created_at: new Date().toISOString(),
        documents,
        fields: [],
        findings: [],
      });
      await store.save(application);
      await audit(store, application, "application_created");
      return sendParsed(response, CreateApplicationResponse, { id }, 201);
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError") return sendError(response, 400, error.message);
      return next(error);
    }
  });

  app.post("/api/applications/:id/process", async (request, response, next) => {
    let application;
    try {
      application = await store.get(request.params.id);
      if (!application) return sendError(response, 404, "Application not found.");
      if (mockMode) {
        await audit(store, application, "application_processed", { mode: "mock" });
        return sendParsed(response, Application, application, 202);
      }

      application.status = "extracting";
      await store.save(application);
      await audit(store, application, "extraction_started");
      const fieldGroups = await Promise.all(application.documents.map(async (document) => {
        const filePath = path.join(uploadRoot, application.id, `${document.document}.pdf`);
        const { pages, method } = await readPdf(filePath);
        document.pages = pages.length;
        document.method = method;
        return extractDocument({ document: document.document, pages, method });
      }));
      const allFields = fieldGroups.flat();
      application.fields = allFields;
      const uploaded = await uploadedDocuments(application, readPdf);
      application.findings = [
        ...checkRequirements(uploaded, requirements),
        ...checkRequiredFields(allFields, requirements),
        ...compareAcrossDocuments(allFields, requirements),
      ];
      application.status = "ready_for_review";
      await store.save(application);
      await audit(store, application, "extraction_completed", { fields: allFields.length, findings: application.findings.length });
      return sendParsed(response, Application, application, 202);
    } catch (error) {
      if (application?.status === "extracting") {
        application.status = "uploaded";
        await store.save(application);
        await audit(store, application, "extraction_failed");
      }
      if (error instanceof Error && error.name === "ZodError") return sendError(response, 400, error.message);
      return sendError(response, 500, error.message || "The application could not be processed.");
    }
  });

  app.get("/api/applications/:id", async (request, response, next) => {
    try {
      const application = await store.get(request.params.id);
      if (!application) return sendError(response, 404, "Application not found.");
      return sendParsed(response, Application, application);
    } catch (error) {
      return next(error);
    }
  });

  app.patch("/api/applications/:id/findings/:findingId", async (request, response, next) => {
    try {
      const application = await store.get(request.params.id);
      if (!application) return sendError(response, 404, "Application not found.");
      if (["approved", "returned"].includes(application.status)) {
        return sendError(response, 409, "This application already has a final decision.");
      }
      const input = FindingUpdate.parse(request.body);
      if (["dismissed", "escalated"].includes(input.status) && !input.reviewer_note?.trim()) {
        return sendError(response, 400, "A reviewer note is required to dismiss or escalate a finding.");
      }
      const index = application.findings.findIndex((item) => item.finding_id === request.params.findingId);
      if (index < 0) return sendError(response, 404, "Finding not found.");
      const updated = Finding.parse({
        ...application.findings[index],
        status: input.status,
        reviewer_note: input.reviewer_note ?? null,
        decided_at: new Date().toISOString(),
      });
      application.findings[index] = updated;
      await store.save(application);
      await audit(store, application, "finding_updated", {
        finding_id: updated.finding_id,
        status: updated.status,
        reviewer_note: updated.reviewer_note,
      });
      return sendParsed(response, Finding, updated);
    } catch (error) {
      if (error.name === "ZodError") return sendError(response, 400, error.message);
      return next(error);
    }
  });

  for (const outcome of ["approve", "return"]) {
    app.post(`/api/applications/:id/${outcome}`, async (request, response, next) => {
      try {
        const application = await store.get(request.params.id);
        if (!application) return sendError(response, 404, "Application not found.");
        if (["approved", "returned"].includes(application.status)) {
          return sendError(response, 409, "This application already has a final decision.");
        }
        if (nextOutcome(application) !== outcome) {
          return sendError(response, 409, `Application cannot be ${outcome === "approve" ? "approved" : "returned"} in its current finding state.`);
        }
        application.status = outcome === "approve" ? "approved" : "returned";
        await store.save(application);
        await audit(store, application, `application_${outcome}`);
        return sendParsed(response, Application, application);
      } catch (error) {
        return next(error);
      }
    });
  }

  if (existsSync(frontendIndex)) {
    app.use(express.static(frontendDirectory));
    app.get(/^(?!\/api(?:\/|$))/i, (request, response, next) => {
      response.sendFile(frontendIndex, (error) => { if (error) next(error); });
    });
  }
  app.use((request, response) => sendError(response, 404, "API route not found."));
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return sendError(response, 400, "Each PDF must be 20 MB or smaller.");
    }
    console.error(error);
    return sendError(response, 500, "The request could not be completed.");
  });
  return app;
}

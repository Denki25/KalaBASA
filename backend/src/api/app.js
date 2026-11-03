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
import { DailyExtractionLimitError, extractDocumentCached, getLlmConfig } from "../extraction/cache.js";
import { readDocumentPages } from "../extraction/pdf.js";
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
import { WRITE_ROLES, authMiddleware, currentActor } from "./auth.js";
import { createLocalStorage } from "./documents.js";
import { UploadValidationError, validateUploadFile } from "./upload-validation.js";
import { buildReport } from "./reports.js";

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

function createIpRateLimiter(limit, windowMs = 10 * 60 * 1000) {
  const requests = new Map();
  return (request, response, next) => {
    const now = Date.now();
    for (const [key, value] of requests) {
      if (now - value.startedAt >= windowMs) requests.delete(key);
    }
    const ip = request.ip || request.socket.remoteAddress || "unknown";
    const bucket = requests.get(ip);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      requests.set(ip, { startedAt: now, count: 1 });
      return next();
    }
    if (bucket.count >= limit) return sendError(response, 429, "Too many requests. Please try again later.");
    bucket.count += 1;
    return next();
  };
}

function createDailyModelCallGuard(limit) {
  let utcDay = new Date().toISOString().slice(0, 10);
  let calls = 0;
  return () => {
    const currentDay = new Date().toISOString().slice(0, 10);
    if (currentDay !== utcDay) {
      utcDay = currentDay;
      calls = 0;
    }
    if (calls >= limit) throw new DailyExtractionLimitError();
    calls += 1;
  };
}

function audit(store, application, action, details = {}) {
  return store.audit({
    application_id: application.id,
    action,
    actor: currentActor(),
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

function uploadedDocuments(application, readPdf, fileStorage, documentPages = new Map()) {
  const docs = application.documents.map((item) => item.document);
  const form = application.documents.find((item) => item.document === "application_form");
  if (!form) return docs;
  const readForm = documentPages.has(form.document)
    ? Promise.resolve(documentPages.get(form.document))
    : fileStorage.withFile(application.id, form.document, (filename) => readPdf(filename), form.filename);
  return readForm.then(({ pages }) => [
    { document: form.document, checklist: readApplicationChecklist(pages) },
    ...docs.filter((document) => document !== form.document),
  ]);
}

export function createApp({
  store = createStore(fixtureApplications),
  mockMode = process.env.MOCK_MODE === "true",
  readPdf = readDocumentPages,
  extractDocument = extractDocumentCached,
  auth = null,
  fileStorage = createLocalStorage(uploadRoot),
  rateLimitPer10Min = Number.parseInt(process.env.RATE_LIMIT_PER_10MIN ?? "20", 10),
  dailyExtractionLimit = Number.parseInt(process.env.DAILY_EXTRACTION_LIMIT ?? "200", 10),
} = {}) {
  const app = express();
  const extractionProgress = new Map();
  const llmConfig = getLlmConfig();
  app.set("trust proxy", 1);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 5 } });
  const mutationRateLimit = createIpRateLimiter(Number.isFinite(rateLimitPer10Min) ? Math.max(0, rateLimitPer10Min) : 20);
  const reserveDailyModelCall = createDailyModelCallGuard(Number.isFinite(dailyExtractionLimit) ? Math.max(0, dailyExtractionLimit) : 200);
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (request, response) => response.json({ ok: true, mock_mode: mockMode }));

  app.get("/api/lgus/:id/requirements", (request, response) => {
    if (request.params.id !== requirements.lgu.id) return sendError(response, 404, "LGU not found.");
    return sendParsed(response, Requirements, requirements);
  });

  // ---- Login and access control (turned on when `auth` is given) ----
  const authEnabled = Boolean(auth);
  const canSee = (request, lguId) => !authEnabled || request.user.role === "admin" || request.user.lgu_id === lguId;
  const needWrite = (request, response, next) => {
    if (!authEnabled || WRITE_ROLES.includes(request.user?.role)) return next();
    return sendError(response, 403, "Your role can view applications but cannot change them.");
  };
  const visibleApplications = async (request) =>
    (await store.list()).filter((item) => canSee(request, item.lgu_id));

  if (authEnabled) {
    app.post("/api/auth/login", async (request, response, next) => {
      try {
        const email = String(request.body?.email ?? "").trim();
        const password = String(request.body?.password ?? "");
        if (!email || !password) return sendError(response, 400, "Enter your email and password.");
        const result = await auth.login(email, password);
        if (result.error) return sendError(response, 401, result.error);
        return response.json({ token: result.token, user: result.user });
      } catch (error) {
        return next(error);
      }
    });

    // Everything below this line needs a signed-in user.
    app.use("/api", authMiddleware(auth));

    app.get("/api/auth/me", (request, response) => response.json({ user: request.user }));

    // Every /api/applications/:id/... route: the application must belong to the user's LGU
    // (admins can see all LGUs), and only reviewers and admins may change it.
    app.use("/api/applications/:id", async (request, response, next) => {
      try {
        const application = await store.get(request.params.id);
        if (!application || !canSee(request, application.lgu_id)) {
          return sendError(response, 404, "Application not found.");
        }
        if (request.method !== "GET") return needWrite(request, response, next);
        return next();
      } catch (error) {
        return next(error);
      }
    });
  }

  app.get("/api/applications", async (request, response, next) => {
    try {
      return sendParsed(response, ApplicationsResponse, await visibleApplications(request));
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/applications/:id/progress", (request, response) => {
    return response.json(extractionProgress.get(request.params.id) ?? { documents: [] });
  });

  app.get("/api/activity", async (request, response, next) => {
    try {
      const requestedLimit = Number(request.query.limit ?? 10);
      const limit = Number.isFinite(requestedLimit) ? Math.min(5000, Math.max(0, Math.floor(requestedLimit))) : 10;
      const visible = await visibleApplications(request);
      const visibleIds = new Set(visible.map((item) => item.id));
      let entries = (await store.recentAudit(5000)).filter((entry) => visibleIds.has(entry.application_id));
      if (mockMode) entries = fixtureAudit(visible, entries);
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
      const applications = await visibleApplications(request);
      const visibleIds = new Set(applications.map((item) => item.id));
      let entries = (await store.recentAudit(5000)).filter((entry) => visibleIds.has(entry.application_id));
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

  app.get("/api/reports", async (request, response, next) => {
    try {
      const period = {
        from: request.query.from ? String(request.query.from) : undefined,
        to: request.query.to ? String(request.query.to) : undefined,
      };
      buildReport({ applications: [], audit: [] }, period);
      const previousPeriod = period.from && period.to ? (() => {
        const start = new Date(period.from);
        const end = new Date(period.to);
        const duration = end.getTime() - start.getTime() + 1;
        return { from: new Date(start.getTime() - duration).toISOString(), to: new Date(start.getTime() - 1).toISOString() };
      })() : null;
      const queryPeriod = previousPeriod ? { from: previousPeriod.from, to: period.to } : period;
      const snapshot = await store.reportSnapshot(authEnabled ? request.user.lgu_id : requirements.lgu.id,
        authEnabled && request.user.role === "admin", queryPeriod);
      const report = buildReport(snapshot, period);
      if (previousPeriod) {
        const previous = buildReport(snapshot, previousPeriod);
        const currentOpen = report.findings_by_status.open + report.findings_by_status.escalated;
        const previousOpen = previous.findings_by_status.open + previous.findings_by_status.escalated;
        report.comparison = {
          application_total: report.application_total - previous.application_total,
          under_review: report.applications_by_status.extracting + report.applications_by_status.ready_for_review
            - previous.applications_by_status.extracting - previous.applications_by_status.ready_for_review,
          ready_for_review: report.applications_by_status.ready_for_review - previous.applications_by_status.ready_for_review,
          approved: report.applications_by_status.approved - previous.applications_by_status.approved,
          returned: report.applications_by_status.returned - previous.applications_by_status.returned,
          documents_total: report.documents_total - previous.documents_total,
          findings_total: report.findings_total - previous.findings_total,
          open_findings: currentOpen - previousOpen,
        };
      }
      return response.json(report);
    } catch (error) {
      if (error.message === "Choose a valid reporting date range.") return sendError(response, 400, error.message);
      return next(error);
    }
  });

  app.post("/api/applications", needWrite, mutationRateLimit, upload.array("files"), async (request, response, next) => {
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
        return sendError(response, 400, "Upload one supported file per document_types[] entry.");
      }
      const parsedTypes = types.map((type) => DocumentType.parse(type));
      if (new Set(parsedTypes).size !== parsedTypes.length) {
        return sendError(response, 400, "Only one file per document type can be uploaded.");
      }
      const media = [];
      for (const file of files) media.push(await validateUploadFile(file));

      const id = crypto.randomUUID();
      const documents = [];
      const stored = [];
      try {
        for (let index = 0; index < files.length; index++) {
          const file = files[index];
          const safeFilename = path.win32.basename(path.basename(file.originalname ?? "")).replace(/[\u0000-\u001f\u007f]/g, "").trim()
            || `${parsedTypes[index]}${media[index].extension}`;
          await fileStorage.save(id, parsedTypes[index], file.buffer, safeFilename);
          stored.push({ document: parsedTypes[index], filename: safeFilename });
          documents.push({
            document: parsedTypes[index],
            filename: safeFilename,
            pages: 1,
            method: "text_layer",
          });
        }
      } catch (error) {
        await fileStorage.remove(id, stored).catch(() => {});
        throw error;
      }

      const application = Application.parse({
        id,
        lgu_id: authEnabled ? request.user.lgu_id : (request.body.lgu_id ?? requirements.lgu.id),
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
      if (error instanceof UploadValidationError) return sendError(response, 400, error.message);
      if (error instanceof Error && error.name === "ZodError") return sendError(response, 400, error.message);
      return next(error);
    }
  });

  app.post("/api/applications/:id/process", mutationRateLimit, async (request, response, next) => {
    response.set("X-LLM-Provider", llmConfig.provider);
    response.set("X-LLM-Model", llmConfig.model);
    let application;
    try {
      application = await store.get(request.params.id);
      if (!application) return sendError(response, 404, "Application not found.");
      if (mockMode) {
        extractionProgress.set(application.id, {
          documents: application.documents.map((document) => ({ document: document.document, status: "complete" })),
        });
        await audit(store, application, "application_processed", { mode: "mock" });
        return sendParsed(response, Application, application, 202);
      }

      application.status = "extracting";
      await store.save(application);
      await audit(store, application, "extraction_started");
      const progress = application.documents.map((document, index) => ({
        document: document.document,
        status: index === 0 ? "reading" : "queued",
      }));
      extractionProgress.set(application.id, { documents: progress });
      const fieldGroups = [];
      const documentPages = new Map();
      for (let index = 0; index < application.documents.length; index += 1) {
        const document = application.documents[index];
        progress[index].status = "reading";
        extractionProgress.set(application.id, { documents: progress.map((item) => ({ ...item })) });
        try {
          const { pages, method } = await fileStorage.withFile(
            application.id,
            document.document,
            (filePath) => readPdf(filePath),
            document.filename,
          );
          documentPages.set(document.document, { pages, method });
          document.pages = pages.length;
          document.method = method;
          progress[index].status = "checking";
          extractionProgress.set(application.id, { documents: progress.map((item) => ({ ...item })) });
          fieldGroups.push(await extractDocument({
            document: document.document,
            pages,
            method,
            live: true,
            provider: llmConfig.provider,
            model: llmConfig.model,
            onModelCall: reserveDailyModelCall,
          }));
          progress[index].status = "complete";
          if (index + 1 < progress.length) progress[index + 1].status = "reading";
          extractionProgress.set(application.id, { documents: progress.map((item) => ({ ...item })) });
        } catch (error) {
          progress[index].status = "failed";
          extractionProgress.set(application.id, { documents: progress.map((item) => ({ ...item })) });
          throw error;
        }
      }
      const allFields = fieldGroups.flat();
      application.fields = allFields;
      const uploaded = await uploadedDocuments(application, readPdf, fileStorage, documentPages);
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
      if (error instanceof DailyExtractionLimitError) return sendError(response, 429, error.message);
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
      return sendError(response, 400, "PDF files must be 20 MB or smaller; image files must be 10 MB or smaller.");
    }
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_COUNT") return sendError(response, 400, "Upload up to 5 documents at a time.");
    console.error(error);
    return sendError(response, 500, "The request could not be completed.");
  });
  return app;
}

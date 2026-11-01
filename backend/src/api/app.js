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
import { WRITE_ROLES, authMiddleware, currentActor } from "./auth.js";
import { createLocalStorage } from "./documents.js";

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

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, limit);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
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

function uploadedDocuments(application, readPdf, fileStorage) {
  const docs = application.documents.map((item) => item.document);
  const form = application.documents.find((item) => item.document === "application_form");
  if (!form) return docs;
  return fileStorage.withFile(application.id, form.document, (filename) => readPdf(filename)).then(({ pages }) => [
    { document: form.document, checklist: readApplicationChecklist(pages) },
    ...docs.filter((document) => document !== form.document),
  ]);
}

export function createApp({
  store = createStore(fixtureApplications),
  mockMode = process.env.MOCK_MODE === "true",
  readPdf = readPdfPages,
  extractDocument = extractDocumentCached,
  auth = null,
  fileStorage = createLocalStorage(uploadRoot),
  rateLimitPer10Min = Number.parseInt(process.env.RATE_LIMIT_PER_10MIN ?? "20", 10),
  dailyExtractionLimit = Number.parseInt(process.env.DAILY_EXTRACTION_LIMIT ?? "200", 10),
  llmMaxConcurrency,
} = {}) {
  const app = express();
  const llmConfig = getLlmConfig();
  const configuredConcurrency = Number.parseInt(process.env.LLM_MAX_CONCURRENCY ?? "", 10);
  const maxConcurrency = Math.max(1, llmMaxConcurrency
    ?? (Number.isFinite(configuredConcurrency) ? configuredConcurrency : llmConfig.provider === "anthropic" ? 5 : 2));
  app.set("trust proxy", 1);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
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

  app.get("/api/activity", async (request, response, next) => {
    try {
      const requestedLimit = Number(request.query.limit ?? 10);
      const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(0, Math.floor(requestedLimit))) : 10;
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

<<<<<<< HEAD
  app.post("/api/applications", mutationRateLimit, needWrite, upload.array("files"), async (request, response, next) => {
=======
  app.post("/api/applications", needWrite, upload.array("files"), async (request, response, next) => {
  app.post("/api/applications", mutationRateLimit, upload.array("files"), async (request, response, next) => {
>>>>>>> 0e6f6573607d1183b13804e209616c31c3359a6b
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
      const documents = [];
      const stored = [];
      try {
        for (let index = 0; index < files.length; index++) {
          const file = files[index];
          await fileStorage.save(id, parsedTypes[index], file.buffer);
          stored.push(parsedTypes[index]);
          documents.push({
            document: parsedTypes[index],
            filename: path.basename(file.originalname),
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
        await audit(store, application, "application_processed", { mode: "mock" });
        return sendParsed(response, Application, application, 202);
      }

      application.status = "extracting";
      await store.save(application);
      await audit(store, application, "extraction_started");
<<<<<<< HEAD
      const fieldGroups = await mapWithConcurrency(application.documents, maxConcurrency, async (document) => {
        const { pages, method } = await fileStorage.withFile(
          application.id,
          document.document,
          (filePath) => readPdf(filePath),
        );
=======
      const fieldGroups = await Promise.all(application.documents.map(async (document) => {
        const { pages, method } = await fileStorage.withFile(application.id, document.document, (filePath) => readPdf(filePath));
      const fieldGroups = await mapWithConcurrency(application.documents, maxConcurrency, async (document) => {
        const filePath = path.join(uploadRoot, application.id, `${document.document}.pdf`);
        const { pages, method } = await readPdf(filePath);
>>>>>>> 0e6f6573607d1183b13804e209616c31c3359a6b
        document.pages = pages.length;
        document.method = method;
        return extractDocument({
          document: document.document,
          pages,
          method,
          provider: llmConfig.provider,
          model: llmConfig.model,
          onModelCall: reserveDailyModelCall,
        });
      });
      const allFields = fieldGroups.flat();
      application.fields = allFields;
      const uploaded = await uploadedDocuments(application, readPdf, fileStorage);
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
      return sendError(response, 400, "Each PDF must be 20 MB or smaller.");
    }
    console.error(error);
    return sendError(response, 500, "The request could not be completed.");
  });
  return app;
}

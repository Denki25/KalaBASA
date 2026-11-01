import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import test from "node:test";
import { Application } from "kalabasa-contract/schemas.js";
import { readPdfPages } from "../extraction/pdf.js";
import { readApplicationChecklist } from "./checklist.js";
import { createApp } from "./app.js";
import { MemoryStore } from "./store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixturePath = path.join(repoRoot, "contract", "fixtures", "set_05_demo_story.json");
const fixture = Application.parse(JSON.parse(await fs.readFile(fixturePath, "utf8")));
const cleanFixture = Application.parse(JSON.parse(await fs.readFile(
  path.join(repoRoot, "contract", "fixtures", "set_01_clean.json"),
  "utf8",
)));

async function withApi(callback, application = fixture, appOptions = {}) {
  const store = new MemoryStore(Array.isArray(application) ? application : [application]);
  const server = createServer(createApp({ store, mockMode: true, ...appOptions }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`, store);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("health endpoint reports the API and mock mode", async () => {
  await withApi(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, mock_mode: true });
  });
  await withApi(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.deepEqual(await response.json(), { ok: true, mock_mode: false });
  }, fixture, { mockMode: false });
});

test("request limiter caps POST create requests per IP and leaves GET routes unthrottled", async () => {
  await withApi(async (baseUrl) => {
    const first = await fetch(`${baseUrl}/api/applications`, { method: "POST" });
    assert.equal(first.status, 201);
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/applications`)).status, 200);

    const second = await fetch(`${baseUrl}/api/applications`, { method: "POST" });
    assert.equal(second.status, 429);
    assert.equal((await second.json()).error, "Too many requests. Please try again later.");
  }, fixture, { rateLimitPer10Min: 1 });
});

test("request limiter applies to process requests", async () => {
  await withApi(async (baseUrl) => {
    const url = `${baseUrl}/api/applications/${fixture.id}/process`;
    assert.equal((await fetch(url, { method: "POST" })).status, 202);
    const limited = await fetch(url, { method: "POST" });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error, "Too many requests. Please try again later.");
  }, fixture, { rateLimitPer10Min: 1 });
});

test("request limiter keeps separate IP buckets", async () => {
  await withApi(async (baseUrl) => {
    const first = await fetch(`${baseUrl}/api/applications`, {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    const secondIp = await fetch(`${baseUrl}/api/applications`, {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.11" },
    });
    assert.equal(first.status, 201);
    assert.equal(secondIp.status, 201);
  }, fixture, { rateLimitPer10Min: 1 });
});

test("daily extraction limit returns 429 without making an over-limit model call", async () => {
  const application = Application.parse({
    ...cleanFixture,
    id: "daily-extraction-limit-test",
    status: "uploaded",
    documents: cleanFixture.documents.slice(0, 2),
    fields: [],
    findings: [],
  });
  let modelCalls = 0;
  const options = {
    mockMode: false,
    dailyExtractionLimit: 1,
    readPdf: async () => ({ pages: ["test document contents"], method: "text_layer" }),
    extractDocument: async ({ onModelCall }) => {
      await onModelCall();
      modelCalls += 1;
      return [];
    },
  };
  await withApi(async (baseUrl, store) => {
    const response = await fetch(`${baseUrl}/api/applications/${application.id}/process`, { method: "POST" });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error, "Daily extraction limit reached");
    assert.equal(modelCalls, 1);
    assert.equal((await store.get(application.id)).status, "uploaded");
  }, application, options);
});

test("processing rejects applications already extracting or with a final decision", async () => {
  const applications = ["extracting", "approved", "returned"].map((status) =>
    Application.parse({ ...fixture, id: `cannot-process-${status}`, status }));
  await withApi(async (baseUrl, store) => {
    for (const application of applications) {
      const response = await fetch(`${baseUrl}/api/applications/${application.id}/process`, { method: "POST" });
      assert.equal(response.status, 409, application.status);
      assert.equal((await store.get(application.id)).status, application.status);
    }
  }, applications, { mockMode: false });
});

test("finding updates and final decisions require ready_for_review state", async () => {
  const application = Application.parse({ ...fixture, id: "uploaded-state-is-not-reviewable", status: "uploaded" });
  await withApi(async (baseUrl, store) => {
    const baseUrlForApp = `${baseUrl}/api/applications/${application.id}`;
    const update = await fetch(`${baseUrlForApp}/findings/${application.findings[0].finding_id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "confirmed" }),
    });
    assert.equal(update.status, 409);
    for (const outcome of ["approve", "return"]) {
      assert.equal((await fetch(`${baseUrlForApp}/${outcome}`, { method: "POST" })).status, 409, outcome);
    }
    assert.equal((await store.get(application.id)).status, "uploaded");
  }, application);
});

test("upload rejects files larger than 20 MB with a clear 400", async () => {
  await withApi(async (baseUrl) => {
    const form = new FormData();
    form.append("files", new Blob([Buffer.alloc(20 * 1024 * 1024 + 1)], { type: "application/pdf" }), "oversized.pdf");
    const response = await fetch(`${baseUrl}/api/applications`, { method: "POST", body: form });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "Each PDF must be 20 MB or smaller.");
  });
});

test("upload rejects non-PDF content even when the client names it as a PDF", async () => {
  await withApi(async (baseUrl) => {
    const form = new FormData();
    form.append("files", new Blob(["not a PDF"], { type: "application/pdf" }), "fake.pdf");
    form.append("document_types[]", "application_form");
    const response = await fetch(`${baseUrl}/api/applications`, { method: "POST", body: form });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "Every uploaded document must be a PDF.");
  }, fixture, { mockMode: false });
});

test("upload rejects more than the five supported document files", async () => {
  await withApi(async (baseUrl) => {
    const form = new FormData();
    for (let index = 0; index < 6; index++) {
      form.append("files", new Blob(["%PDF-1.4"], { type: "application/pdf" }), `${index}.pdf`);
    }
    const response = await fetch(`${baseUrl}/api/applications`, { method: "POST", body: form });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /no more than 5 PDFs/i);
  }, fixture, { mockMode: false });
});

test("processing extracts documents in parallel in document order and can retry after failure", async () => {
  const application = Application.parse({
    ...cleanFixture,
    id: "app-parallel-retry-test",
    status: "uploaded",
    documents: cleanFixture.documents.slice(0, 2),
    fields: [],
    findings: [],
  });
  let activeExtractions = 0;
  let maxConcurrentExtractions = 0;
  let failOnce = true;
  const appOptions = {
    mockMode: false,
    readPdf: async (filePath) => ({
      pages: [path.basename(filePath).startsWith("application_form") ? "[ ] DTI Certificate" : "DTI certificate"],
      method: "text_layer",
    }),
    extractDocument: async ({ document }) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("Temporary extraction failure.");
      }
      activeExtractions += 1;
      maxConcurrentExtractions = Math.max(maxConcurrentExtractions, activeExtractions);
      await new Promise((resolve) => setTimeout(resolve, document === "application_form" ? 35 : 10));
      activeExtractions -= 1;
      return cleanFixture.fields.filter((field) => field.document === document).slice(0, 1);
    },
  };

  await withApi(async (baseUrl, store) => {
    const processUrl = `${baseUrl}/api/applications/${application.id}/process`;
    const failed = await fetch(processUrl, { method: "POST" });
    assert.equal(failed.status, 500);
    assert.equal((await failed.json()).error, "Extraction failed. Please retry; if it continues, contact support.");
    assert.equal((await store.get(application.id)).status, "uploaded");
    await new Promise((resolve) => setTimeout(resolve, 25));

    const retried = await fetch(processUrl, { method: "POST" });
    assert.equal(retried.status, 202);
    const processed = await retried.json();
    assert.equal(processed.status, "ready_for_review");
    assert.equal(maxConcurrentExtractions, 2);
    assert.deepEqual(processed.fields.map((field) => field.document), ["application_form", "dti_certificate"]);
  }, application, appOptions);
});

test("processing limits extraction concurrency and returns provider/model headers", async () => {
  const application = Application.parse({
    ...cleanFixture,
    id: "bounded-concurrency-test",
    status: "uploaded",
    documents: cleanFixture.documents.slice(0, 4),
    fields: [],
    findings: [],
  });
  let active = 0;
  let maxActive = 0;
  const options = {
    mockMode: false,
    llmMaxConcurrency: 2,
    readPdf: async () => ({ pages: ["fake document"], method: "text_layer" }),
    extractDocument: async ({ document }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return cleanFixture.fields.filter((field) => field.document === document);
    },
  };
  await withApi(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/applications/${application.id}/process`, { method: "POST" });
    assert.equal(response.status, 202);
    assert.equal(maxActive, 2);
    assert.equal(response.headers.get("x-llm-provider"), process.env.LLM_PROVIDER || "anthropic");
    assert.ok(response.headers.get("x-llm-model"));
    const processed = await response.json();
    assert.deepEqual([...new Set(processed.fields.map((field) => field.document))], application.documents.map((item) => item.document));
  }, application, options);
});

test("application list returns validated summaries and open finding counts", async () => {
  await withApi(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/applications`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{
      id: fixture.id,
      label: fixture.label,
      status: fixture.status,
      created_at: fixture.created_at,
      open_findings: fixture.findings.filter((finding) => ["open", "escalated"].includes(finding.status)).length,
      total_findings: fixture.findings.length,
    }]);
  });
});

test("activity endpoint maps audit actions to plain text, newest first", async () => {
  await withApi(async (baseUrl, store) => {
    const mappings = [
      ["application_created", {}, "New application received"],
      ["extraction_completed", { findings: 2 }, "Inconsistency flagged"],
      ["extraction_completed", { findings: 0 }, "Application processed"],
      ["application_processed", {}, "Application processed"],
      ["finding_updated", {}, "Finding reviewed"],
      ["application_approved", {}, "Application approved"],
      ["application_returned", {}, "Application returned for correction"],
    ];
    for (let index = 0; index < mappings.length; index += 1) {
      const [action, details] = mappings[index];
      await store.audit({
        application_id: fixture.id,
        action,
        details,
        actor: "reviewer",
        timestamp: new Date(Date.now() + index * 1000).toISOString(),
      });
    }
    const response = await fetch(`${baseUrl}/api/activity?limit=10`);
    assert.equal(response.status, 200);
    const activity = await response.json();
    assert.deepEqual(activity.map((item) => item.text), mappings.map(([, , text]) => text).reverse());
    assert.equal(activity[0].application_id, fixture.id);
    assert.ok(Date.parse(activity[0].timestamp) > Date.parse(activity.at(-1).timestamp));
  });
});

test("stats count pending, processed today, and flagged applications", async () => {
  const approved = Application.parse({ ...cleanFixture, id: "approved-today", status: "approved" });
  const returned = Application.parse({ ...cleanFixture, id: "returned-today", status: "returned" });
  await withApi(async (baseUrl, store) => {
    const now = new Date().toISOString();
    await store.audit({ application_id: approved.id, action: "application_approved", details: {}, actor: "reviewer", timestamp: now });
    await store.audit({ application_id: returned.id, action: "application_returned", details: {}, actor: "reviewer", timestamp: now });
    const response = await fetch(`${baseUrl}/api/stats`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { pending: 2, processed_today: 2, flagged: 1 });
  }, [fixture, cleanFixture, approved, returned]);
});

test("requirements and fixture application responses are contract-valid", async () => {
  await withApi(async (baseUrl) => {
    const requirements = await fetch(`${baseUrl}/api/lgus/bagong-dalisay-demo/requirements`);
    assert.equal(requirements.status, 200);
    assert.equal((await requirements.json()).required_documents.length, 5);

    const response = await fetch(`${baseUrl}/api/applications/${fixture.id}`);
    assert.equal(response.status, 200);
    const application = await response.json();
    assert.equal(application.id, fixture.id);
    assert.equal(application.findings.length, 2);
  });
});

test("reviewer updates are audited and decision endpoints enforce nextOutcome", async () => {
  await withApi(async (baseUrl, store) => {
    const url = `${baseUrl}/api/applications/${fixture.id}`;
    const finding = fixture.findings[0];
    const update = await fetch(`${url}/findings/${finding.finding_id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "dismissed", reviewer_note: "Reviewed evidence." }),
    });
    assert.equal(update.status, 200);
    const updated = await update.json();
    assert.equal(updated.status, "dismissed");
    assert.equal(updated.reviewer_note, "Reviewed evidence.");
    assert.ok(updated.decided_at);

    const locked = await fetch(`${url}/approve`, { method: "POST" });
    assert.equal(locked.status, 409);

    const second = fixture.findings[1];
    const confirmed = await fetch(`${url}/findings/${second.finding_id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "confirmed" }),
    });
    assert.equal(confirmed.status, 200);

    const stillLocked = await fetch(`${url}/approve`, { method: "POST" });
    assert.equal(stillLocked.status, 409);
    const returned = await fetch(`${url}/return`, { method: "POST" });
    assert.equal(returned.status, 200);
    assert.equal((await returned.json()).status, "returned");
    assert.equal(store.auditLog.length, 3);
    assert.ok(store.auditLog.every((entry) => Number.isFinite(Date.parse(entry.timestamp))));
  });
});

test("dismissed and escalated findings require a non-empty reviewer note", async () => {
  await withApi(async (baseUrl) => {
    const url = `${baseUrl}/api/applications/${fixture.id}/findings/${fixture.findings[0].finding_id}`;
    for (const status of ["dismissed", "escalated"]) {
      for (const reviewer_note of [undefined, "", "   "]) {
        const response = await fetch(url, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status, reviewer_note }),
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /reviewer note is required/i);
      }
    }
    const confirmed = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "confirmed" }),
    });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).reviewer_note, null);
  });
});

test("final decisions lock finding updates and all later approve or return attempts", async () => {
  const approved = Application.parse({ ...fixture, id: "approved-final-lock", status: "approved" });
  const returned = Application.parse({ ...fixture, id: "returned-final-lock", status: "returned" });
  await withApi(async (baseUrl) => {
    for (const application of [approved, returned]) {
      const base = `${baseUrl}/api/applications/${application.id}`;
      const update = await fetch(`${base}/findings/${application.findings[0].finding_id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "confirmed" }),
      });
      assert.equal(update.status, 409);
      for (const outcome of ["approve", "return"]) {
        const response = await fetch(`${base}/${outcome}`, { method: "POST" });
        assert.equal(response.status, 409);
        assert.match((await response.json()).error, /final decision|ready for review/i);
      }
    }
  }, [approved, returned]);
});

test("Approve is available only when no finding blocks the outcome", async () => {
  await withApi(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/applications/${cleanFixture.id}/approve`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "approved");
  }, cleanFixture);
});

test("mock application creation and process return fixture data without extraction", async () => {
  const empty = { ...fixture, id: "unused" };
  await withApi(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/applications`, { method: "POST" });
    assert.equal(created.status, 201);
    const { id } = await created.json();
    assert.equal(id, fixture.id);
    const processed = await fetch(`${baseUrl}/api/applications/${id}/process`, { method: "POST" });
    assert.equal(processed.status, 202);
    assert.equal((await processed.json()).findings.length, 2);
    const invalid = await fetch(`${baseUrl}/api/applications/${id}/findings/nope`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "invented" }),
    });
    assert.equal(invalid.status, 400);
    const notFound = await fetch(`${baseUrl}/api/unknown`);
    assert.equal(notFound.status, 404);
  }, empty);
});

test("application checklist parser captures checked missing document evidence", async () => {
  const appForm = path.join(repoRoot, "samples", "set_03_missing_document", "application_form.pdf");
  const { pages } = await readPdfPages(appForm);
  const rows = readApplicationChecklist(pages);
  const clearance = rows.find((row) => row.document === "barangay_clearance");
  assert.ok(clearance);
  assert.equal(clearance.checked, true);
  assert.equal(clearance.page, 2);
  assert.match(clearance.source_text, /Barangay Business Clearance/i);
});

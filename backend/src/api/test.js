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

async function withApi(callback, application = fixture) {
  const store = new MemoryStore([application]);
  const server = createServer(createApp({ store, mockMode: true }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`, store);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

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
    const notFound = await fetch(`${baseUrl}/unknown`);
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

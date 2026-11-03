import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildReport } from "./reports.js";
import { MemoryStore } from "./store.js";

const fixture = JSON.parse(await readFile(new URL("../../../contract/fixtures/set_01_clean.json", import.meta.url), "utf8"));
const finding = { finding_id: "test-finding", type: "missing_field", severity: "high", rule_id: "R-TEST", field: "owner_name", message: "Test finding", evidence: [{ document: "application_form", page: 1, source_text: null }], status: "confirmed", reviewer_note: null, decided_at: null };
const apps = [
  { ...structuredClone(fixture), id: "a", lgu_id: "north", label: "private label", status: "approved", created_at: "2026-01-02T10:00:00.000Z", documents: [{ ...fixture.documents[0], method: "ocr" }], findings: [finding] },
  { ...structuredClone(fixture), id: "b", lgu_id: "south", label: "other", status: "ready_for_review", created_at: "2026-01-03T10:00:00.000Z", findings: [{ ...finding, finding_id: "test-finding-2", type: "missing_document", severity: "medium", status: "open" }] },
];

test("report calculates status, document, finding and date aggregates without personal labels", async () => {
  const store = new MemoryStore(apps);
  const snapshot = await store.reportSnapshot("north");
  const report = buildReport(snapshot, { from: "2026-01-02T00:00:00.000Z", to: "2026-01-02T23:59:59.999Z" });
  assert.equal(report.application_total, 1);
  assert.equal(report.applications_by_status.approved, 1);
  assert.equal(report.documents_total, 1);
  assert.equal(report.documents_by_method.ocr, 1);
  assert.equal(report.findings_total, 1);
  assert.equal(report.findings_by_status.confirmed, 1);
  assert.equal(report.findings_by_type.missing_field, 1);
  assert.equal(report.findings_by_severity.high, 1);
  assert.equal("label" in report.applications[0], false);
});

test("report snapshot enforces LGU scope unless explicit cross-LGU access is selected", async () => {
  const store = new MemoryStore(apps);
  assert.deepEqual((await store.reportSnapshot("north")).applications.map((item) => item.id), ["a"]);
  assert.equal((await store.reportSnapshot("north", true)).applications.length, 2);
});

test("report handles empty data and rejects invalid date ranges", () => {
  const empty = buildReport({ applications: [], audit: [] }, {});
  assert.equal(empty.application_total, 0);
  assert.deepEqual(empty.trend, []);
  assert.throws(() => buildReport({ applications: [] }, { from: "not-a-date" }), /valid reporting date range/);
});

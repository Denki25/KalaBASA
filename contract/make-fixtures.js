// Builds fake API responses from the sample data so the frontend can start at hour 2.
// Usage: node make-fixtures.js [path-to-kalabasa_sample_data]
import fs from "node:fs";
import path from "node:path";
import { Application } from "./schemas.js";

const root = process.argv[2] || "../kalabasa_sample_data";
fs.mkdirSync("fixtures", { recursive: true });
for (const dir of fs.readdirSync(root).filter((d) => d.startsWith("set_")).sort()) {
  const exp = JSON.parse(fs.readFileSync(path.join(root, dir, "expected.json"), "utf8"));
  const pagesOf = (doc) => Math.max(...exp.extracted_fields.filter((f) => f.document === doc).map((f) => f.page));
  const app = Application.parse({
    id: `app-${exp.set_id}`, lgu_id: "bagong-dalisay-demo", label: exp.scenario, status: "ready_for_review",
    created_at: "2026-10-19T09:00:00.000Z",
    documents: exp.uploaded_documents.map((d) => ({ document: d, filename: `${d}.pdf`, pages: pagesOf(d), method: "text_layer" })),
    fields: exp.extracted_fields.map((f) => ({ ...f, confidence: "high", verified: true, match: "exact", method: "text_layer" })),
    findings: exp.expected_findings,
  });
  fs.writeFileSync(`fixtures/${exp.set_id}.json`, JSON.stringify(app, null, 2));
  console.log("wrote fixtures/" + exp.set_id + ".json", `(${app.fields.length} fields, ${app.findings.length} findings)`);
}

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ExtractedField, ExtractedFieldCore, Evidence, FindingCore, Application, nextOutcome } from "./schemas.js";
import { verifyField, buildPrompt } from "./extraction.js";

const root = process.argv[2] || "../kalabasa_sample_data";
let n = 0;
for (const dir of fs.readdirSync(root).filter((d) => d.startsWith("set_"))) {
  const exp = JSON.parse(fs.readFileSync(path.join(root, dir, "expected.json"), "utf8"));
  exp.extracted_fields.forEach((f) => { ExtractedFieldCore.parse(f); n++; });
  exp.expected_findings.forEach((f) => { FindingCore.parse(f); n++; });
}
console.log(`ok: ${n} ground-truth items match the contract`);

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
for (const name of fs.readdirSync(fixtureRoot).filter((file) => file.endsWith(".json"))) {
  const fixture = Application.parse(JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), "utf8")));
  assert.ok(fixture.fields.every((field) => field.presence), `${name} fields include presence`);
}
console.log("ok: fixtures include presence metadata");

// verifyField
const pages = ["Business name   Aquino Laundry Hub\nBusiness address   Unit 3, Aquino Building,\n22 Del Pilar Street"];
assert.deepEqual(verifyField({ field: "business_name", value: "Aquino Laundry Hub", source_text: "Aquino Laundry Hub", page: 1 }, pages), { verified: true, match: "exact" });
assert.equal(verifyField({ field: "business_name", value: "Aquino Laundry Hub", source_text: "Aquino Laundry Hubb", page: 1 }, pages).verified, false);
assert.equal(verifyField({ field: "business_address", value: "Unit 3, Aquino Building, 22 Del Pilar Street", source_text: "Unit 3, Aquino Building, 22 Del Pilar Street", page: 1 }, pages).verified, true);
assert.equal(verifyField({ field: "notarization_date", value: null, source_text: null, page: 1 }, pages).verified, true);
// a made-up value that is not in the source text must fail
assert.equal(verifyField({ field: "business_name", value: "Other Name", source_text: "Aquino Laundry Hub", page: 1 }, pages).verified, false);
console.log("ok: verifyField");

ExtractedField.parse({
  field: "notarization_date",
  value: null,
  document: "lease_contract",
  page: 3,
  source_text: null,
  presence: "not_found",
  confidence: "low",
  verified: true,
  match: "none",
  method: "text_layer",
});
Evidence.parse({
  document: "lease_contract",
  page: 3,
  source_text: null,
  note: "No notarization date was found in the lease.",
});
console.log("ok: absence evidence");

// nextOutcome
const mk = (...s) => ({ findings: s.map((status) => ({ status })) });
assert.equal(nextOutcome(mk()), "approve");
assert.equal(nextOutcome(mk("dismissed")), "approve");
assert.equal(nextOutcome(mk("dismissed", "open")), "locked");
assert.equal(nextOutcome(mk("confirmed", "escalated")), "locked");
assert.equal(nextOutcome(mk("confirmed", "dismissed")), "return");
console.log("ok: nextOutcome");

const p = buildPrompt("lease_contract", ["page one", "page two"]);
assert.ok(p.user.includes("notarization_date") && p.user.includes("=== PAGE 2 ==="));
console.log("ok: buildPrompt");

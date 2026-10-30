import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { ExtractedFieldCore, FindingCore, Application, nextOutcome } from "./schemas.js";
import { verifyField, buildPrompt } from "./extraction.js";

const root = process.argv[2] || "../kalabasa_sample_data";
let n = 0;
for (const dir of fs.readdirSync(root).filter((d) => d.startsWith("set_"))) {
  const exp = JSON.parse(fs.readFileSync(path.join(root, dir, "expected.json"), "utf8"));
  exp.extracted_fields.forEach((f) => { ExtractedFieldCore.parse(f); n++; });
  exp.expected_findings.forEach((f) => { FindingCore.parse(f); n++; });
}
console.log(`ok: ${n} ground-truth items match the contract`);

// verifyField
const pages = ["Business name   Aquino Laundry Hub\nBusiness address   Unit 3, Aquino Building,\n22 Del Pilar Street"];
assert.deepEqual(verifyField({ field: "business_name", value: "Aquino Laundry Hub", source_text: "Aquino Laundry Hub", page: 1 }, pages), { verified: true, match: "exact" });
assert.equal(verifyField({ field: "business_name", value: "Aquino Laundry Hub", source_text: "Aquino Laundry Hubb", page: 1 }, pages).verified, false);
assert.equal(verifyField({ field: "business_address", value: "Unit 3, Aquino Building, 22 Del Pilar Street", source_text: "Unit 3, Aquino Building, 22 Del Pilar Street", page: 1 }, pages).verified, true);
assert.equal(verifyField({ field: "notarization_date", value: null, source_text: null, page: 1 }, pages).verified, true);
// a made-up value that is not in the source text must fail
assert.equal(verifyField({ field: "business_name", value: "Other Name", source_text: "Aquino Laundry Hub", page: 1 }, pages).verified, false);
console.log("ok: verifyField");

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

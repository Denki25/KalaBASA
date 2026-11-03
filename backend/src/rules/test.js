import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import requirements from "../../../samples/lgu_requirements.json" with { type: "json" };
import { checkRequiredFields, checkRequirements, compareAcrossDocuments, checkValidity, parseDocumentDate, reviewDate } from "./index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const samplesRoot = path.join(repoRoot, "samples");
const expectedCounts = new Map([
  ["set_01_clean", 0],
  ["set_02_address_mismatch", 1],
  ["set_03_missing_document", 1],
  ["set_04_formatting_only", 0],
  ["set_05_demo_story", 2],
]);
const expectedFields = {
  set_02_address_mismatch: ["business_address"],
  set_03_missing_document: ["barangay_clearance"],
  set_05_demo_story: ["business_address", "notarization_date"],
};

function uploadedWithChecklist(expected) {
  return expected.uploaded_documents.map((document) => {
    if (document !== "application_form") return document;
    const checklist = expected.expected_findings
      .filter((finding) => finding.type === "missing_document")
      .map((finding) => ({
        checked: true,
        ...finding.evidence[0],
        document: finding.field,
      }));
    return { document, checklist };
  });
}

for (const [setName, expectedCount] of expectedCounts) {
  const directory = path.join(samplesRoot, setName);
  const expected = JSON.parse(await fs.readFile(path.join(directory, "expected.json"), "utf8"));
  const uploaded = uploadedWithChecklist(expected);
  const actual = [
    ...checkRequirements(uploaded, requirements),
    ...checkRequiredFields(expected.extracted_fields, requirements),
    ...compareAcrossDocuments(expected.extracted_fields, requirements),
  ];
  assert.equal(actual.length, expectedCount, `${setName} findings: ${JSON.stringify(actual.map((finding) => ({ field: finding.field, evidence: finding.evidence })))}`);

  const expectedSet = expected.expected_findings;
  for (const finding of expectedSet) {
    const actualFinding = actual.find((item) => item.type === finding.type && item.field === finding.field);
    assert.ok(actualFinding, `${setName} missing expected ${finding.type}:${finding.field}`);
    assert.equal(actualFinding.rule_id, finding.rule_id, `${setName} ${finding.field} rule`);
    assert.equal(actualFinding.evidence.length, finding.evidence.length, `${setName} ${finding.field} evidence count`);
    for (let index = 0; index < finding.evidence.length; index++) {
      const actualEvidence = actualFinding.evidence[index];
      const expectedEvidence = finding.evidence[index];
      assert.equal(actualEvidence.document, expectedEvidence.document);
      assert.equal(actualEvidence.page, expectedEvidence.page);
      assert.ok(expectedEvidence.source_text.includes(actualEvidence.source_text)
        || actualEvidence.source_text.includes(expectedEvidence.source_text),
      `${setName} ${finding.field} evidence source`);
    }
  }
  for (const finding of actual) {
    assert.ok(finding.evidence.length > 0, `${setName} ${finding.field} has evidence`);
    for (const evidence of finding.evidence) {
      assert.equal(typeof evidence.source_text, "string");
      assert.ok(evidence.source_text.length > 0);
    }
  }
  if (expectedFields[setName]) {
    assert.deepEqual(actual.map((finding) => finding.field).sort(), expectedFields[setName].sort());
  }

  console.log(`PASS ${setName}: ${actual.length} finding(s)`);
}

const formattingAddress = [
  "Blk 7 Lot 12 Sampaguita St., Brgy. Sto. Cristo, Bagong Dalisay City, Pampanga 2000",
  "Block 7, Lot 12, Sampaguita Street, Barangay Santo Cristo, City of Bagong Dalisay, Pampanga",
];
const formattingFields = formattingAddress.map((value, index) => ({
  field: "business_address",
  value,
  document: index === 0 ? "application_form" : "lease_contract",
  page: 1,
  source_text: value,
}));
assert.equal(compareAcrossDocuments(formattingFields, requirements).length, 0, "normalization variants should match");

const numberFields = formattingFields.map((field, index) => ({
  ...field,
  value: index === 0 ? "45 MacArthur Highway" : "54 MacArthur Highway",
  source_text: index === 0 ? "45 MacArthur Highway" : "54 MacArthur Highway",
}));
assert.equal(compareAcrossDocuments(numberFields, requirements).length, 1, "different house numbers must mismatch");

const ownerAddressFields = [
  { field: "owner_residence_address", value: "10 Luna St", document: "application_form", page: 1, source_text: "10 Luna St" },
  { field: "owner_residence_address", value: "11 Luna St", document: "community_tax_certificate", page: 1, source_text: "11 Luna St" },
];
assert.equal(compareAcrossDocuments(ownerAddressFields, requirements).length, 0, "owner residence must not be compared");

const ownerNames = (secondName) => [
  { field: "owner_name", value: "Juan Carlos P. Dela Cruz", document: "application_form", page: 1, source_text: "Juan Carlos P. Dela Cruz" },
  { field: "owner_name", value: secondName, document: "dti_certificate", page: 1, source_text: secondName },
];
assert.equal(compareAcrossDocuments(ownerNames("Dela Cruz, Juan Carlos"), requirements).length, 0, "missing middle initial and surname-first form are harmless");
assert.equal(compareAcrossDocuments(ownerNames("Juan Carlos R. Dela Cruz"), requirements).length, 1, "different middle initials mismatch");
assert.equal(compareAcrossDocuments([
  { document: "application_form", field: "business_name", value: "Santos Bakery", page: 1, source_text: "Santos Bakery" },
  { document: "dti_certificate", field: "business_name", value: "Reyes Laundry", page: 1, source_text: "Reyes Laundry" },
], requirements).length, 1, "a DTI certificate for another business must be flagged");

const missingChecklist = [
  { document: "application_form", checklist: [{
    document: "barangay_clearance",
    checked: false,
    page: 2,
    source_text: "[ ] Barangay Business Clearance",
  }] },
  "dti_certificate",
  "lease_contract",
  "community_tax_certificate",
];
const checklistFinding = checkRequirements(missingChecklist, requirements)[0];
assert.match(checklistFinding.message, /does not mark it as attached/);
const noFormFindings = checkRequirements([], requirements);
assert.equal(noFormFindings.length, requirements.required_documents.length, "missing documents remain reportable without an application form");
assert.equal(noFormFindings[0].evidence[0].source_text, null);
assert.ok(noFormFindings[0].evidence[0].note);

const notFoundFinding = checkRequiredFields([{
  document: "lease_contract",
  field: "notarization_date",
  value: null,
  page: 3,
  source_text: null,
  presence: "not_found",
}], requirements)[0];
assert.equal(notFoundFinding.evidence[0].source_text, null);
assert.match(notFoundFinding.evidence[0].note, /No notarization date was found/);

const omittedFieldFinding = checkRequiredFields([
    { document: "lease_contract", field: "lease_start", value: "October 1, 2026", page: 1, source_text: "October 1, 2026" },
], requirements).find((finding) => finding.field === "notarization_date");
assert.ok(omittedFieldFinding, "an omitted required extraction from an uploaded document must be reported");
assert.equal(omittedFieldFinding.evidence[0].source_text, null);

console.log("PASS address/name/TIN normalization, exact numbers, checklist messaging, and do-not-compare rules");

assert.equal(parseDocumentDate("2028-02-29"), "2028-02-29");
assert.equal(parseDocumentDate("February 29, 2027"), null);
assert.equal(parseDocumentDate("2026-13-01"), null);
assert.equal(parseDocumentDate("04/05/2026"), null);
assert.equal(parseDocumentDate("5 Apr 2027"), "2027-04-05");
assert.equal(reviewDate(new Date("2026-11-03T17:00:00Z")), "2026-11-04");
const validityFields = (end, start = "2026-01-01") => [
  { document: "barangay_clearance", field: "valid_until", value: end, page: 1, source_text: end, verified: true },
  { document: "barangay_clearance", field: "issue_date", value: start, page: 1, source_text: start, verified: true },
];
const dateChecks = (fields, docs = ["barangay_clearance"]) => checkValidity(fields, docs, requirements, "2026-11-04");
assert.equal(dateChecks(validityFields("2026-11-04")).length, 0, "expiry date is inclusive");
assert.match(dateChecks(validityFields("2026-11-03"))[0].message, /validity ended/);
assert.match(dateChecks(validityFields("2027-12-31", "2026-11-05"))[0].message, /after the review date/);
assert.match(dateChecks(validityFields("2026-01-01", "2026-02-01"))[0].message, /start date is later/);
for (const invalid of [null, "04/05/2026", "2026-02-30", "unknown"]) {
  assert.equal(dateChecks(validityFields(invalid)).length, 1);
}
assert.equal(dateChecks(validityFields("2027-12-31").map((f) => ({ ...f, verified: false }))).length, 1);
assert.equal(dateChecks([], []).length, 0, "absent documents are handled by completeness checks");
assert.equal(dateChecks([])[0].evidence[0].source_text, null);
console.log("PASS validity dates, ambiguity, evidence, expiry boundary, and review timezone");

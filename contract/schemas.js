// KalaBASA data contract. Frontend, backend and extraction all import from here.
// Change this file only with all four people agreeing.
import { z } from "zod";

// ---------- Documents and fields ----------
export const DOCUMENT_TYPES = [
  "application_form",
  "dti_certificate",
  "barangay_clearance",
  "lease_contract",
  "community_tax_certificate",
];
export const DocumentType = z.enum(DOCUMENT_TYPES);

// Which fields we extract from which document.
// In lease_contract: owner_name = the LESSEE, business_address = the leased premises.
export const FIELDS_BY_DOCUMENT = {
  application_form: ["owner_name", "tin", "owner_residence_address", "business_name", "nature_of_business", "business_address", "capital_investment", "application_date"],
  dti_certificate: ["dti_registration_no", "owner_name", "business_name", "business_address", "registration_date", "expiry_date"],
  barangay_clearance: ["clearance_no", "business_name", "owner_name", "business_address", "issue_date", "valid_until"],
  lease_contract: ["lessor_name", "owner_name", "business_address", "lease_start", "lease_end", "monthly_rent", "execution_date", "notarization_date", "notary_name"],
  community_tax_certificate: ["ctc_no", "owner_name", "tin", "owner_residence_address", "issue_date"],
};
export const FIELD_NAMES = [...new Set(Object.values(FIELDS_BY_DOCUMENT).flat())];
export const FieldName = z.enum(FIELD_NAMES);

// For these, `value` is read out of a sentence ("24th day of September, 2026" -> "September 24, 2026"),
// so the value will not appear verbatim inside source_text. Everything else must.
export const DERIVED_VALUE_FIELDS = ["execution_date", "notarization_date"];

// ---------- One extracted field ----------
// This core shape is exactly what expected.json in the sample data uses.
export const ExtractedFieldCore = z.object({
  field: FieldName,
  value: z.string().nullable(),          // null = absent or left blank. Never guessed.
  document: DocumentType,
  page: z.number().int().min(1),
  source_text: z.string().nullable(),    // exact snippet as printed on that page
});
// What the API returns: core + extraction metadata. `verified` and `match` are set by CODE, never by the LLM.
export const ExtractedField = ExtractedFieldCore.extend({
  confidence: z.enum(["high", "medium", "low"]),   // LLM's own estimate
  verified: z.boolean(),                           // source_text really found on that page
  match: z.enum(["exact", "loose", "none"]),
  method: z.enum(["text_layer", "ocr"]),
});

// ---------- One finding ----------
export const FINDING_TYPES = ["missing_document", "missing_field", "cross_document_mismatch"];
export const Evidence = z.object({
  document: DocumentType,
  page: z.number().int().min(1),
  source_text: z.string(),
});
export const FindingCore = z.object({
  finding_id: z.string(),
  type: z.enum(FINDING_TYPES),
  severity: z.enum(["high", "medium", "low"]),
  rule_id: z.string(),                   // e.g. R-XDOC-ADDRESS, matches lgu_requirements.json
  field: z.string(),                     // field name, or a document type for missing_document
  message: z.string(),                   // plain-language reason shown to the reviewer
  evidence: z.array(Evidence).min(1),    // every finding must point at a source
});
export const FINDING_STATUSES = ["open", "confirmed", "dismissed", "escalated"];
export const Finding = FindingCore.extend({
  status: z.enum(FINDING_STATUSES).default("open"),
  reviewer_note: z.string().nullable().default(null),
  decided_at: z.string().nullable().default(null),     // ISO timestamp
});

// ---------- One application ----------
export const APPLICATION_STATUSES = ["uploaded", "extracting", "ready_for_review", "approved", "returned"];
export const Application = z.object({
  id: z.string(),
  lgu_id: z.string(),
  label: z.string(),
  status: z.enum(APPLICATION_STATUSES),
  created_at: z.string(),
  documents: z.array(z.object({
    document: DocumentType,
    filename: z.string(),
    pages: z.number().int().min(1),
    method: z.enum(["text_layer", "ocr"]),
  })),
  fields: z.array(ExtractedField),
  findings: z.array(Finding),
});

// ---------- Approve locking (ASSUMPTION: confirm with the team) ----------
// "locked"  : at least one finding is still open or escalated -> reviewer cannot finish yet
// "return"  : no open/escalated, at least one finding CONFIRMED as a real issue -> return for correction
// "approve" : every finding dismissed (or there are none) -> Approve button unlocks
export function nextOutcome(app) {
  const s = app.findings.map((f) => f.status);
  if (s.some((x) => x === "open" || x === "escalated")) return "locked";
  if (s.some((x) => x === "confirmed")) return "return";
  return "approve";
}

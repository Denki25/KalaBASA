import { FindingCore } from "kalabasa-contract/schemas.js";

const blank = (value) => value == null || (typeof value === "string" && value.trim() === "");
const documentName = (item) => typeof item === "string" ? item : item.document;
const severityOrDefault = (severity) => ["high", "medium", "low"].includes(severity) ? severity : "medium";

function makeFinding(finding) {
  return FindingCore.parse(finding);
}

function checklistEntry(uploadedDocs, document) {
  const application = uploadedDocs.find((item) => documentName(item) === "application_form");
  return application && typeof application === "object"
    ? (application.checklist ?? []).find((item) => item.document === document)
    : undefined;
}

export function checkRequirements(uploadedDocs, requirements) {
  const uploaded = new Set(uploadedDocs.map(documentName));
  const findings = [];

  for (const rule of requirements.required_documents.filter((item) => item.required)) {
    if (uploaded.has(rule.document)) continue;
    const checklist = checklistEntry(uploadedDocs, rule.document);
    const hasChecklistEvidence = checklist?.source_text?.trim()
      && Number.isInteger(checklist.page)
      && checklist.page > 0;

    findings.push(makeFinding({
      finding_id: `${rule.rule_id}-${rule.document}`,
      type: "missing_document",
      severity: "high",
      rule_id: rule.rule_id,
      field: rule.document,
      message: !hasChecklistEvidence
        ? `${rule.label} is required but was not uploaded. No application-form checklist was available to confirm whether it was marked as attached.`
        : checklist.checked
        ? `${rule.label} is required but was not uploaded. The application form's requirements checklist marks it as attached.`
        : `${rule.label} is required but was not uploaded. The application form's requirements checklist does not mark it as attached.`,
      evidence: hasChecklistEvidence
        ? [{
          document: "application_form",
          page: checklist.page,
          source_text: checklist.source_text,
        }]
        : [{
          document: rule.document,
          page: 1,
          source_text: null,
          note: `${rule.label} was not uploaded; no source page is available.`,
        }],
    }));
  }

  return findings;
}

export function checkRequiredFields(fields, requirements) {
  const findings = [];

  for (const rule of requirements.required_fields) {
    const field = fields.find((item) => item.document === rule.document && item.field === rule.field);
    const documentFields = fields.filter((item) => item.document === rule.document);
    if (!field) {
      if (documentFields.length === 0) continue;
    }
    if (field && !blank(field.value)) continue;
    const page = field?.page ?? documentFields[0]?.page ?? 1;
    const sourceText = field?.source_text?.trim() ? field.source_text : null;
    const presence = field?.presence
      ?? (field?.value != null ? "printed" : sourceText ? "blank_printed" : "not_found");
    const note = sourceText
      ? undefined
      : presence === "blank_printed"
        ? `The ${rule.field.replaceAll("_", " ")} field is printed as blank in the ${rule.document.replaceAll("_", " ")}.`
        : `No ${rule.field.replaceAll("_", " ")} was found in the ${rule.document.replaceAll("_", " ")}.`;

    findings.push(makeFinding({
      finding_id: `${rule.rule_id}-${rule.document}-${rule.field}`,
      type: "missing_field",
      severity: severityOrDefault(rule.severity),
      rule_id: rule.rule_id,
      field: rule.field,
      message: `${rule.description} The field is blank or missing.`,
      evidence: [{
        document: rule.document,
        page,
        source_text: sourceText,
        ...(note ? { note } : {}),
      }],
    }));
  }

  return findings;
}

function normalizeBase(value, requirements, { address = false, tin = false } = {}) {
  let text = value.normalize("NFKC").toLowerCase();
  if (tin) return text.replace(/[\s-]/g, "");

  text = text.replace(/&/g, " and ");
  if (address) {
    text = text
      .replace(/\bcity\s+of\s+/g, "")
      .replace(/\s+city\b/g, "")
      .replace(/(?:,\s*|\s+)\d{4}\s*$/g, "");
  }

  for (const group of requirements.normalization?.synonyms ?? []) {
    if (group.some((item) => item.toLowerCase() === "php")) continue;
    const normalized = group.map((item) => item.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""));
    const canonical = normalized[normalized.length - 1];
    text = text.replace(/[\p{L}\p{N}&]+/gu, (token) => {
      const key = token.replace(/[^\p{L}\p{N}]+/gu, "");
      return normalized.includes(key) ? canonical : token;
    });
  }

  return text.replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function normalizeName(value, requirements) {
  const comma = value.indexOf(",");
  const reordered = comma >= 0
    ? `${value.slice(comma + 1)} ${value.slice(0, comma)}`
    : value;
  const tokens = normalizeBase(reordered, requirements).split(" ").filter(Boolean);
  const words = tokens.filter((token) => token.length > 1);
  const initials = tokens.filter((token) => token.length === 1);
  return { words, initials: initials.sort() };
}

function sameName(left, right, requirements) {
  const a = normalizeName(left, requirements);
  const b = normalizeName(right, requirements);
  return a.words.join(" ") === b.words.join(" ")
    && (a.initials.length === 0 || b.initials.length === 0 || a.initials.join(" ") === b.initials.join(" "));
}

function sameValue(field, left, right, requirements) {
  if (field === "owner_name") return sameName(left, right, requirements);
  const options = {
    address: field === "business_address",
    tin: field === "tin",
  };
  const a = normalizeBase(left, requirements, options);
  const b = normalizeBase(right, requirements, options);
  if (a === b) return true;
  if (field !== "business_address") return false;

  const aTokens = a.split(" ");
  const bTokens = b.split(" ");
  const aNumbers = aTokens.filter((token) => /^\d+$/.test(token));
  const bNumbers = bTokens.filter((token) => /^\d+$/.test(token));
  if (aNumbers.join(" ") !== bNumbers.join(" ")) return false;
  const shorter = aTokens.length < bTokens.length ? aTokens : bTokens;
  const longer = aTokens.length < bTokens.length ? bTokens : aTokens;
  return shorter.every((token, index) => token === longer[index]);
}

function evidenceFor(field) {
  const evidence = {
    document: field.document,
    page: Number.isInteger(field.page) && field.page > 0 ? field.page : 1,
    source_text: field.source_text?.trim() ? field.source_text : null,
  };
  if (!field.source_text?.trim()) evidence.note = "The extracted value could not be verified because no source text was available.";
  else if (field.verified === false) evidence.note = "The extracted value could not be verified against the quoted source text.";
  return evidence;
}

export function compareAcrossDocuments(fields, requirements) {
  const findings = [];
  const blockedFields = new Set(requirements.do_not_compare ?? []);
  const reportedUnverified = new Set();

  for (const check of requirements.cross_document_checks) {
    if (blockedFields.has(check.field) || check.field === "owner_residence_address") continue;
    const applicable = fields.filter((item) =>
      item.field === check.field
      && check.documents.includes(item.document)
      && !blank(item.value));
    for (const item of applicable) {
      if (item.verified !== false && item.source_text?.trim()) continue;
      const key = `${item.document}:${item.field}`;
      if (reportedUnverified.has(key)) continue;
      reportedUnverified.add(key);
      findings.push(makeFinding({
        finding_id: `${check.rule_id}-UNVERIFIED-${item.document}-${item.field}`,
        type: "missing_field",
        severity: "low",
        rule_id: `${check.rule_id}-UNVERIFIED`,
        field: item.field,
        message: `The extracted ${item.field.replaceAll("_", " ")} in ${item.document.replaceAll("_", " ")} could not be verified in the source. Cross-document comparison was skipped for this value.`,
        evidence: [evidenceFor(item)],
      }));
    }
    const values = applicable.filter((item) => item.verified !== false && item.source_text?.trim());
    if (values.length < 2) continue;

    const groups = [];
    for (const item of values) {
      let group = groups.find((candidate) => sameValue(check.field, candidate[0].value, item.value, requirements));
      if (!group) {
        group = [];
        groups.push(group);
      }
      group.push(item);
    }
    if (groups.length < 2) continue;

    groups.sort((a, b) => b.length - a.length);
    const baseline = groups[0][0];
    for (const group of groups.slice(1)) {
      const conflicting = group[0];
      findings.push(makeFinding({
        finding_id: `${check.rule_id}-${check.field}-${baseline.document}-${conflicting.document}`,
        type: "cross_document_mismatch",
        severity: severityOrDefault(check.severity),
        rule_id: check.rule_id,
        field: check.field,
        message: `${check.field.replaceAll("_", " ")} differs between ${baseline.document.replaceAll("_", " ")} and ${conflicting.document.replaceAll("_", " ")}. Please review the source documents.`,
        evidence: [evidenceFor(baseline), evidenceFor(conflicting)],
      }));
    }
  }

  return findings;
}

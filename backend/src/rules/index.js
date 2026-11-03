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
  if (!field.source_text?.trim() || !Number.isInteger(field.page) || field.page < 1) {
    throw new Error(`Cannot compare ${field.document}.${field.field}: page and source_text are required as evidence.`);
  }
  return { document: field.document, page: field.page, source_text: field.source_text };
}

export function compareAcrossDocuments(fields, requirements) {
  const findings = [];
  const blockedFields = new Set(requirements.do_not_compare ?? []);

  for (const check of requirements.cross_document_checks) {
    if (blockedFields.has(check.field) || check.field === "owner_residence_address") continue;
    const values = fields.filter((item) =>
      item.field === check.field
      && check.documents.includes(item.document)
      && !blank(item.value));
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

// Accept only unambiguous calendar dates. Numeric day/month dates require human review.
export function parseDocumentDate(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  let year, month, day;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) [, year, month, day] = match.map(Number);
  else {
    match = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
    const reversed = /^(\d{1,2})\s+([A-Za-z]+)\.?[,]?\s+(\d{4})$/.exec(text);
    if (!match && !reversed) return null;
    const name = (match?.[1] ?? reversed[2]).toLowerCase();
    month = months.findIndex((item) => item === name || item.slice(0, 3) === name) + 1;
    day = Number(match?.[2] ?? reversed[1]);
    year = Number(match?.[3] ?? reversed[3]);
  }
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

export function reviewDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function checkValidity(fields, documents, requirements, asOf = reviewDate()) {
  const uploaded = new Set(documents.map(documentName));
  const findings = [];
  for (const rule of requirements.validity_checks ?? []) {
    if (!uploaded.has(rule.document)) continue;
    const end = fields.find((f) => f.document === rule.document && f.field === rule.field);
    const start = fields.find((f) => f.document === rule.document && f.field === rule.start_field);
    const expiry = end?.verified === false ? null : parseDocumentDate(end?.value);
    const beginning = start?.verified === false ? null : parseDocumentDate(start?.value);
    const reasons = [];
    if (!expiry) reasons.push(`The ${rule.field.replaceAll("_", " ")} date is missing, ambiguous, invalid, or not supported by the extracted source`);
    else if (expiry < asOf) reasons.push(`The printed validity ended on ${expiry}; review date is ${asOf}`);
    if (rule.start_field && !beginning) reasons.push(`The ${rule.start_field.replaceAll("_", " ")} date requires source review`);
    else if (beginning && beginning > asOf) reasons.push(`The document starts on ${beginning}, after the review date ${asOf}`);
    if (beginning && expiry && beginning > expiry) reasons.push("The start date is later than the expiry date");
    if (!reasons.length) continue;
    findings.push(makeFinding({
      finding_id: `${rule.rule_id}-${rule.document}`,
      type: "validity_issue", severity: rule.severity, rule_id: rule.rule_id, field: rule.field,
      message: `${reasons.join(". ")}. Verify the source and applicable LGU requirement before deciding.`,
      evidence: [end, ...(rule.start_field ? [start] : [])].map((field, index) => ({
        document: rule.document, page: field?.page ?? 1,
        source_text: field?.source_text?.trim() || null,
        ...(!field?.source_text?.trim() ? { note: `No source text is available for ${index === 0 ? rule.field : rule.start_field}.` } : {}),
      })),
    }));
  }
  return findings;
}

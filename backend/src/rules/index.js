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
    if (!checklist || !checklist.source_text?.trim() || !Number.isInteger(checklist.page) || checklist.page < 1) {
      throw new Error(`Missing ${rule.document}: application_form checklist evidence (page and source_text) is required.`);
    }

    findings.push(makeFinding({
      finding_id: `${rule.rule_id}-${rule.document}`,
      type: "missing_document",
      severity: "high",
      rule_id: rule.rule_id,
      field: rule.document,
      message: checklist.checked
        ? `${rule.label} is required but was not uploaded. The application form's requirements checklist marks it as attached.`
        : `${rule.label} is required but was not uploaded. The application form's requirements checklist does not mark it as attached.`,
      evidence: [{
        document: "application_form",
        page: checklist.page,
        source_text: checklist.source_text,
      }],
    }));
  }

  return findings;
}

export function checkRequiredFields(fields, requirements) {
  const findings = [];

  for (const rule of requirements.required_fields) {
    const field = fields.find((item) => item.document === rule.document && item.field === rule.field);
    if (!field) {
      if (!fields.some((item) => item.document === rule.document)) continue;
      throw new Error(`Required extraction ${rule.document}.${rule.field} is absent; the rules engine cannot assess it.`);
    }
    if (!blank(field.value)) continue;
    if (!field.source_text?.trim() || !Number.isInteger(field.page) || field.page < 1) {
      throw new Error(`Missing ${rule.document}.${rule.field}: source page and printed source_text are required as evidence.`);
    }

    findings.push(makeFinding({
      finding_id: `${rule.rule_id}-${rule.document}-${rule.field}`,
      type: "missing_field",
      severity: severityOrDefault(rule.severity),
      rule_id: rule.rule_id,
      field: rule.field,
      message: `${rule.description} The field is blank or missing.`,
      evidence: [{
        document: field.document,
        page: field.page,
        source_text: field.source_text,
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

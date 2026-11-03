const APPLICATION_STATUSES = ["uploaded", "extracting", "ready_for_review", "approved", "returned"];
const FINDING_STATUSES = ["open", "confirmed", "dismissed", "escalated"];
const FINDING_TYPES = ["missing_document", "missing_field", "cross_document_mismatch", "validity_issue"];
const SEVERITIES = ["high", "medium", "low"];

export function buildReport(snapshot, { from, to }) {
  const start = from ? new Date(from) : null;
  const end = to ? new Date(to) : null;
  if ((from && Number.isNaN(start?.getTime())) || (to && Number.isNaN(end?.getTime())) || (start && end && start > end)) {
    throw new Error("Choose a valid reporting date range.");
  }
  const applications = snapshot.applications.filter((item) => {
    const created = new Date(item.created_at);
    return (!start || created >= start) && (!end || created <= end);
  });
  const ids = new Set(applications.map((item) => item.id));
  const findings = (snapshot.findings ?? applications.flatMap((item) =>
    (item.findings ?? []).map((finding) => ({ application_id: item.id, ...finding }))))
    .filter((item) => ids.has(item.application_id));
  const documents = (snapshot.documents ?? applications.flatMap((item) =>
    (item.documents ?? []).map((document) => ({ application_id: item.id, ...document }))))
    .filter((item) => ids.has(item.application_id));
  const countBy = (items, key, values) => Object.fromEntries(values.map((value) => [value,
    items.filter((item) => item[key] === value).length]));
  const status = countBy(applications, "status", APPLICATION_STATUSES);
  const findingStatus = countBy(findings, "status", FINDING_STATUSES);
  const findingType = countBy(findings, "type", FINDING_TYPES);
  const severity = countBy(findings, "severity", SEVERITIES);
  const processedIds = new Set(applications.filter((item) => ["ready_for_review", "approved", "returned"].includes(item.status)).map((item) => item.id));
  const docMethod = countBy(documents.filter((item) => processedIds.has(item.application_id)), "method", ["text_layer", "ocr"]);
  const trends = new Map();
  for (const application of applications) {
    const day = new Date(application.created_at).toISOString().slice(0, 10);
    trends.set(day, (trends.get(day) ?? 0) + 1);
  }
  const audit = (snapshot.audit ?? []).filter((item) => ids.has(item.application_id));
  return {
    period: { from: from ?? null, to: to ?? null },
    generated_at: new Date().toISOString(),
    application_total: applications.length,
    applications_by_status: status,
    documents_total: documents.length,
    documents_by_method: docMethod,
    findings_total: findings.length,
    findings_by_status: findingStatus,
    findings_by_type: findingType,
    findings_by_severity: severity,
    extraction_completed: audit.filter((item) => item.action === "extraction_completed").length,
    extraction_failed: audit.filter((item) => item.action === "extraction_failed").length,
    trend: [...trends].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),
    applications: applications.map(({ id, status: appStatus, created_at }) => ({ id, status: appStatus, created_at })),
  };
}

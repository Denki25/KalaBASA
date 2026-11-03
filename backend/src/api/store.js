import { createClient } from "@supabase/supabase-js";
import { Application } from "kalabasa-contract/schemas.js";

export class DatabaseMigrationRequiredError extends Error {
  constructor() {
    super("The database needs an update. Run backend/db/verification.sql in the Supabase SQL Editor, then retry the upload.");
    this.name = "DatabaseMigrationRequiredError";
  }
}

function assertSupabase(result) {
  if (["42703", "PGRST204"].includes(result.error?.code)
    && /verifications/i.test(result.error.message ?? "")) {
    throw new DatabaseMigrationRequiredError();
  }
  if (result.error) throw new Error(`Supabase request failed: ${result.error.message}`);
  return result.data;
}

export class MemoryStore {
  constructor(applications = []) {
    this.applications = new Map(applications.map((application) => [
      application.id,
      structuredClone(Application.parse(application)),
    ]));
    this.auditLog = [];
  }

  async get(id) {
    const application = this.applications.get(id);
    return application ? structuredClone(application) : null;
  }

  async list(lguId) {
    return [...this.applications.values()]
      .filter((application) => !lguId || application.lgu_id === lguId)
      .map((application) => ({
      id: application.id,
      lgu_id: application.lgu_id,
      label: application.label,
      business_name: application.fields.find((field) => field.field === "business_name")?.value ?? null,
      owner_name: application.fields.find((field) => field.field === "owner_name")?.value ?? null,
      finding_summary: (() => {
        const finding = application.findings.find((item) => item.status === "open" || item.status === "escalated");
        return finding ? `${finding.field.replaceAll("_", " ")}: ${finding.message}`.slice(0, 160) : null;
      })(),
      status: application.status,
      created_at: application.created_at,
      open_findings: application.findings.filter((finding) => finding.status === "open" || finding.status === "escalated").length,
      total_findings: application.findings.length,
      })).sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  async recentAudit(limit = 10) {
    const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
    return structuredClone(this.auditLog)
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, safeLimit);
  }

  async applicationHistory(id) {
    return structuredClone(this.auditLog
      .filter((entry) => entry.application_id === id)
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp)));
  }

  async save(application) {
    const parsed = Application.parse(application);
    this.applications.set(parsed.id, structuredClone(parsed));
    return structuredClone(parsed);
  }

  async audit(entry) {
    this.auditLog.push(structuredClone(entry));
  }

  async reportSnapshot(lguId, crossLgu = false, { from, to } = {}) {
    const applications = [...this.applications.values()].filter((item) =>
      (crossLgu || item.lgu_id === lguId)
      && (!from || new Date(item.created_at) >= new Date(from))
      && (!to || new Date(item.created_at) <= new Date(to)));
    const ids = new Set(applications.map((item) => item.id));
    const audit = this.auditLog.filter((entry) => ids.has(entry.application_id));
    return structuredClone({ applications, audit });
  }
}

export class SupabaseStore extends MemoryStore {
  constructor(client, applications = []) {
    super(applications);
    this.client = client;
  }

  async get(id, { fresh = false } = {}) {
    const cached = fresh ? null : await super.get(id);
    if (cached) return cached;

    const row = assertSupabase(await this.client.from("applications").select("*").eq("id", id).maybeSingle());
    if (!row) return fresh ? null : await super.get(id);
    const [documents, fields, findings] = await Promise.all([
      this.client.from("documents").select("*").eq("application_id", id),
      this.client.from("fields").select("*").eq("application_id", id),
      this.client.from("findings").select("*").eq("application_id", id),
    ]);
    const app = Application.parse({
      ...row,
      documents: assertSupabase(documents).map(({ document, filename, pages, method }) => ({ document, filename, pages, method })),
      fields: assertSupabase(fields).map(({ id: _id, application_id: _appId, ...field }) => field),
      findings: assertSupabase(findings).map(({ id: _id, application_id: _appId, ...finding }) => finding),
    });
    await super.save(app);
    return app;
  }

  async list(lguId) {
    let applicationQuery = this.client.from("applications").select("id,lgu_id,label,status,created_at");
    if (lguId) applicationQuery = applicationQuery.eq("lgu_id", lguId);
    const rows = assertSupabase(await applicationQuery);
    if (!rows.length) return [];
    const applicationIds = rows.map((row) => row.id);
    const [findingsResult, fieldsResult] = await Promise.all([
      this.client.from("findings").select("application_id,status,field,message").in("application_id", applicationIds),
      this.client.from("fields").select("application_id,field,value")
        .in("application_id", applicationIds).in("field", ["business_name", "owner_name"]),
    ]);
    const findings = assertSupabase(findingsResult);
    const fields = assertSupabase(fieldsResult);
    const counts = new Map();
    const findingSummaries = new Map();
    for (const finding of findings) {
      const count = counts.get(finding.application_id) ?? { open_findings: 0, total_findings: 0 };
      count.total_findings += 1;
      if (finding.status === "open" || finding.status === "escalated") count.open_findings += 1;
      counts.set(finding.application_id, count);
      if ((finding.status === "open" || finding.status === "escalated") && !findingSummaries.has(finding.application_id)) {
        findingSummaries.set(finding.application_id, `${finding.field.replaceAll("_", " ")}: ${finding.message}`.slice(0, 160));
      }
    }
    const names = new Map();
    for (const field of fields) {
      const namesForApplication = names.get(field.application_id) ?? {};
      namesForApplication[field.field] = field.value;
      names.set(field.application_id, namesForApplication);
    }
    return rows.map((row) => ({
      ...row,
      business_name: names.get(row.id)?.business_name ?? null,
      owner_name: names.get(row.id)?.owner_name ?? null,
      finding_summary: findingSummaries.get(row.id) ?? null,
      open_findings: counts.get(row.id)?.open_findings ?? 0,
      total_findings: counts.get(row.id)?.total_findings ?? 0,
    })).sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  async recentAudit(limit = 10) {
    const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
    const rows = assertSupabase(await this.client.from("audit_log")
      .select("application_id,action,details,created_at")
      .order("created_at", { ascending: false })
      .limit(safeLimit));
    return rows.map((row) => ({
      application_id: row.application_id,
      action: row.action,
      details: row.details ?? {},
      timestamp: row.created_at,
    }));
  }

  async applicationHistory(id) {
    const rows = assertSupabase(await this.client.from("audit_log")
      .select("application_id,action,actor,details,created_at")
      .eq("application_id", id)
      .order("created_at", { ascending: true }));
    return rows.map((row) => ({
      application_id: row.application_id,
      action: row.action,
      actor: row.actor,
      details: row.details ?? {},
      timestamp: row.created_at,
    }));
  }

  async reportSnapshot(lguId, crossLgu = false, { from, to } = {}) {
    let query = this.client.from("applications").select("id,lgu_id,label,status,created_at");
    if (!crossLgu) query = query.eq("lgu_id", lguId);
    if (from) query = query.gte("created_at", from);
    if (to) query = query.lte("created_at", to);
    const applications = assertSupabase(await query);
    const ids = applications.map((item) => item.id);
    if (!ids.length) return { applications: [], documents: [], findings: [], audit: [] };
    const [documents, findings, audit] = await Promise.all([
      this.client.from("documents").select("application_id,method").in("application_id", ids),
      this.client.from("findings").select("application_id,type,severity,status").in("application_id", ids),
      this.client.from("audit_log").select("application_id,action,created_at").in("application_id", ids),
    ]);
    return {
      applications,
      documents: assertSupabase(documents),
      findings: assertSupabase(findings),
      audit: assertSupabase(audit).map((item) => ({ ...item, timestamp: item.created_at })),
    };
  }

  async save(application) {
    const parsed = Application.parse(application);
    assertSupabase(await this.client.from("applications").upsert({
      id: parsed.id,
      lgu_id: parsed.lgu_id,
      label: parsed.label,
      status: parsed.status,
      created_at: parsed.created_at,
      verifications: parsed.verifications,
    }));

    const documentRows = parsed.documents.map((item) => ({ application_id: parsed.id, ...item }));
    const fieldRows = parsed.fields.map((item) => ({ application_id: parsed.id, ...item }));
    const findingRows = parsed.findings.map((item) => ({ application_id: parsed.id, ...item }));
    const conflictColumns = {
      documents: "application_id,document",
      fields: "application_id,document,field",
      findings: "application_id,finding_id",
    };
    for (const [table, rows] of [["documents", documentRows], ["fields", fieldRows], ["findings", findingRows]]) {
      if (rows.length) {
        assertSupabase(await this.client.from(table).upsert(rows, { onConflict: conflictColumns[table] }));
      }
    }

    return super.save(parsed);
  }

  async audit(entry) {
    assertSupabase(await this.client.from("audit_log").insert({
      application_id: entry.application_id,
      action: entry.action,
      actor: entry.actor,
      details: entry.details,
      created_at: entry.timestamp,
    }));
    await super.audit(entry);
  }
}

export function getSupabaseConfig(env = process.env) {
  const url = typeof env.SUPABASE_URL === "string" ? env.SUPABASE_URL.trim() : "";
  const key = typeof env.SUPABASE_SERVICE_KEY === "string" ? env.SUPABASE_SERVICE_KEY.trim() : "";
  const missing = url && !key ? "SUPABASE_SERVICE_KEY" : key && !url ? "SUPABASE_URL" : null;
  return { url, key, missing, enabled: Boolean(url && key) };
}

export function createStore(applications = [], env = process.env) {
  const { url, key, missing } = getSupabaseConfig(env);
  if (!url && !key) return new MemoryStore(applications);
  if (missing) {
    throw new Error(`${missing} is missing. Set both SUPABASE_URL and SUPABASE_SERVICE_KEY to enable Supabase, or clear both. In PowerShell, use Remove-Item Env:SUPABASE_URL and Remove-Item Env:SUPABASE_SERVICE_KEY to clear shell values; existing shell variables override values in .env.`);
  }
  return new SupabaseStore(createClient(url, key), applications);
}

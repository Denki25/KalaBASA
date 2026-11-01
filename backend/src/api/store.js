import { createClient } from "@supabase/supabase-js";
import { Application } from "kalabasa-contract/schemas.js";

function assertSupabase(result) {
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

  async list() {
    return [...this.applications.values()].map((application) => ({
      id: application.id,
      lgu_id: application.lgu_id,
      label: application.label,
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

  async save(application) {
    const parsed = Application.parse(application);
    this.applications.set(parsed.id, structuredClone(parsed));
    return structuredClone(parsed);
  }

  async audit(entry) {
    this.auditLog.push(structuredClone(entry));
  }
}

export class SupabaseStore extends MemoryStore {
  constructor(client, applications = []) {
    super(applications);
    this.client = client;
  }

  async get(id) {
    const cached = await super.get(id);
    if (cached) return cached;

    const row = assertSupabase(await this.client.from("applications").select("*").eq("id", id).maybeSingle());
    if (!row) return null;
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

  async list() {
    const rows = assertSupabase(await this.client.from("applications").select("id,lgu_id,label,status,created_at"));
    const findings = assertSupabase(await this.client.from("findings").select("application_id,status"));
    const counts = new Map();
    for (const finding of findings) {
      const count = counts.get(finding.application_id) ?? { open_findings: 0, total_findings: 0 };
      count.total_findings += 1;
      if (finding.status === "open" || finding.status === "escalated") count.open_findings += 1;
      counts.set(finding.application_id, count);
    }
    return rows.map((row) => ({
      ...row,
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

  async save(application) {
    const parsed = Application.parse(application);
    assertSupabase(await this.client.from("applications").upsert({
      id: parsed.id,
      lgu_id: parsed.lgu_id,
      label: parsed.label,
      status: parsed.status,
      created_at: parsed.created_at,
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

export function createStore(applications = [], env = process.env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_KEY;
  if (!url && !key) return new MemoryStore(applications);
  if (!url || !key) throw new Error("Both SUPABASE_URL and SUPABASE_SERVICE_KEY are required to enable Supabase.");
  return new SupabaseStore(createClient(url, key), applications);
}

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
    for (const [table, rows] of [["documents", documentRows], ["fields", fieldRows], ["findings", findingRows]]) {
      if (rows.length) assertSupabase(await this.client.from(table).upsert(rows));
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

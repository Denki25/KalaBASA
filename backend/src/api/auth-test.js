import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import test from "node:test";
import { Application } from "kalabasa-contract/schemas.js";
import { createApp } from "./app.js";
import { MemoryStore } from "./store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const clean = Application.parse(JSON.parse(await fs.readFile(
  path.join(repoRoot, "contract", "fixtures", "set_01_clean.json"), "utf8")));

const appA = Application.parse({ ...clean, id: "app-lgu-a", lgu_id: "lgu-a", status: "ready_for_review" });
const appB = Application.parse({ ...clean, id: "app-lgu-b", lgu_id: "lgu-b", status: "ready_for_review" });

// A fake login service, so these tests do not need the internet or Supabase.
const USERS = {
  "tok-a": { id: "1", email: "reviewer.a@test.com", full_name: "Reviewer A", role: "reviewer", lgu_id: "lgu-a" },
  "tok-b": { id: "2", email: "reviewer.b@test.com", full_name: "Reviewer B", role: "reviewer", lgu_id: "lgu-b" },
  "tok-viewer": { id: "3", email: "viewer.a@test.com", full_name: "Viewer A", role: "viewer", lgu_id: "lgu-a" },
  "tok-admin": { id: "4", email: "admin@test.com", full_name: "Admin", role: "admin", lgu_id: "lgu-a" },
};
const fakeAuth = {
  async login(email, password) {
    if (email === "reviewer.a@test.com" && password === "right") return { token: "tok-a", user: USERS["tok-a"] };
    return { error: "Wrong email or password." };
  },
  async verify(token) { return USERS[token] ?? null; },
};

async function withApi(callback) {
  const store = new MemoryStore([appA, appB]);
  const server = createServer(createApp({ store, mockMode: false, auth: fakeAuth }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (url, token, options = {}) => fetch(`${base}${url}`, {
    ...options,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers ?? {}) },
  });
  try {
    await callback(call, store);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("health and LGU requirements are public; everything else needs a token", async () => {
  await withApi(async (call) => {
    assert.equal((await call("/api/health")).status, 200);
    assert.equal((await call("/api/lgus/bagong-dalisay-demo/requirements")).status, 200);
    for (const url of ["/api/applications", "/api/activity", "/api/stats", "/api/applications/app-lgu-a", "/api/auth/me"]) {
      assert.equal((await call(url)).status, 401, url);
    }
    assert.equal((await call("/api/applications", "not-a-real-token")).status, 401);
    const post = await call("/api/applications/app-lgu-a/approve", null, { method: "POST" });
    assert.equal(post.status, 401);
  });
});

test("login accepts the right password and rejects the wrong one", async () => {
  await withApi(async (call) => {
    const post = (body) => call("/api/auth/login", null, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const good = await post({ email: "reviewer.a@test.com", password: "right" });
    assert.equal(good.status, 200);
    const data = await good.json();
    assert.equal(data.token, "tok-a");
    assert.equal(data.user.role, "reviewer");
    assert.equal((await post({ email: "reviewer.a@test.com", password: "wrong" })).status, 401);
    assert.equal((await post({ email: "", password: "" })).status, 400);
    const me = await call("/api/auth/me", "tok-a");
    assert.equal((await me.json()).user.lgu_id, "lgu-a");
  });
});

test("each LGU only sees its own applications; admin sees all", async () => {
  await withApi(async (call) => {
    const ids = async (token) => (await (await call("/api/applications", token)).json()).map((item) => item.id).sort();
    assert.deepEqual(await ids("tok-a"), ["app-lgu-a"]);
    assert.deepEqual(await ids("tok-b"), ["app-lgu-b"]);
    assert.deepEqual(await ids("tok-admin"), ["app-lgu-a", "app-lgu-b"]);
    assert.equal((await call("/api/applications/app-lgu-a", "tok-a")).status, 200);
    assert.equal((await call("/api/applications/app-lgu-b", "tok-a")).status, 404);
    assert.equal((await call("/api/applications/app-lgu-a", "tok-b")).status, 404);
    assert.equal((await call("/api/applications/app-lgu-b", "tok-admin")).status, 200);
  });
});

test("another LGU cannot change or decide an application", async () => {
  await withApi(async (call, store) => {
    for (const action of ["approve", "return", "process"]) {
      const response = await call(`/api/applications/app-lgu-a/${action}`, "tok-b", { method: "POST" });
      assert.equal(response.status, 404, action);
    }
    assert.equal((await store.get("app-lgu-a")).status, "ready_for_review");
  });
});

test("viewers can read but cannot change anything", async () => {
  await withApi(async (call, store) => {
    assert.equal((await call("/api/applications/app-lgu-a", "tok-viewer")).status, 200);
    assert.equal((await call("/api/applications", "tok-viewer")).status, 200);
    assert.equal((await call("/api/applications/app-lgu-a/approve", "tok-viewer", { method: "POST" })).status, 403);
    assert.equal((await call("/api/applications/app-lgu-a/return", "tok-viewer", { method: "POST" })).status, 403);
    assert.equal((await call("/api/applications/app-lgu-a/process", "tok-viewer", { method: "POST" })).status, 403);
    const patch = await call("/api/applications/app-lgu-a/findings/x", "tok-viewer", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "confirmed" }),
    });
    assert.equal(patch.status, 403);
    const form = new FormData();
    form.append("files", new Blob(["%PDF-1.4"], { type: "application/pdf" }), "a.pdf");
    form.append("document_types", "application_form");
    assert.equal((await call("/api/applications", "tok-viewer", { method: "POST", body: form })).status, 403);
    assert.equal((await store.get("app-lgu-a")).status, "ready_for_review");
  });
});

test("approving records the real user in the audit log", async () => {
  await withApi(async (call, store) => {
    const response = await call("/api/applications/app-lgu-a/approve", "tok-a", { method: "POST" });
    assert.equal(response.status, 200);
    const last = store.auditLog.at(-1);
    assert.equal(last.action, "application_approve");
    assert.equal(last.actor, "reviewer.a@test.com");
  });
});

test("activity and stats only include the user's own LGU", async () => {
  await withApi(async (call, store) => {
    const now = new Date().toISOString();
    await store.audit({ application_id: "app-lgu-a", action: "application_created", actor: "x", details: {}, timestamp: now });
    await store.audit({ application_id: "app-lgu-b", action: "application_created", actor: "x", details: {}, timestamp: now });
    const forA = await (await call("/api/activity?limit=50", "tok-a")).json();
    assert.deepEqual(forA.map((item) => item.application_id), ["app-lgu-a"]);
    const forAdmin = await (await call("/api/activity?limit=50", "tok-admin")).json();
    assert.equal(forAdmin.length, 2);
    const stats = await (await call("/api/stats", "tok-b")).json();
    assert.equal(stats.pending, 1);
  });
});

test("new applications always belong to the uploader's LGU, even if the request says otherwise", async () => {
  await withApi(async (call, store) => {
    const form = new FormData();
    form.append("files", new Blob(["%PDF-1.4 test"], { type: "application/pdf" }), "form.pdf");
    form.append("document_types", "application_form");
    form.append("lgu_id", "lgu-b");
    const response = await call("/api/applications", "tok-a", { method: "POST", body: form });
    assert.equal(response.status, 201);
    const { id } = await response.json();
    try {
      assert.equal((await store.get(id)).lgu_id, "lgu-a");
      assert.equal((await call(`/api/applications/${id}`, "tok-b")).status, 404);
    } finally {
      await fs.rm(path.join(repoRoot, "backend", ".cache", "uploads", id), { recursive: true, force: true });
    }
  });
});

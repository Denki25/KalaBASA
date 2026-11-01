import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "./app.js";
import { MemoryStore } from "./store.js";
import { createLocalStorage, createSupabaseStorage } from "./documents.js";

// A tiny pretend Supabase Storage client that keeps files in memory.
function fakeSupabaseClient() {
  const buckets = new Map();
  const calls = { bucketNames: new Set() };
  return {
    buckets,
    calls,
    storage: {
      from(bucket) {
        calls.bucketNames.add(bucket);
        if (!buckets.has(bucket)) buckets.set(bucket, new Map());
        const objects = buckets.get(bucket);
        return {
          async upload(objectPath, body, options) {
            objects.set(objectPath, { body: Buffer.from(body), contentType: options?.contentType });
            return { data: { path: objectPath }, error: null };
          },
          async download(objectPath) {
            const object = objects.get(objectPath);
            if (!object) return { data: null, error: { message: "Object not found" } };
            return { data: new Blob([object.body]), error: null };
          },
          async remove(paths) {
            for (const item of paths) objects.delete(item);
            return { data: [], error: null };
          },
        };
      },
    },
  };
}

test("local storage saves, hands out a file path, and removes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kb-local-"));
  try {
    const storage = createLocalStorage(root);
    await storage.save("app1", "application_form", Buffer.from("hello"));
    const text = await storage.withFile("app1", "application_form", (file) => fs.readFile(file, "utf8"));
    assert.equal(text, "hello");
    await storage.remove("app1");
    await assert.rejects(() => storage.withFile("app1", "application_form", (file) => fs.readFile(file, "utf8")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("supabase storage uses the private bucket, cleans up its temp file, and reports missing files", async () => {
  const client = fakeSupabaseClient();
  const storage = createSupabaseStorage(client);
  await storage.save("app1", "dti_certificate", Buffer.from("pdf-bytes"));
  assert.deepEqual([...client.calls.bucketNames], ["application-documents"]);
  assert.equal(client.buckets.get("application-documents").get("app1/dti_certificate.pdf").contentType, "application/pdf");

  let seenPath;
  const text = await storage.withFile("app1", "dti_certificate", async (file) => {
    seenPath = file;
    return fs.readFile(file, "utf8");
  });
  assert.equal(text, "pdf-bytes");
  await assert.rejects(() => fs.access(seenPath), "temporary file should be deleted");

  await assert.rejects(() => storage.withFile("app1", "lease_contract", async () => "x"), /Could not read the stored document/);
  await storage.remove("app1", ["dti_certificate"]);
  assert.equal(client.buckets.get("application-documents").size, 0);
});

test("upload then process works end to end using private storage only", async () => {
  const client = fakeSupabaseClient();
  const fileStorage = createSupabaseStorage(client);
  const seen = [];
  const app = createApp({
    store: new MemoryStore([]),
    mockMode: false,
    fileStorage,
    readPdf: async (filePath) => {
      seen.push(await fs.readFile(filePath, "utf8"));
      return { pages: ["[ ] DTI Certificate"], method: "text_layer" };
    },
    extractDocument: async () => [],
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const form = new FormData();
    form.append("label", "Storage test");
    form.append("document_types[]", "application_form");
    form.append("files", new Blob(["%PDF-1.4\nFORM-PDF"], { type: "application/pdf" }), "form.pdf");
    form.append("document_types[]", "dti_certificate");
    form.append("files", new Blob(["%PDF-1.4\nDTI-PDF"], { type: "application/pdf" }), "dti.pdf");
    const created = await fetch(`${base}/api/applications`, { method: "POST", body: form });
    assert.equal(created.status, 201);
    const { id } = await created.json();

    const stored = [...client.buckets.get("application-documents").keys()].sort();
    assert.deepEqual(stored, [`${id}/application_form.pdf`, `${id}/dti_certificate.pdf`]);

    const processed = await fetch(`${base}/api/applications/${id}/process`, { method: "POST" });
    assert.equal(processed.status, 202);
    assert.ok(seen.some((text) => text.includes("FORM-PDF")) && seen.some((text) => text.includes("DTI-PDF")), "processing read the stored copies");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("a failed upload removes the files that were already stored", async () => {
  const client = fakeSupabaseClient();
  const real = createSupabaseStorage(client);
  let count = 0;
  const flaky = {
    ...real,
    async save(...args) {
      count += 1;
      if (count === 2) throw new Error("storage is down");
      return real.save(...args);
    },
  };
  const server = createServer(createApp({ store: new MemoryStore([]), mockMode: false, fileStorage: flaky }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const form = new FormData();
    form.append("document_types[]", "application_form");
    form.append("files", new Blob(["%PDF-1.4\nA"], { type: "application/pdf" }), "a.pdf");
    form.append("document_types[]", "dti_certificate");
    form.append("files", new Blob(["%PDF-1.4\nB"], { type: "application/pdf" }), "b.pdf");
    const response = await fetch(`${base}/api/applications`, { method: "POST", body: form });
    assert.ok(response.status >= 400);
    assert.equal(client.buckets.get("application-documents").size, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

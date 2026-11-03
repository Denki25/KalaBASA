import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "./app.js";
import { MemoryStore } from "./store.js";
import { createLocalStorage, createSupabaseStorage } from "./documents.js";
import { createCanvas } from "@napi-rs/canvas";

const samplePdf = await fs.readFile(new URL("../../../samples/set_01_clean/application_form.pdf", import.meta.url));

function imageBytes(type) {
  const canvas = createCanvas(240, 100);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, 240, 100);
  context.fillStyle = "black";
  context.font = "24px Arial";
  context.fillText("TEST DOCUMENT", 12, 56);
  return canvas.toBuffer(type);
}

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
    form.append("files", new Blob([samplePdf], { type: "application/pdf" }), "form.pdf");
    form.append("document_types[]", "dti_certificate");
    form.append("files", new Blob([samplePdf], { type: "application/pdf" }), "dti.pdf");
    const created = await fetch(`${base}/api/applications`, { method: "POST", body: form });
    assert.equal(created.status, 201);
    const { id } = await created.json();

    const stored = [...client.buckets.get("application-documents").keys()].sort();
    assert.deepEqual(stored, [`${id}/application_form.pdf`, `${id}/dti_certificate.pdf`]);

    const processed = await fetch(`${base}/api/applications/${id}/process`, { method: "POST" });
    assert.equal(processed.status, 202);
    assert.ok(seen.some((text) => text.includes("%PDF-")), "processing read the stored PDF copies");
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
    form.append("files", new Blob([samplePdf], { type: "application/pdf" }), "a.pdf");
    form.append("document_types[]", "dti_certificate");
    form.append("files", new Blob([samplePdf], { type: "application/pdf" }), "b.pdf");
    const response = await fetch(`${base}/api/applications`, { method: "POST", body: form });
    assert.ok(response.status >= 400);
    assert.equal(client.buckets.get("application-documents")?.size ?? 0, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("valid JPG, JPEG, and PNG uploads can be selected together, stored privately, and processed as OCR pages", async () => {
  const client = fakeSupabaseClient();
  const fileStorage = createSupabaseStorage(client);
  const readPaths = [];
  const app = createApp({
    store: new MemoryStore([]),
    mockMode: false,
    fileStorage,
    readPdf: async (filename) => {
      readPaths.push(path.extname(filename));
      return { pages: [`OCR text from ${path.extname(filename)}`], method: "ocr" };
    },
    extractDocument: async ({ document, pages, method }) => {
      assert.equal(method, "ocr");
      assert.match(pages[0], /OCR text/);
      const field = { application_form: "owner_name", dti_certificate: "dti_registration_no", barangay_clearance: "clearance_no" }[document];
      return [{ field, value: "Sample Applicant", document, page: 1, source_text: "Sample Applicant", presence: "printed", confidence: "high", verified: true, match: "exact", method: "ocr" }];
    },
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const form = new FormData();
    for (const [document, filename, type, bytes] of [
      ["application_form", "application.jpg", "image/jpeg", imageBytes("image/jpeg")],
      ["dti_certificate", "dti.jpeg", "image/jpeg", imageBytes("image/jpeg")],
      ["barangay_clearance", "clearance.png", "image/png", imageBytes("image/png")],
    ]) {
      form.append("document_types[]", document);
      form.append("files", new Blob([bytes], { type }), filename);
    }
    const created = await fetch(`${base}/api/applications`, { method: "POST", body: form });
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
    const { id } = await created.json();
    const stored = client.buckets.get("application-documents");
    assert.deepEqual([...stored.keys()].sort(), [`${id}/application_form.jpg`, `${id}/barangay_clearance.png`, `${id}/dti_certificate.jpeg`].sort());
    assert.equal(stored.get(`${id}/application_form.jpg`).contentType, "image/jpeg");
    assert.equal(stored.get(`${id}/barangay_clearance.png`).contentType, "image/png");

    const processed = await fetch(`${base}/api/applications/${id}/process`, { method: "POST" });
    assert.equal(processed.status, 202, JSON.stringify(await processed.clone().json()));
    const application = await processed.json();
    assert.deepEqual(readPaths.sort(), [".jpeg", ".jpg", ".png"]);
    assert.deepEqual(application.documents.map(({ pages, method }) => [pages, method]), [[1, "ocr"], [1, "ocr"], [1, "ocr"]]);
    assert.ok(application.fields.every((field) => field.method === "ocr" && field.page === 1 && field.source_text && field.verified));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("uploads reject mismatched signatures, unsupported extensions, corrupted images, and oversized images", async () => {
  const client = fakeSupabaseClient();
  const server = createServer(createApp({ store: new MemoryStore([]), mockMode: false, fileStorage: createSupabaseStorage(client) }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function upload(filename, type, bytes) {
    const form = new FormData();
    form.append("document_types[]", "application_form");
    form.append("files", new Blob([bytes], { type }), filename);
    return fetch(`${base}/api/applications`, { method: "POST", body: form });
  }
  try {
    const badExtension = await upload("document.txt", "image/png", imageBytes("image/png"));
    assert.equal(badExtension.status, 400);
    assert.match((await badExtension.json()).error, /Unsupported file type/);
    const badSignature = await upload("fake.png", "image/png", Buffer.from("not really a PNG"));
    assert.equal(badSignature.status, 400);
    assert.match((await badSignature.json()).error, /does not match/);
    const badPdfSignature = await upload("fake.pdf", "application/pdf", Buffer.from("not really a PDF"));
    assert.equal(badPdfSignature.status, 400);
    assert.match((await badPdfSignature.json()).error, /valid PDF/);
    const corrupt = await upload("broken.jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 100, 0, 100, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9]));
    assert.equal(corrupt.status, 400);
    assert.match((await corrupt.json()).error, /corrupted|decode/i);
    const oversizedDimensions = imageBytes("image/png");
    oversizedDimensions.writeUInt32BE(10000, 16);
    oversizedDimensions.writeUInt32BE(10000, 20);
    const tooManyPixels = await upload("huge.png", "image/png", oversizedDimensions);
    assert.equal(tooManyPixels.status, 400);
    assert.match((await tooManyPixels.json()).error, /dimensions are too large/);
    const oversized = await upload("large.png", "image/png", Buffer.alloc(10 * 1024 * 1024 + 1));
    assert.equal(oversized.status, 400);
    assert.match((await oversized.json()).error, /10 MB/);
    assert.equal(client.buckets.get("application-documents")?.size ?? 0, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("an image OCR failure marks processing failed and leaves the application retryable", async () => {
  const store = new MemoryStore([]);
  const server = createServer(createApp({
    store,
    mockMode: false,
    readPdf: async () => { throw new Error("Could not extract readable text from the uploaded image."); },
    extractDocument: async () => { assert.fail("model extraction must not run when image OCR fails"); },
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const form = new FormData();
    form.append("document_types[]", "application_form");
    form.append("files", new Blob([imageBytes("image/png")], { type: "image/png" }), "application.png");
    const created = await fetch(`${base}/api/applications`, { method: "POST", body: form });
    assert.equal(created.status, 201);
    const { id } = await created.json();
    const process = await fetch(`${base}/api/applications/${id}/process`, { method: "POST" });
    assert.equal(process.status, 500);
    assert.match((await process.json()).error, /Could not extract readable text/);
    assert.equal((await store.get(id)).status, "uploaded");
    const progress = await fetch(`${base}/api/applications/${id}/progress`).then((response) => response.json());
    assert.equal(progress.documents[0].status, "failed");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

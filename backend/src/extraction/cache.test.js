import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cacheKey, createLlmClient, extractDocumentCached, seededCacheFile } from "./cache.js";

test("live extraction skips seeded answers and writes only its live response file", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "kalabasa-live-test-"));
  const liveFile = path.join(temp, "live-responses.json");
  const seededBefore = await fs.readFile(seededCacheFile);
  let modelCalls = 0;
  try {
    const result = await extractDocumentCached({
      document: "dti_certificate",
      pages: ["Business Name: Sample"],
      method: "text_layer",
      live: true,
      apiKey: "fake-key",
      cacheFile: seededCacheFile,
      liveFile,
      readCacheFile: async () => { throw new Error("Live mode must not read cached answers."); },
      clientFactory: ({ onModelCall }) => ({
        messages: { async create() {
          await onModelCall();
          modelCalls += 1;
          return { content: [{ type: "text", text: JSON.stringify({ fields: [] }) }] };
        } },
      }),
    });

    assert.equal(modelCalls, 1);
    assert.ok(result.some((field) => field.field === "business_name"));
    assert.equal(await fs.readFile(seededCacheFile, "utf8"), seededBefore.toString("utf8"));
    const liveEntries = JSON.parse(await fs.readFile(liveFile, "utf8"));
    assert.equal(Object.keys(liveEntries).length, 1);
    assert.equal(liveEntries[Object.keys(liveEntries)[0]].document, "dti_certificate");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("parallel cached extractions preserve every response entry", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "kalabasa-cache-race-test-"));
  const cacheFile = path.join(temp, "extraction-responses.json");
  const documents = Array.from({ length: 32 }, (_, index) => ({
    document: "dti_certificate",
    pages: [`parallel request ${index}`],
    method: "text_layer",
  }));
  try {
    await Promise.all(documents.map((input) => extractDocumentCached({
      ...input,
      cacheFile,
      apiKey: "fake-key",
      clientFactory: ({ onModelCall }) => ({
        messages: { async create() {
          await onModelCall();
          return { content: [{ type: "text", text: JSON.stringify({ fields: [] }) }] };
        } },
      }),
    })));
    const entries = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    assert.equal(Object.keys(entries).length, documents.length);
    for (const input of documents) assert.equal(entries[cacheKey(input)]?.document, input.document);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("OpenAI-compatible adapter retries HTTP 429 and tolerates surrounding JSON text", async () => {
  const delays = [];
  const calls = [];
  const client = createLlmClient({
    provider: "openai-compatible",
    apiKey: "fake-key",
    baseUrl: "https://provider.invalid/v1/",
    sleep: async (milliseconds) => delays.push(milliseconds),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Here is the result: ```json\n{\"fields\":[]}\n``` done." } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const response = await client.messages.create({
    model: "fake-model",
    max_tokens: 100,
    system: "system instruction",
    messages: [{ role: "user", content: "fake sample" }],
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [0]);
  assert.equal(calls[0].url, "https://provider.invalid/v1/chat/completions");
  assert.equal(calls[0].options.headers.authorization, "Bearer fake-key");
  const sent = JSON.parse(calls[0].options.body);
  assert.deepEqual(sent.messages.map((message) => message.role), ["system", "user"]);
  assert.equal(response.content[0].text, "{\"fields\":[]}");
});

test("extraction cache keys separate providers and models", () => {
  const input = { document: "dti_certificate", pages: ["sample"] };
  assert.notEqual(
    cacheKey({ ...input, provider: "anthropic", model: "model-a" }),
    cacheKey({ ...input, provider: "openai-compatible", model: "model-a" }),
  );
  assert.notEqual(
    cacheKey({ ...input, provider: "openai-compatible", model: "model-a" }),
    cacheKey({ ...input, provider: "openai-compatible", model: "model-b" }),
  );
});

test("invalid model JSON is retried once and then fails clearly", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "kalabasa-invalid-json-test-"));
  let calls = 0;
  try {
    await assert.rejects(extractDocumentCached({
      document: "dti_certificate",
      pages: ["Business Name: Sample"],
      method: "text_layer",
      provider: "openai-compatible",
      model: "fake-model",
      apiKey: "fake-key",
      baseUrl: "https://provider.invalid/v1",
      live: true,
      liveFile: path.join(temp, "live.json"),
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: "not JSON" } }] }), { status: 200 });
      },
      sleep: async () => {},
    }), /not valid JSON/i);
    assert.equal(calls, 2);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("HTTP error retries stop after four requests, including the contract retry", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "kalabasa-http-retry-test-"));
  let calls = 0;
  try {
    await assert.rejects(extractDocumentCached({
      document: "dti_certificate",
      pages: ["Business Name: Sample"],
      method: "text_layer",
      provider: "openai-compatible",
      model: "fake-model",
      apiKey: "fake-key",
      baseUrl: "https://provider.invalid/v1",
      live: true,
      liveFile: path.join(temp, "live.json"),
      fetchImpl: async () => {
        calls += 1;
        return new Response("still rate limited", { status: 429, headers: { "retry-after": "0" } });
      },
      sleep: async () => {},
    }), /HTTP 429/i);
    assert.equal(calls, 4);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

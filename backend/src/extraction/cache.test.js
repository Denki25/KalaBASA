import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractDocumentCached, seededCacheFile } from "./cache.js";

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
      createClient: () => ({
        messages: {
          async create() {
            modelCalls += 1;
            return { content: [{ type: "text", text: JSON.stringify({ fields: [] }) }] };
          },
        },
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

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, extractDocument } from "kalabasa-contract/extraction.js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const seededCacheFile = path.join(backendRoot, ".cache", "extraction-responses.json");
export const liveResponsesFile = path.join(backendRoot, ".cache", "live-responses.json");

export class DailyExtractionLimitError extends Error {
  constructor() {
    super("Daily extraction limit reached");
    this.status = 429;
  }
}

export function cacheKey({ document, pages, model = DEFAULT_MODEL }) {
  return createHash("sha256")
    .update(JSON.stringify({ document, pages, model }))
    .digest("hex");
}

async function readCache(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeCache(file, cache) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

const cacheWriteQueues = new Map();

async function writeCacheEntry(file, key, entry) {
  const previous = cacheWriteQueues.get(file) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const cache = await readCache(file);
    cache[key] = entry;
    await writeCache(file, cache);
  });
  cacheWriteQueues.set(file, pending);
  try {
    await pending;
  } finally {
    if (cacheWriteQueues.get(file) === pending) cacheWriteQueues.delete(file);
  }
}

export async function extractDocumentCached({
  document,
  pages,
  method,
  model = DEFAULT_MODEL,
  live = false,
  cacheFile = seededCacheFile,
  liveFile = liveResponsesFile,
  apiKey = process.env.ANTHROPIC_API_KEY,
  createClient = (key) => new Anthropic({ apiKey: key }),
  readCacheFile = readCache,
  onModelCall = async () => {},
}) {
  const key = cacheKey({ document, pages, model });
  const selectedCacheFile = live ? liveFile : cacheFile;
  const cache = live ? {} : await readCacheFile(cacheFile);
  const entry = cache[key];

  const client = {
    messages: {
      async create(request) {
        if (!live && !apiKey) {
          if (!entry) {
            throw new Error(`No cached extraction for ${document}; set ANTHROPIC_API_KEY to call Anthropic.`);
          }
          return { content: [{ type: "text", text: entry.text }] };
        }

        if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for live extraction.");
        await onModelCall();
        const response = await createClient(apiKey).messages.create(request);
        const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
        await writeCacheEntry(selectedCacheFile, key, { document, model, text });
        return response;
      },
    },
  };

  return extractDocument({ document, pages, method, client, model });
}

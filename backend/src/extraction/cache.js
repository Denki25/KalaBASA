import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, extractDocument } from "kalabasa-contract/extraction.js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cacheFile = path.join(backendRoot, ".cache", "extraction-responses.json");

export function cacheKey({ document, pages, model = DEFAULT_MODEL }) {
  return createHash("sha256")
    .update(JSON.stringify({ document, pages, model }))
    .digest("hex");
}

async function readCache() {
  try {
    return JSON.parse(await fs.readFile(cacheFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeCache(cache) {
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  const temporary = `${cacheFile}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  await fs.rename(temporary, cacheFile);
}

export async function extractDocumentCached({ document, pages, method, model = DEFAULT_MODEL }) {
  const key = cacheKey({ document, pages, model });
  const cache = await readCache();
  const entry = cache[key];
  const apiKey = process.env.ANTHROPIC_API_KEY;

  const client = {
    messages: {
      async create(request) {
        if (!apiKey) {
          if (!entry) {
            throw new Error(`No cached extraction for ${document}; set ANTHROPIC_API_KEY to call Anthropic.`);
          }
          return { content: [{ type: "text", text: entry.text }] };
        }

        const response = await new Anthropic({ apiKey }).messages.create(request);
        const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
        cache[key] = { document, model, text };
        await writeCache(cache);
        return response;
      },
    },
  };

  return extractDocument({ document, pages, method, client, model });
}

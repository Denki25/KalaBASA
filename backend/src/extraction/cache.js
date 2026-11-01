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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RETRY_STATUSES = new Set([429, 500, 503, 504]);

// Calls the Gemini REST API. On temporary errors (too many requests, server busy),
// wait and try again, up to 4 tries.
async function callGemini({ apiKey, model, request }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: request.system }] },
    contents: [{ role: "user", parts: [{ text: request.messages[0].content }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 4096,
      responseMimeType: "application/json",
    },
  });

  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body,
    });
    if (res.ok) {
      const data = await res.json();
      return (data.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
    }
    lastError = new Error(`Gemini request failed (${res.status}): ${await res.text()}`);
    if (!RETRY_STATUSES.has(res.status)) throw lastError;
    await sleep(5000 * 2 ** attempt); // 5s, 10s, 20s
  }
  throw lastError;
}

function isValidJson(text) {
  try {
    JSON.parse(text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim());
    return true;
  } catch {
    return false;
  }
}

export async function extractDocumentCached({ document, pages, method, model = DEFAULT_MODEL }) {
  const key = cacheKey({ document, pages, model });
  const cache = await readCache();
  const entry = cache[key];
  const apiKey = process.env.GEMINI_API_KEY;

  const client = {
    messages: {
      async create(request) {
        // 1. Use the saved answer if we already have one.
        if (entry) return { content: [{ type: "text", text: entry.text }] };

        // 2. No saved answer and no key: we cannot continue.
        if (!apiKey) {
          throw new Error(`No cached extraction for ${document}; set GEMINI_API_KEY to call Gemini.`);
        }

        // 3. Ask Gemini, and save the answer only if it is valid JSON.
        const text = await callGemini({ apiKey, model, request });
        if (isValidJson(text)) {
          cache[key] = { document, model, text };
          await writeCache(cache);
        }
        return { content: [{ type: "text", text }] };
      },
    },
  };

  return extractDocument({ document, pages, method, client, model });
}
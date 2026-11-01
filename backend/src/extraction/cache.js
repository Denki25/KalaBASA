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

export function getLlmConfig(env = process.env) {
  const provider = env.LLM_PROVIDER || "anthropic";
  if (!new Set(["anthropic", "openai-compatible"]).has(provider)) {
    throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
  }
  const model = provider === "openai-compatible"
    ? env.LLM_MODEL || ""
    : env.KALABASA_MODEL || DEFAULT_MODEL;
  return {
    provider,
    model,
    apiKey: provider === "openai-compatible" ? env.LLM_API_KEY : env.ANTHROPIC_API_KEY,
    baseUrl: env.LLM_BASE_URL,
  };
}

export function cacheKey({ document, pages, model = DEFAULT_MODEL, provider = "anthropic" }) {
  return createHash("sha256")
    .update(JSON.stringify({ document, pages, provider, model }))
    .digest("hex");
}

function legacyAnthropicCacheKey({ document, pages, model }) {
  return createHash("sha256")
    .update(JSON.stringify({ document, pages, model }))
    .digest("hex");
}

function retryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function extractText(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? "").join("");
  throw new Error("LLM response did not contain message text.");
}

export function normalizeModelJson(text) {
  const withoutFences = text.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    return JSON.stringify(JSON.parse(withoutFences));
  } catch {
    const firstBrace = withoutFences.indexOf("{");
    const lastBrace = withoutFences.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.stringify(JSON.parse(withoutFences.slice(firstBrace, lastBrace + 1)));
      } catch {
        // The contract extractor makes one more model attempt, then returns its clear parse error.
      }
    }
  }
  throw new Error("Model response was not valid JSON after removing code fences and surrounding text.");
}

const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createLlmClient({
  provider,
  apiKey,
  baseUrl,
  fetchImpl = fetch,
  anthropicClientFactory = (key) => new Anthropic({ apiKey: key, maxRetries: 0 }),
  sleep = defaultSleep,
  onModelCall = async () => {},
}) {
  let httpAttempts = 0;
  let terminalHttpError = null;
  if (provider === "anthropic") {
    const anthropic = anthropicClientFactory(apiKey);
    return {
      messages: {
        async create(request) {
          if (terminalHttpError) throw terminalHttpError;
          let response;
          while (httpAttempts < 4) {
            await onModelCall();
            httpAttempts += 1;
            try {
              response = await anthropic.messages.create(request);
              break;
            } catch (error) {
              const status = error.status ?? error.statusCode;
              const retryable = status === 429 || status >= 500;
              if (!retryable || httpAttempts === 4) {
                terminalHttpError = error;
                throw error;
              }
              const headerValue = error.headers?.get?.("retry-after") ?? error.headers?.["retry-after"];
              await sleep(retryAfterMs(headerValue) ?? 250 * 2 ** (httpAttempts - 1));
            }
          }
          if (!response) throw terminalHttpError ?? new Error("LLM request failed after four attempts.");
          const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
          return { ...response, content: [{ type: "text", text: normalizeModelJson(text) }] };
        },
      },
    };
  }
  if (provider !== "openai-compatible") throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
  if (!baseUrl) throw new Error("LLM_BASE_URL is required for the openai-compatible provider.");
  if (!apiKey) throw new Error("LLM_API_KEY is required for the openai-compatible provider.");

  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    messages: {
      async create(request) {
        if (!request.model) throw new Error("LLM_MODEL is required for the openai-compatible provider.");
        if (terminalHttpError) throw terminalHttpError;
        const messages = [];
        if (request.system) messages.push({ role: "system", content: request.system });
        messages.push(...request.messages);
        let response;
        while (httpAttempts < 4) {
          await onModelCall();
          httpAttempts += 1;
          response = await fetchImpl(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ model: request.model, max_tokens: request.max_tokens, messages }),
          });
          if (response.ok) break;
          const retryable = response.status === 429 || response.status >= 500;
          if (!retryable || httpAttempts === 4) {
            const detail = await response.text().catch(() => "");
            terminalHttpError = new Error(`LLM request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
            throw terminalHttpError;
          }
          const delay = retryAfterMs(response.headers.get("retry-after")) ?? 250 * 2 ** (httpAttempts - 1);
          await sleep(delay);
        }

        const payload = await response.json();
        const text = normalizeModelJson(extractText(payload));
        return { content: [{ type: "text", text }] };
      },
    },
  };
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
  model,
  provider,
  live = false,
  cacheFile = seededCacheFile,
  liveFile = liveResponsesFile,
  apiKey,
  baseUrl,
  clientFactory = createLlmClient,
  fetchImpl,
  sleep,
  anthropicClientFactory,
  readCacheFile = readCache,
  onModelCall = async () => {},
}) {
  const config = getLlmConfig();
  provider ??= config.provider;
  model ??= config.model;
  apiKey ??= config.apiKey;
  baseUrl ??= config.baseUrl;
  const key = cacheKey({ document, pages, model, provider });
  const selectedCacheFile = live ? liveFile : cacheFile;
  const cache = live ? {} : await readCacheFile(cacheFile);
  const entry = cache[key] ?? (provider === "anthropic"
    ? cache[legacyAnthropicCacheKey({ document, pages, model })]
    : undefined);
  let providerClient;

  const client = {
    messages: {
      async create(request) {
        if (!live && !apiKey) {
          if (!entry) {
            const keyName = provider === "openai-compatible" ? "LLM_API_KEY" : "ANTHROPIC_API_KEY";
            throw new Error(`No cached extraction for ${document}; set ${keyName} to call the configured provider.`);
          }
          return { content: [{ type: "text", text: entry.text }] };
        }

        if (!apiKey) throw new Error(`${provider === "openai-compatible" ? "LLM_API_KEY" : "ANTHROPIC_API_KEY"} is required for live extraction.`);
        providerClient ??= clientFactory({
          provider,
          apiKey,
          baseUrl,
          fetchImpl,
          sleep,
          anthropicClientFactory,
          onModelCall,
        });
        const response = await providerClient.messages.create(request);
        const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
        await writeCacheEntry(selectedCacheFile, key, { document, provider, model, text });
        return response;
      },
    },
  };

  try {
    return await extractDocument({ document, pages, method, client, model });
  } catch (error) {
    if (error.message?.includes("Daily extraction limit reached")) throw new DailyExtractionLimitError();
    throw error;
  }
}

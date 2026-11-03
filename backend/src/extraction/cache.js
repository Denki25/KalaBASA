import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, extractDocument } from "kalabasa-contract/extraction.js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
export const seededCacheFile = path.join(backendRoot, ".cache", "extraction-responses.json");
export const liveResponsesFile = path.join(backendRoot, ".cache", "live-responses.json");

export class DailyExtractionLimitError extends Error {
  constructor() {
    super("Daily extraction limit reached");
    this.status = 429;
  }
}

export function getLlmConfig(env = process.env) {
  const provider = env.LLM_PROVIDER || "gemini";
  if (!new Set(["anthropic", "gemini", "openai-compatible"]).has(provider)) {
    throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
  }
  const model = provider === "openai-compatible"
    ? env.LLM_MODEL || ""
    : env.KALABASA_MODEL || (provider === "gemini" ? DEFAULT_GEMINI_MODEL : DEFAULT_MODEL);
  return {
    provider,
    model,
    apiKey: provider === "openai-compatible"
      ? env.LLM_API_KEY
      : provider === "gemini" ? env.GEMINI_API_KEY : env.ANTHROPIC_API_KEY,
    baseUrl: env.LLM_BASE_URL,
  };
}

export function cacheKey({ document, pages, model, provider } = {}) {
  const config = getLlmConfig();
  model ??= config.model;
  provider ??= config.provider;
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

function extractGeminiText(response) {
  const text = (response?.steps ?? [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
  if (text) return text;
  if (typeof response?.output_text === "string") return response.output_text;
  throw new Error("Gemini response did not contain model text.");
}

function retryDelayFromBody(body) {
  try {
    const payload = JSON.parse(body);
    const info = payload?.error?.details?.find((detail) => detail["@type"]?.endsWith(".RetryInfo"));
    return retryAfterMs(info?.retryDelay ?? payload?.error?.retryDelay);
  } catch {
    return null;
  }
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
  requestTimeoutMs = Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? 60000),
}) {
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("LLM_REQUEST_TIMEOUT_MS must be a positive number of milliseconds.");
  }
  let httpAttempts = 0;
  let terminalHttpError = null;
  if (provider === "gemini") {
    if (!apiKey) throw new Error("GEMINI_API_KEY is required for the gemini provider.");
    return {
      messages: {
        async create(request) {
          if (!request.model) throw new Error("KALABASA_MODEL is required for the gemini provider.");
          if (terminalHttpError) throw terminalHttpError;
          let response;
          let payload;
          while (httpAttempts < 4) {
            await onModelCall();
            httpAttempts += 1;
            try {
              response = await fetchImpl("https://generativelanguage.googleapis.com/v1beta/interactions", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-goog-api-key": apiKey,
                },
                body: JSON.stringify({
                  model: request.model,
                  system_instruction: request.system,
                  input: request.messages.map((message) => message.content).join("\n\n"),
                  response_format: { type: "text", mime_type: "application/json" },
                  generation_config: {
                    max_output_tokens: request.max_tokens,
                    thinking_level: process.env.GEMINI_THINKING_LEVEL || "minimal",
                  },
                }),
                signal: AbortSignal.timeout(requestTimeoutMs),
              });
              if (response.ok) {
                payload = await response.json();
                break;
              }
            } catch (error) {
              const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
              const networkFailure = error instanceof TypeError || ["ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(error.cause?.code);
              if (!timedOut && !networkFailure) throw error;
              if (httpAttempts === 4) {
                terminalHttpError = new Error(`Gemini ${timedOut ? "timed out" : "could not be reached"} after four attempts. Please retry when the connection or AI service recovers.`, { cause: error });
                throw terminalHttpError;
              }
              await sleep(250 * 2 ** (httpAttempts - 1));
              continue;
            }
            const detail = await response.text().catch(() => "");
            const retryable = response.status === 429 || response.status >= 500;
            if (!retryable || httpAttempts === 4) {
              terminalHttpError = new Error(`Gemini request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
              throw terminalHttpError;
            }
            const delay = retryAfterMs(response.headers.get("retry-after"))
              ?? retryDelayFromBody(detail)
              ?? 250 * 2 ** (httpAttempts - 1);
            await sleep(delay);
          }
          return { content: [{ type: "text", text: normalizeModelJson(extractGeminiText(payload)) }] };
        },
      },
    };
  }
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

const apiKeyName = (provider) => provider === "openai-compatible"
  ? "LLM_API_KEY"
  : provider === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY";

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
  // Keep responses from real provider calls out of the checked-in sample cache.
  // Custom cache paths remain useful for isolated tests and local tooling.
  const writesToLiveCache = live || (Boolean(apiKey) && cacheFile === seededCacheFile);
  const selectedCacheFile = writesToLiveCache ? liveFile : cacheFile;
  const cacheFiles = live ? [] : [...new Set([cacheFile, liveFile])];
  const cacheContent = new Map(await Promise.all(cacheFiles.map(async (file) => [file, await readCacheFile(file)])));
  // Seeded sample answers take precedence over prior live responses when both match.
  const cache = live ? {} : Object.assign({}, cacheContent.get(liveFile), cacheContent.get(cacheFile));
  const entry = cache[key] ?? (provider === "anthropic"
    ? cache[legacyAnthropicCacheKey({ document, pages, model })]
    : undefined);
  let providerClient;

  const client = {
    messages: {
      async create(request) {
        if (!live && entry) {
          return { content: [{ type: "text", text: entry.text }] };
        }

        if (!apiKey) {
          if (!entry) {
            const keyName = apiKeyName(provider);
            const reason = live ? `${keyName} is required for live extraction.` : `No cached extraction for ${document}; set ${keyName} to call the configured provider.`;
            throw new Error(reason);
          }
          return { content: [{ type: "text", text: entry.text }] };
        }
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

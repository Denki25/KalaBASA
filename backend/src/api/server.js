import { createApp } from "./app.js";
import { createStore, getSupabaseConfig } from "./store.js";
import { createSupabaseAuth } from "./auth.js";
import { createSupabaseStorage } from "./documents.js";
import { createClient } from "@supabase/supabase-js";
import { Application } from "kalabasa-contract/schemas.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../");
const fixturesDirectory = path.join(repoRoot, "contract", "fixtures");
const fixtureNames = (await fs.readdir(fixturesDirectory)).filter((name) => name.endsWith(".json"));
const fixtures = await Promise.all(fixtureNames.map(async (name) =>
  Application.parse(JSON.parse(await fs.readFile(path.join(fixturesDirectory, name), "utf8")))));
const supabaseConfig = getSupabaseConfig();
const partialSupabaseConfig = !supabaseConfig.enabled && Boolean(supabaseConfig.missing);
const demoMode = process.env.AUTH_DISABLED === "true";
if (demoMode && partialSupabaseConfig) {
  console.warn(`WARNING: Supabase is being ignored because ${supabaseConfig.missing} is missing. Set both Supabase variables or clear both to use local demo storage.`);
}
const store = createStore(fixtures, demoMode && partialSupabaseConfig
  ? { ...process.env, SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "" }
  : process.env);
const port = Number(process.env.PORT ?? 3000);

let auth = null;
if (demoMode) {
  console.warn("WARNING: AUTH_DISABLED=true. Anyone can use the API without logging in. Use this for local demos only.");
} else {
  try {
    auth = createSupabaseAuth({
      url: process.env.SUPABASE_URL,
      publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
      serviceKey: process.env.SUPABASE_SERVICE_KEY,
    });
  } catch (error) {
    console.error(`Cannot start: ${error.message}`);
    console.error("Add them to .env, or set AUTH_DISABLED=true for a local demo without login.");
    process.exit(1);
  }
}

// With Supabase settings, documents go to the private bucket. Without them, they stay on this computer.
let fileStorage;
if (supabaseConfig.enabled && !(demoMode && partialSupabaseConfig)) {
  const client = createClient(supabaseConfig.url, supabaseConfig.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  fileStorage = createSupabaseStorage(client);
  console.log("Documents are stored in the private Supabase bucket.");
} else {
  console.warn("WARNING: Supabase is not set up, so uploaded documents are saved on this computer only (backend/.cache/uploads).");
}
const app = createApp({ store, auth, ...(fileStorage ? { fileStorage } : {}) });

app.listen(port, () => {
  console.log(`KalaBASA API listening on http://localhost:${port} (MOCK_MODE=${process.env.MOCK_MODE === "true"}, LLM_PROVIDER=${process.env.LLM_PROVIDER || "gemini"}, KALABASA_MODEL=${process.env.KALABASA_MODEL || "gemini-3.5-flash-lite"})`);
});

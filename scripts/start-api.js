import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(repoRoot, ".env");

// Local mode flags in .env are authoritative so stale shell values cannot
// silently turn authentication or real extraction off.
if (fs.existsSync(envFile)) {
  const localEnv = parseEnv(fs.readFileSync(envFile, "utf8"));
  for (const name of ["AUTH_DISABLED", "MOCK_MODE"]) {
    if (localEnv[name] !== undefined) process.env[name] = localEnv[name];
  }
}

await import("../backend/src/api/server.js");

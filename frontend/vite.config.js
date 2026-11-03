import path from "node:path";
import fs from "node:fs";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const frontendDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(frontendDirectory, "..");

export default defineConfig(({ mode }) => {
  const localEnvFile = path.join(repositoryRoot, ".env");
  if (fs.existsSync(localEnvFile)) {
    const localEnv = parseEnv(fs.readFileSync(localEnvFile, "utf8"));
    for (const name of ["AUTH_DISABLED", "MOCK_MODE"]) {
      if (localEnv[name] !== undefined) process.env[name] = localEnv[name];
    }
  }
  const env = loadEnv(mode, repositoryRoot, "");
  return {
    plugins: [react()],
    define: {
      "import.meta.env.MOCK_MODE": JSON.stringify(env.MOCK_MODE === "true"),
      "import.meta.env.AUTH_DISABLED": JSON.stringify(env.AUTH_DISABLED === "true"),
    },
    server: {
      allowedHosts: [".ngrok-free.dev"],
      proxy: {
        "/api": "http://localhost:3000",
      },
    },
  };
});

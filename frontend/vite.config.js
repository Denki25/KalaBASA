import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const frontendDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(frontendDirectory, "..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repositoryRoot, "");
  return {
    plugins: [react()],
    define: {
      "import.meta.env.MOCK_MODE": JSON.stringify(env.MOCK_MODE === "true"),
    },
    server: {
      proxy: {
        "/api": "http://localhost:3000",
      },
    },
  };
});

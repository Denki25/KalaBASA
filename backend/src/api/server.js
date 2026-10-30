import { createApp } from "./app.js";
import { createStore } from "./store.js";
import { Application } from "kalabasa-contract/schemas.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../");
const fixturesDirectory = path.join(repoRoot, "contract", "fixtures");
const fixtureNames = (await fs.readdir(fixturesDirectory)).filter((name) => name.endsWith(".json"));
const fixtures = await Promise.all(fixtureNames.map(async (name) =>
  Application.parse(JSON.parse(await fs.readFile(path.join(fixturesDirectory, name), "utf8")))));
const store = createStore(fixtures);
const port = Number(process.env.PORT ?? 3000);
const app = createApp({ store });

app.listen(port, () => {
  console.log(`KalaBASA API listening on http://localhost:${port} (MOCK_MODE=${process.env.MOCK_MODE === "true"})`);
});

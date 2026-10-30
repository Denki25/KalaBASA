import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL } from "kalabasa-contract/extraction.js";
import { cacheKey } from "./cache.js";
import { readPdfPages } from "./pdf.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const samplesRoot = path.join(repoRoot, "samples");
const cachePath = path.join(repoRoot, "backend", ".cache", "extraction-responses.json");
const cache = {};

for (const setName of (await fs.readdir(samplesRoot)).filter((name) => /^set_0[1-5]/.test(name)).sort()) {
  const setPath = path.join(samplesRoot, setName);
  const expected = JSON.parse(await fs.readFile(path.join(setPath, "expected.json"), "utf8"));
  const files = (await fs.readdir(setPath)).filter((name) => name.toLowerCase().endsWith(".pdf"));

  for (const filename of files) {
    const document = path.basename(filename, path.extname(filename));
    const { pages } = await readPdfPages(path.join(setPath, filename));
    const fields = expected.extracted_fields
      .filter((field) => field.document === document)
      .map(({ field, value, page, source_text }) => ({
        field,
        value,
        page,
        source_text,
        confidence: "high",
      }));
    cache[cacheKey({ document, pages, model: DEFAULT_MODEL })] = {
      document,
      model: DEFAULT_MODEL,
      text: JSON.stringify({ fields }),
      source: "sample ground truth",
    };
  }
}

await fs.mkdir(path.dirname(cachePath), { recursive: true });
await fs.writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
console.log(`Seeded ${Object.keys(cache).length} offline sample responses at ${cachePath}`);

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractDocumentCached } from "./cache.js";
import { readPdfPages } from "./pdf.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const samplesRoot = path.join(repoRoot, "samples");
const sets = (await fs.readdir(samplesRoot))
  .filter((name) => /^set_0[1-5]/.test(name))
  .sort();
let total = 0;
let passed = 0;

for (const setName of sets) {
  const setPath = path.join(samplesRoot, setName);
  const expected = JSON.parse(await fs.readFile(path.join(setPath, "expected.json"), "utf8"));
  const files = (await fs.readdir(setPath)).filter((name) => name.toLowerCase().endsWith(".pdf"));
  const extracted = [];

  for (const filename of files) {
    const document = path.basename(filename, path.extname(filename));
    const { pages, method } = await readPdfPages(path.join(setPath, filename));
    extracted.push(...await extractDocumentCached({ document, pages, method }));
  }

  console.log(`\n${setName}`);
  for (const field of expected.extracted_fields) {
    total++;
    const actual = extracted.find((item) => item.document === field.document && item.field === field.field);
    const isMatch = actual
      && actual.value === field.value
      && actual.page === field.page
      && actual.source_text === field.source_text;
    if (isMatch) passed++;
    else {
      console.error(`FAIL ${field.document}.${field.field}: expected ${JSON.stringify(field.value)}, got ${JSON.stringify(actual?.value ?? null)}`);
    }
    console.log(`${isMatch ? "PASS" : "FAIL"} ${field.document}.${field.field}`);
  }
}

const accuracy = total === 0 ? 100 : (passed / total) * 100;
console.log(`\nExtraction accuracy: ${passed}/${total} (${accuracy.toFixed(2)}%)`);
assert.equal(passed, total, "One or more extracted fields differ from expected.json");

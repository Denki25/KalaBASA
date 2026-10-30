import fs from "node:fs/promises";
import path from "node:path";
import { DocumentType } from "kalabasa-contract/schemas.js";
import { extractDocumentCached } from "./cache.js";
import { readPdfPages } from "./pdf.js";

const directory = process.argv[2];
if (!directory) {
  throw new Error("Usage: node backend/src/extraction/run.js <folder containing one PDF per document>");
}

const files = (await fs.readdir(directory))
  .filter((name) => name.toLowerCase().endsWith(".pdf"))
  .sort();
if (files.length === 0) throw new Error(`No PDF files found in ${directory}`);

for (const filename of files) {
  const document = DocumentType.parse(path.basename(filename, path.extname(filename)));
  const { pages, method } = await readPdfPages(path.join(directory, filename));
  const fields = await extractDocumentCached({ document, pages, method });
  console.log(`\n${filename} (${method})`);
  console.table(fields.map(({ field, value, verified }) => ({
    field,
    value: value ?? "null",
    verified,
  })));
}

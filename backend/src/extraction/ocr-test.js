import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PdfPageLimitError, readPdfPages } from "./pdf.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scannedDirectory = path.join(repoRoot, "samples", "ocr_fallback_test");
const names = [
  "set_01_barangay_clearance_SCANNED.pdf",
  "set_01_community_tax_certificate_SCANNED.pdf",
];

for (const name of names) {
  const pdfPath = path.join(scannedDirectory, name);
  const { pages, method } = await readPdfPages(pdfPath);
  assert.equal(method, "ocr", `${name} should use OCR`);
  assert.ok(pages.every((page) => page.length > 0), `${name} OCR should return page text`);
  console.log(`PASS ${name}: OCR returned ${pages.length} page(s)`);
  await assert.rejects(readPdfPages(pdfPath, { maxPages: 0 }), PdfPageLimitError);
}
console.log("PASS PDF page limit returns a clear client error");

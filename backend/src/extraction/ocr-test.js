import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { readDocumentPages, readPdfPages } from "./pdf.js";
import { buildScanPdf } from "../../../frontend/src/scanner/scanner-utils.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scannedDirectory = path.join(repoRoot, "samples", "ocr_fallback_test");
const names = [
  "set_01_barangay_clearance_SCANNED.pdf",
  "set_01_community_tax_certificate_SCANNED.pdf",
];

for (const name of names) {
  const { pages, method } = await readPdfPages(path.join(scannedDirectory, name));
  assert.equal(method, "ocr", `${name} should use OCR`);
  assert.ok(pages.every((page) => page.length > 0), `${name} OCR should return page text`);
  console.log(`PASS ${name}: OCR returned ${pages.length} page(s)`);
}

const imageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "kalabasa-image-ocr-"));
try {
  for (const [extension, format] of [[".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".png", "image/png"]]) {
    const canvas = createCanvas(1200, 260);
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, 1200, 260);
    context.fillStyle = "black";
    context.font = "bold 72px Arial";
    context.fillText("BUSINESS PERMIT APPLICATION", 40, 150);
    const filename = path.join(imageDirectory, `document${extension}`);
    await fs.writeFile(filename, canvas.toBuffer(format));
    const { pages, method } = await readDocumentPages(filename);
    assert.equal(method, "ocr");
    assert.equal(pages.length, 1);
    assert.match(pages[0].toUpperCase(), /BUSINESS/);
    console.log(`PASS ${extension}: direct image OCR returned page text`);
  }

  const scanPages = [];
  for (const phrase of ["SCANNED PAGE ALPHA", "SCANNED PAGE BRAVO"]) {
    const canvas = createCanvas(1500, 300);
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, 1500, 300);
    context.fillStyle = "black";
    context.font = "bold 100px Arial";
    context.fillText(phrase, 50, 180);
    const jpeg = canvas.toBuffer("image/jpeg", 90);
    scanPages.push({ width: 1500, height: 300, bytes: new Uint8Array(jpeg) });
  }
  const scanPdf = await buildScanPdf(scanPages);
  const scanPdfPath = path.join(imageDirectory, "ordered-camera-scan.pdf");
  await fs.writeFile(scanPdfPath, Buffer.from(await scanPdf.arrayBuffer()));
  const { pages, method } = await readPdfPages(scanPdfPath);
  assert.equal(method, "ocr");
  assert.equal(pages.length, 2, "each captured page should remain a separate PDF extraction page");
  assert.match(pages[0].toUpperCase(), /ALPHA/);
  assert.match(pages[1].toUpperCase(), /BRAVO/);
  console.log("PASS multi-page camera scan: OCR preserved page order and page references");
} finally {
  await fs.rm(imageDirectory, { recursive: true, force: true });
}

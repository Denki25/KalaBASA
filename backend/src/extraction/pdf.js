import { createCanvas } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createWorker } from "tesseract.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const isSparse = (text) => text.replace(/\s/g, "").length < 24;

async function renderPage(page) {
  const scale = 2;
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext("2d");
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  return canvas.toBuffer("image/png");
}

export async function readPdfPages(file) {
  const data = new Uint8Array(await import("node:fs/promises").then(({ readFile }) => readFile(file)));
  const pdf = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const pages = [];
  const sparsePages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ").trim();
    pages.push(text);
    if (isSparse(text)) sparsePages.push({ pageNumber, page });
  }

  if (sparsePages.length === 0) return { pages, method: "text_layer" };

  const worker = await createWorker("eng", undefined, {
    cachePath: path.join(backendRoot, ".cache", "tesseract"),
  });
  try {
    for (const { pageNumber, page } of sparsePages) {
      const image = await renderPage(page);
      const result = await worker.recognize(image);
      pages[pageNumber - 1] = result.data.text.trim();
    }
  } finally {
    await worker.terminate();
  }

  return { pages, method: "ocr" };
}

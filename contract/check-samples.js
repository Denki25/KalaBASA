// Runs every ground-truth field through verifyField() against real PDF text (needs `pdftotext` from poppler).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { verifyField } from "./extraction.js";

const root = process.argv[2] || "../kalabasa_sample_data";
const pdfPages = (file) => {
  const n = Number(execFileSync("sh", ["-c", `pdfinfo "${file}" | awk '/^Pages/{print $2}'`]).toString());
  return Array.from({ length: n }, (_, i) => execFileSync("pdftotext", ["-f", i + 1, "-l", i + 1, "-layout", file, "-"]).toString());
};
let total = 0, bad = 0;
for (const dir of fs.readdirSync(root).filter((d) => d.startsWith("set_")).sort()) {
  const exp = JSON.parse(fs.readFileSync(path.join(root, dir, "expected.json"), "utf8"));
  const cache = {};
  for (const f of exp.extracted_fields) {
    cache[f.document] ??= pdfPages(path.join(root, dir, `${f.document}.pdf`));
    const r = verifyField(f, cache[f.document]);
    total++;
    if (!r.verified) { bad++; console.log("FAIL", dir, f.document, f.field, JSON.stringify(f.source_text)); }
  }
}
console.log(`${total - bad}/${total} fields verified against real PDF text`);

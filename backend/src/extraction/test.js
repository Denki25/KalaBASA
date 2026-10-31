import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL } from "kalabasa-contract/extraction.js";
import { extractDocumentCached } from "./cache.js";
import { readPdfPages } from "./pdf.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const samplesRoot = path.join(repoRoot, "samples");
const live = process.argv.includes("--live");
const marker = "CACHED/SEEDED ANSWERS - NOT LIVE AI ACCURACY";
const model = process.env.KALABASA_MODEL || DEFAULT_MODEL;

if (live && !process.env.ANTHROPIC_API_KEY) {
  console.error("Cannot run live extraction: ANTHROPIC_API_KEY is not set.");
  process.exitCode = 1;
} else {
  if (!live) console.log(marker);
  let failed = false;
  try {
    const sets = (await fs.readdir(samplesRoot)).filter((name) => /^set_0[1-5]/.test(name)).sort();
    const documents = new Map();
    let total = 0;
    let passed = 0;
    let unverified = 0;
    const results = new Map();

    if (live) console.log(`Live extraction model: ${model}`);
    for (const setName of sets) {
      const setPath = path.join(samplesRoot, setName);
      const expected = JSON.parse(await fs.readFile(path.join(setPath, "expected.json"), "utf8"));
      const files = (await fs.readdir(setPath)).filter((name) => name.toLowerCase().endsWith(".pdf")).sort();
      const extracted = [];

      for (const filename of files) {
        const document = path.basename(filename, path.extname(filename));
        const { pages, method } = await readPdfPages(path.join(setPath, filename));
        extracted.push(...await extractDocumentCached({ document, pages, method, model, live }));
      }
      results.set(setName, { expected, fields: extracted });
      unverified += extracted.filter((field) => field.verified === false).length;
      console.log(`\n${setName}`);
      for (const field of expected.extracted_fields) {
        total += 1;
        const actual = extracted.find((item) => item.document === field.document && item.field === field.field);
        const expectedPresence = field.value !== null ? "printed" : field.source_text ? "blank_printed" : "not_found";
        const isMatch = actual
          && actual.value === field.value
          && actual.page === field.page
          && actual.source_text === field.source_text
          && actual.presence === expectedPresence;
        const documentStats = documents.get(field.document) ?? { total: 0, passed: 0 };
        documentStats.total += 1;
        if (isMatch) {
          passed += 1;
          documentStats.passed += 1;
        } else {
          failed = true;
          console.error(`${setName} / ${field.document} / ${field.field}: expected ${JSON.stringify(field.value)}, got ${JSON.stringify(actual?.value ?? null)}`);
        }
        documents.set(field.document, documentStats);
      }
    }

    const accuracy = total === 0 ? 100 : passed / total * 100;
    console.log(`\nAccuracy: ${passed}/${total} (${accuracy.toFixed(2)}%)`);
    console.log(`Fields with verified=false: ${unverified}`);
    console.log("Per-document accuracy:");
    for (const [document, result] of [...documents].sort(([left], [right]) => left.localeCompare(right))) {
      console.log(`  ${document}: ${result.passed}/${result.total} (${(result.passed / result.total * 100).toFixed(2)}%)`);
    }

    if (live) {
      const lookup = (set, document, field) => results.get(set)?.fields.find((item) => item.document === document && item.field === field)?.value;
      const expectedValue = (set, document, field) => results.get(set)?.expected.extracted_fields.find((item) => item.document === document && item.field === field)?.value;
      const checks = [
        ["set 05 lease notarization_date is null", lookup("set_05_demo_story", "lease_contract", "notarization_date") === null],
        ["set 05 lease address is the leased premises", (() => {
          const address = lookup("set_05_demo_story", "lease_contract", "business_address");
          const residence = expectedValue("set_05_demo_story", "application_form", "owner_residence_address");
          return typeof address === "string" && address.includes("22 Del Pilar") && address !== residence;
        })()],
        ["set 02 lease address contains 54 while application form contains 45", String(lookup("set_02_address_mismatch", "lease_contract", "business_address") ?? "").includes("54") && String(lookup("set_02_address_mismatch", "application_form", "business_address") ?? "").includes("45")],
        ["set 04 owner names are copied as printed", (() => {
          const item = results.get("set_04_formatting_only");
          return item?.expected.extracted_fields.filter((field) => field.field === "owner_name").every((field) => lookup("set_04_formatting_only", field.document, field.field) === field.value) ?? false;
        })()],
        ["set 03 has no barangay_clearance", !results.get("set_03_missing_document")?.fields.some((field) => field.document === "barangay_clearance")],
      ];
      for (const [label, passedCheck] of checks) {
        console.log(`${passedCheck ? "PASS" : "FAIL"} ${label}`);
        if (!passedCheck) failed = true;
      }
    }
  } catch (error) {
    failed = true;
    console.error(error.message);
  } finally {
    if (!live) console.log(marker);
  }
  if (failed) process.exitCode = 1;
}

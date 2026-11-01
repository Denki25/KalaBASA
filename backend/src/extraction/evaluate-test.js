import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { evaluate, formatReport, normalize, scoreField, summarize } from "./evaluate.js";
import { readPdfPages } from "./pdf.js";

const samplesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../samples");
const expectedBySet = {};
for (const name of await fs.readdir(samplesRoot)) {
  if (/^set_0[1-5]/.test(name)) expectedBySet[name] = JSON.parse(await fs.readFile(path.join(samplesRoot, name, "expected.json"), "utf8"));
}

// A pretend AI that returns the answers from expected.json, with optional damage.
function makeHarness(damage = () => null) {
  let currentSet = "";
  const readPdf = async (file) => {
    currentSet = path.basename(path.dirname(file));
    if (currentSet === "ocr_fallback_test") return { pages: ["scanned text"], method: "ocr" };
    return readPdfPages(file);
  };
  const extract = async ({ document }) => {
    const source = expectedBySet[currentSet === "ocr_fallback_test" ? "set_01_clean" : currentSet];
    const failure = damage({ set: currentSet, document, phase: "document" });
    if (failure?.throw) throw new Error(failure.throw);
    return source.extracted_fields.filter((field) => field.document === document).map((field) => {
      const base = {
        ...field,
        presence: field.value !== null ? "printed" : field.source_text ? "blank_printed" : "not_found",
        confidence: "high", verified: field.value !== null, match: "exact", method: "text_layer",
      };
      const change = damage({ set: currentSet, document, field: field.field, phase: "field" });
      return change ? { ...base, ...change } : base;
    });
  };
  return { readPdf, extract };
}

test("normalize ignores case, punctuation and spacing", () => {
  assert.equal(normalize("  Santos,  Maria-Teresa "), "santos maria teresa");
  assert.equal(normalize(null), null);
});

test("scoreField sorts every kind of mistake", () => {
  const expected = { document: "d", field: "f", value: "ABC 123", page: 1, source_text: "ABC 123" };
  const printed = (value) => ({ value, page: 1, source_text: "ABC 123", presence: "printed", verified: true });
  assert.equal(scoreField(expected, printed("ABC 123")).category, "correct");
  assert.equal(scoreField(expected, printed("abc-123")).category, "formatting_only");
  assert.equal(scoreField(expected, printed("XYZ 999")).category, "wrong_value");
  assert.equal(scoreField(expected, undefined).category, "missed");
  assert.equal(scoreField({ ...expected, value: null, source_text: null }, printed("made up")).category, "invented");
  assert.equal(scoreField({ ...expected, value: null, source_text: null }, { value: null, presence: "not_found" }).strict, true);
});

test("a perfect AI scores 100% with no false alarms on every sample set", async () => {
  const { readPdf, extract } = makeHarness();
  const result = await evaluate({ samplesRoot, readPdf, extract });
  const summary = summarize(result);
  assert.equal(result.sets.length, 5);
  assert.equal(summary.correct, summary.fields_checked);
  assert.equal(summary.strict, summary.fields_checked);
  assert.equal(summary.findings.false_positive, 0, JSON.stringify(result.sets.map((s) => s.findings.false_positive)));
  assert.equal(summary.findings.false_negative, 0, JSON.stringify(result.sets.map((s) => s.findings.false_negative)));
  assert.ok(summary.findings.true_positive >= 3);
  assert.equal(result.ocr.length, 2);
  assert.equal(summary.ocr_correct, summary.ocr_fields_checked);
  assert.match(formatReport(result), /Overall results/);
});

test("mistakes are counted and cause false alarms or missed findings", async () => {
  const { readPdf, extract } = makeHarness(({ set, document, field, phase }) => {
    if (phase !== "field" || set !== "set_01_clean") return null;
    if (document === "dti_certificate" && field === "business_address") return { value: "999 Wrong Street" }; // causes a false alarm
    if (document === "lease_contract" && field === "owner_name") return { value: null, presence: "not_found", source_text: null, verified: false }; // missed
    return null;
  });
  const result = await evaluate({ samplesRoot, readPdf, extract, sets: ["set_01_clean"] });
  const summary = summarize(result);
  assert.equal(summary.wrong_value, 1);
  assert.equal(summary.missed, 1);
  assert.ok(summary.findings.false_positive >= 1, "the wrong address should raise a false alarm");
  assert.equal(result.ocr.length, 2, "ocr runs when set_01 is included");
});

test("a crashed extraction is reported and not counted as an AI mistake", async () => {
  const { readPdf, extract } = makeHarness(({ set, document, phase }) =>
    phase === "document" && set === "set_01_clean" && document === "lease_contract" ? { throw: "Provider request failed (429)" } : null);
  const result = await evaluate({ samplesRoot, readPdf, extract, sets: ["set_01_clean"] });
  const summary = summarize(result);
  assert.equal(summary.documents_failed, 1);
  assert.equal(result.sets[0].extraction_failed[0], "lease_contract");
  assert.ok(result.sets[0].fields.every((field) => field.document !== "lease_contract"));
  assert.match(formatReport(result), /Provider request failed/);
});

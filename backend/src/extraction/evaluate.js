// Accuracy report for the AI extraction + review rules.
// Usage (from the KalaBASA folder):
//   node --env-file=.env backend/src/extraction/evaluate.js
//   node --env-file=.env backend/src/extraction/evaluate.js --sets set_01_clean,set_02_address_mismatch
//   node --env-file=.env backend/src/extraction/evaluate.js --delay-ms 0      (when answers are already saved)
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readApplicationChecklist } from "../api/checklist.js";
import { Requirements } from "../api/schemas.js";
import { checkRequiredFields, checkRequirements, compareAcrossDocuments } from "../rules/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function normalize(value) {
  if (value === null || value === undefined) return null;
  return String(value).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const expectedPresence = (field) => (field.value !== null ? "printed" : field.source_text ? "blank_printed" : "not_found");

// Compare one expected field with what the AI returned.
export function scoreField(expected, actual) {
  const expectedValue = expected.value ?? null;
  const actualValue = actual?.value ?? null;
  let category;
  if (expectedValue === actualValue) category = "correct";
  else if (expectedValue !== null && actualValue !== null && normalize(expectedValue) === normalize(actualValue)) category = "formatting_only";
  else if (expectedValue !== null && actualValue !== null) category = "wrong_value";
  else if (expectedValue !== null) category = "missed";
  else category = "invented";
  const strict = category === "correct"
    && (expectedValue === null || (actual.page === expected.page && actual.source_text === expected.source_text))
    && actual?.presence === expectedPresence(expected);
  return {
    document: expected.document,
    field: expected.field,
    category,
    strict,
    quote_verified: actualValue !== null ? actual?.verified === true : null,
    expected: expectedValue,
    actual: actualValue,
  };
}

const findingKey = (finding) => `${finding.rule_id}|${finding.field}`;

export function scoreFindings(expectedFindings, actualFindings) {
  const expectedKeys = new Map(expectedFindings.map((item) => [findingKey(item), item]));
  const actualKeys = new Map(actualFindings.map((item) => [findingKey(item), item]));
  const matched = [...actualKeys.keys()].filter((key) => expectedKeys.has(key));
  return {
    expected: expectedKeys.size,
    found: actualKeys.size,
    true_positive: matched.length,
    false_positive: [...actualKeys.entries()].filter(([key]) => !expectedKeys.has(key)).map(([, item]) => item),
    false_negative: [...expectedKeys.entries()].filter(([key]) => !actualKeys.has(key)).map(([, item]) => item),
  };
}

async function timedExtract({ extract, document, pages, method, delayMs }) {
  const started = Date.now();
  try {
    const fields = await extract({ document, pages, method });
    const seconds = (Date.now() - started) / 1000;
    if (delayMs > 0 && seconds > 0.4) await sleep(delayMs); // stay under the free-tier limit
    return { fields, seconds, error: null };
  } catch (error) {
    if (delayMs > 0) await sleep(delayMs);
    return { fields: [], seconds: (Date.now() - started) / 1000, error: error.message };
  }
}

export async function evaluate({
  samplesRoot = path.join(repoRoot, "samples"),
  extract,
  readPdf,
  sets,
  delayMs = 0,
  log = () => {},
} = {}) {
  const requirements = Requirements.parse(JSON.parse(await fs.readFile(path.join(samplesRoot, "lgu_requirements.json"), "utf8")));
  const allSets = (await fs.readdir(samplesRoot)).filter((name) => /^set_0[1-5]/.test(name)).sort();
  const chosen = sets?.length ? allSets.filter((name) => sets.includes(name)) : allSets;
  const result = { sets: [], ocr: [], generated_at: new Date().toISOString() };

  for (const setName of chosen) {
    const setPath = path.join(samplesRoot, setName);
    const expected = JSON.parse(await fs.readFile(path.join(setPath, "expected.json"), "utf8"));
    const filenames = (await fs.readdir(setPath)).filter((name) => name.toLowerCase().endsWith(".pdf")).sort();
    const documents = [];
    const extracted = [];
    const pagesByDocument = {};
    for (const filename of filenames) {
      const document = path.basename(filename, path.extname(filename));
      log(`${setName}: reading ${filename} ...`);
      const { pages, method } = await readPdf(path.join(setPath, filename));
      pagesByDocument[document] = pages;
      const { fields, seconds, error } = await timedExtract({ extract, document, pages, method, delayMs });
      extracted.push(...fields);
      documents.push({ document, method, pages: pages.length, seconds, error });
    }
    const failedDocuments = new Set(documents.filter((item) => item.error).map((item) => item.document));

    // Score fields (documents whose extraction crashed are reported, not counted as AI mistakes).
    const fieldScores = expected.extracted_fields
      .filter((field) => !failedDocuments.has(field.document))
      .map((field) => scoreField(field, extracted.find((item) => item.document === field.document && item.field === field.field)));
    const expectedKeys = new Set(expected.extracted_fields.map((field) => `${field.document}|${field.field}`));
    const unexpected = extracted.filter((item) => item.value !== null && !expectedKeys.has(`${item.document}|${item.field}`))
      .map((item) => ({ document: item.document, field: item.field, value: item.value }));

    // Run the review rules on what the AI extracted, exactly like the app does.
    const uploaded = filenames.map((filename) => path.basename(filename, path.extname(filename))).map((document) =>
      document === "application_form"
        ? { document, checklist: readApplicationChecklist(pagesByDocument[document]) }
        : document);
    const findings = [
      ...checkRequirements(uploaded, requirements),
      ...checkRequiredFields(extracted, requirements),
      ...compareAcrossDocuments(extracted, requirements),
    ];
    result.sets.push({
      set: setName,
      scenario: expected.scenario,
      documents,
      fields: fieldScores,
      unexpected_fields: unexpected,
      findings: scoreFindings(expected.expected_findings, findings),
      extraction_failed: [...failedDocuments],
    });
  }

  // Scanned PDFs: tests OCR. Compared with the same document in set_01.
  const scannedDirectory = path.join(samplesRoot, "ocr_fallback_test");
  const scannedFiles = (await fs.readdir(scannedDirectory).catch(() => [])).filter((name) => name.toLowerCase().endsWith(".pdf")).sort();
  if (scannedFiles.length && (!sets?.length || chosen.includes("set_01_clean"))) {
    const baseline = JSON.parse(await fs.readFile(path.join(samplesRoot, "set_01_clean", "expected.json"), "utf8"));
    for (const filename of scannedFiles) {
      const document = filename.replace(/^set_\d+_/, "").replace(/_SCANNED\.pdf$/i, "");
      log(`OCR: reading ${filename} ...`);
      const started = Date.now();
      const { pages, method } = await readPdf(path.join(scannedDirectory, filename));
      const readSeconds = (Date.now() - started) / 1000;
      const { fields, seconds, error } = await timedExtract({ extract, document, pages, method, delayMs });
      const scores = error ? [] : baseline.extracted_fields.filter((field) => field.document === document)
        .map((field) => scoreField(field, fields.find((item) => item.field === field.field)));
      result.ocr.push({ filename, document, method, pages: pages.length, characters: pages.join("").length, read_seconds: readSeconds, extract_seconds: seconds, error, fields: scores });
    }
  }
  return result;
}

const pct = (part, whole) => (whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`);
const seconds = (value) => `${value.toFixed(1)}s`;

export function summarize(result) {
  const fields = result.sets.flatMap((item) => item.fields);
  const count = (category) => fields.filter((item) => item.category === category).length;
  const printed = fields.filter((item) => item.actual !== null);
  const findings = result.sets.map((item) => item.findings);
  const tp = findings.reduce((sum, item) => sum + item.true_positive, 0);
  const fp = findings.reduce((sum, item) => sum + item.false_positive.length, 0);
  const fn = findings.reduce((sum, item) => sum + item.false_negative.length, 0);
  const docs = result.sets.flatMap((item) => item.documents).filter((item) => !item.error);
  const avg = (list) => (list.length ? list.reduce((sum, item) => sum + item.seconds, 0) / list.length : 0);
  const ocrFields = result.ocr.flatMap((item) => item.fields);
  return {
    fields_checked: fields.length,
    correct: count("correct"),
    formatting_only: count("formatting_only"),
    wrong_value: count("wrong_value"),
    missed: count("missed"),
    invented: count("invented"),
    strict: fields.filter((item) => item.strict).length,
    quote_verified: printed.filter((item) => item.quote_verified).length,
    quote_checked: printed.length,
    findings: { true_positive: tp, false_positive: fp, false_negative: fn },
    seconds_text_layer: avg(docs.filter((item) => item.method === "text_layer")),
    seconds_ocr: avg(docs.filter((item) => item.method === "ocr")),
    documents_failed: result.sets.flatMap((item) => item.documents).filter((item) => item.error).length,
    ocr_fields_checked: ocrFields.length,
    ocr_correct: ocrFields.filter((item) => item.category === "correct").length,
  };
}

export function formatReport(result) {
  const s = summarize(result);
  const lines = [];
  lines.push("# KalaBASA extraction accuracy report", "", `Generated: ${result.generated_at}`, "");
  lines.push("## Overall results", "", "| Measure | Result |", "|---|---|");
  lines.push(`| Fields checked | ${s.fields_checked} |`);
  lines.push(`| Exactly correct value | ${s.correct} (${pct(s.correct, s.fields_checked)}) |`);
  lines.push(`| Strictly correct (value + page + quote + presence) | ${s.strict} (${pct(s.strict, s.fields_checked)}) |`);
  lines.push(`| Correct except formatting (case, punctuation, spaces) | ${s.formatting_only} |`);
  lines.push(`| Wrong value | ${s.wrong_value} |`);
  lines.push(`| Missed (value exists but AI returned nothing) | ${s.missed} |`);
  lines.push(`| Invented (document has no value but AI returned one) | ${s.invented} |`);
  lines.push(`| AI quotes found in the document text | ${s.quote_verified}/${s.quote_checked} (${pct(s.quote_verified, s.quote_checked)}) |`);
  lines.push(`| Findings correct / false alarms / missed findings | ${s.findings.true_positive} / ${s.findings.false_positive} / ${s.findings.false_negative} |`);
  lines.push(`| Finding precision | ${pct(s.findings.true_positive, s.findings.true_positive + s.findings.false_positive)} |`);
  lines.push(`| Finding recall | ${pct(s.findings.true_positive, s.findings.true_positive + s.findings.false_negative)} |`);
  lines.push(`| Average time per document, text PDFs | ${seconds(s.seconds_text_layer)} |`);
  lines.push(`| Average time per document, scanned (OCR) PDFs inside sets | ${seconds(s.seconds_ocr)} |`);
  lines.push(`| Documents where extraction crashed (not counted above) | ${s.documents_failed} |`, "");

  lines.push("## Results per sample set", "", "| Set | Scenario | Fields correct | False alarms | Missed findings | Notes |", "|---|---|---|---|---|---|");
  for (const item of result.sets) {
    const correct = item.fields.filter((field) => field.category === "correct").length;
    const notes = [
      item.extraction_failed.length ? `extraction failed: ${item.extraction_failed.join(", ")}` : "",
      item.unexpected_fields.length ? `${item.unexpected_fields.length} unexpected field(s)` : "",
    ].filter(Boolean).join("; ");
    lines.push(`| ${item.set} | ${item.scenario} | ${correct}/${item.fields.length} | ${item.findings.false_positive.length} | ${item.findings.false_negative.length} | ${notes} |`);
  }
  lines.push("");

  lines.push("## Time and method per document", "", "| Set | Document | Method | Pages | Seconds | Error |", "|---|---|---|---|---|---|");
  for (const item of result.sets) {
    for (const doc of item.documents) lines.push(`| ${item.set} | ${doc.document} | ${doc.method} | ${doc.pages} | ${seconds(doc.seconds)} | ${doc.error ? doc.error.slice(0, 80) : ""} |`);
  }
  lines.push("");

  if (result.ocr.length) {
    lines.push("## OCR test (scanned PDFs)", "", "| File | Method | Characters read | Read time | AI time | Fields correct |", "|---|---|---|---|---|---|");
    for (const item of result.ocr) {
      const correct = item.fields.filter((field) => field.category === "correct").length;
      lines.push(`| ${item.filename} | ${item.method} | ${item.characters} | ${seconds(item.read_seconds)} | ${seconds(item.extract_seconds)} | ${item.error ? `error: ${item.error.slice(0, 60)}` : `${correct}/${item.fields.length}`} |`);
    }
    lines.push("");
  }

  const mistakes = result.sets.flatMap((item) => item.fields.filter((field) => field.category !== "correct").map((field) => ({ set: item.set, ...field })));
  const ocrMistakes = result.ocr.flatMap((item) => item.fields.filter((field) => field.category !== "correct").map((field) => ({ set: `OCR ${item.filename}`, ...field })));
  lines.push("## Field mistakes", "");
  if (mistakes.length + ocrMistakes.length === 0) lines.push("None.", "");
  else {
    lines.push("| Where | Document.field | Type | Expected | AI answer |", "|---|---|---|---|---|");
    for (const item of [...mistakes, ...ocrMistakes]) lines.push(`| ${item.set} | ${item.document}.${item.field} | ${item.category} | ${item.expected ?? "null"} | ${item.actual ?? "null"} |`);
    lines.push("");
  }

  lines.push("## Finding mistakes (false alarms and missed findings)", "");
  const findingRows = result.sets.flatMap((item) => [
    ...item.findings.false_positive.map((finding) => ({ set: item.set, kind: "FALSE ALARM", finding })),
    ...item.findings.false_negative.map((finding) => ({ set: item.set, kind: "MISSED", finding })),
  ]);
  if (findingRows.length === 0) lines.push("None.", "");
  else {
    lines.push("| Set | Kind | Rule | Field | Message |", "|---|---|---|---|---|");
    for (const row of findingRows) lines.push(`| ${row.set} | ${row.kind} | ${row.finding.rule_id} | ${row.finding.field} | ${String(row.finding.message).replace(/\|/g, "/").slice(0, 110)} |`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const args = { sets: [], delayMs: Number(process.env.EVAL_DELAY_MS ?? 6500) };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--sets") args.sets = String(argv[++index] ?? "").split(",").filter(Boolean);
    else if (argv[index] === "--delay-ms") args.delayMs = Number(argv[++index]);
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { extractDocumentCached, getLlmConfig } = await import("./cache.js");
  const { readPdfPages } = await import("./pdf.js");
  const args = parseArgs(process.argv.slice(2));
  const llm = getLlmConfig();
  if (!llm.apiKey) {
    const keyName = llm.provider === "gemini" ? "GEMINI_API_KEY" : llm.provider === "openai-compatible" ? "LLM_API_KEY" : "ANTHROPIC_API_KEY";
    console.error(`Cannot run the live accuracy evaluation: ${keyName} is not set.`);
    process.exitCode = 1;
  } else {
    console.log(`Provider: ${llm.provider} | model: ${llm.model} | live AI: yes | pause between live calls: ${args.delayMs} ms\n`);
    const result = await evaluate({ extract: extractDocumentCached, readPdf: readPdfPages, sets: args.sets, delayMs: args.delayMs, log: console.log });
    const outputDirectory = path.join(repoRoot, "backend", ".cache");
    await fs.mkdir(outputDirectory, { recursive: true });
    const report = formatReport(result);
    await fs.writeFile(path.join(outputDirectory, "evaluation-report.md"), report, "utf8");
    await fs.writeFile(path.join(outputDirectory, "evaluation-report.json"), `${JSON.stringify({ summary: summarize(result), ...result }, null, 2)}\n`, "utf8");
    console.log(`\n${report}`);
    console.log("Saved: backend/.cache/evaluation-report.md and evaluation-report.json");
  }
}

import { DOCUMENT_TYPES } from "kalabasa-contract/schemas.js";

const LABELS = {
  application_form: ["business permit application form", "application form"],
  dti_certificate: ["dti certificate", "dti business name"],
  barangay_clearance: ["barangay business clearance", "barangay clearance"],
  lease_contract: ["contract of lease", "lease contract", "proof of ownership"],
  community_tax_certificate: ["community tax certificate", "cedula"],
};

export function readApplicationChecklist(pages) {
  const checklist = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    const rows = page.matchAll(/\[\s*([xX ])\s*\]\s*([\s\S]{1,140}?)(?=\[\s*[xX ]\s*\]|$)/g);
    for (const match of rows) {
      const sourceText = match[0].trim();
      const label = match[2].toLowerCase();
      const document = DOCUMENT_TYPES.find((type) =>
        type !== "application_form" && LABELS[type].some((candidate) => label.includes(candidate)));
      if (document) {
        checklist.push({
          document,
          checked: match[1].toLowerCase() === "x",
          page: pageIndex + 1,
          source_text: sourceText,
        });
      }
    }
  }
  return checklist;
}

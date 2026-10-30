# KalaBASA sample data (all fictional)

Fictional LGU: **City of Bagong Dalisay, Pampanga**. Every PDF carries a "SAMPLE DATA - FICTIONAL" footer. Use `lgu_requirements.json` as the requirements file.

| Folder | Scenario | Expected result |
|---|---|---|
| `set_01_clean` | Everything consistent | 0 findings |
| `set_02_address_mismatch` | Lease says **54** MacArthur Hwy, all other documents say **45** | 1 finding: business_address (evidence: application_form p1, lease_contract p1) |
| `set_03_missing_document` | No barangay clearance uploaded, but the form's checklist ticks it | 1 finding: missing_document barangay_clearance |
| `set_04_formatting_only` | Brgy./Barangay, Blk/Block, St./Street, `&`/AND, `DELA CRUZ, JUAN CARLOS P.` vs `Juan Carlos P. Dela Cruz`, TIN with/without dashes, different date styles | **0 findings** (must not flag anything) |
| `set_05_demo_story` | Clearance issued by Barangay San Jose, everything else says San Nicolas; lease notarization date left blank | 2 findings: business_address, notarization_date |
| `ocr_fallback_test` | Image-only (scanned-style) copies of set_01 clearance and CTC, no text layer | Same values as set_01 after OCR |

Each set folder has `expected.json` with the uploaded documents, expected findings (with evidence) and every expected extracted field in the shape `{field, value, document, page, source_text}`.

## Notes for the team
- `source_text` is exactly what is printed. Normalise whitespace before checking that it appears in the PDF text (long addresses wrap across lines).
- Built-in traps: the owner's **residence** address (form and CTC) differs from the business address on purpose and must not be compared. The lease has a **contract date** on page 1 that must not be used as the notarization date. The lessor also has an address.
- Finding shape in `expected.json` is a draft (`finding_id, type, severity, rule_id, field, message, evidence[]`). Finalise it in the data-contract step.
- Set 05 is the demo story. Set 04 is the strongest proof that the rules ignore harmless differences.

# KalaBASA data contract (v0.1)

`schemas.js` is the single source of truth. Frontend, backend and extraction all import from it.

## Quick start
```
npm install
npm run fixtures -- ../kalabasa_sample_data   # writes fixtures/*.json (fake API responses)
npm test -- ../kalabasa_sample_data           # checks sample data against the schemas
npm run check-samples -- ../kalabasa_sample_data   # needs pdftotext; runs the "appears in source" check on real PDFs
```
Person C: build the screens from `fixtures/set_05_demo_story.json` (2 findings) and `set_01_clean.json` (0 findings). These are full `Application` objects.

## API (proposed)
| Method | Path | Returns |
|---|---|---|
| POST | `/api/applications` (multipart: `lgu_id`, files, `document_types[]`) | `{ id }` |
| POST | `/api/applications/:id/process` | `202`, status becomes `extracting` then `ready_for_review` |
| GET | `/api/applications/:id` | `Application` (poll while `extracting`) |
| PATCH | `/api/applications/:id/findings/:findingId` body `{ status, reviewer_note? }` | updated `Finding` |
| POST | `/api/applications/:id/approve` | `409` unless `nextOutcome(app) === "approve"` |
| POST | `/api/applications/:id/return` | `409` unless `nextOutcome(app) === "return"` |
| GET | `/api/lgus/:id/requirements` | contents of `lgu_requirements.json` |

## Decisions the team must confirm
1. **Outcome rules** (`nextOutcome`): any finding still open or escalated locks the decision; any confirmed finding means "return for correction"; all dismissed (or none) unlocks Approve.
2. `verified` and `match` are computed in code. The LLM never marks its own answer as verified. Show unverified fields to the reviewer with a warning.
3. `value` is copied as printed (no normalising). Normalising is the rules engine's job, using `normalization` in `lgu_requirements.json`.
4. A field the document does not contain has `value: null`. Null is never guessed from another document.

## Extraction
`extraction.js` exports `extractDocument({ document, pages, method })`. `pages` is one string per page, from the PDF text layer, or from OCR when the text layer is empty. Set `ANTHROPIC_API_KEY`; model via `KALABASA_MODEL`. It has not been run against the live API yet. Test it on set 05 first: `notarization_date` must be `null`, and `business_address` must come from the premises, not the owner's home address.

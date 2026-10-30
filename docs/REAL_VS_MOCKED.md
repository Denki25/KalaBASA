# Real vs. mocked behavior

## Real implementation

- Uploaded PDFs are read with PDF.js. Pages with fewer than 24 non-whitespace text characters are rendered with `@napi-rs/canvas` and recognized with Tesseract.js.
- With `MOCK_MODE=false` and a valid `ANTHROPIC_API_KEY`, extraction calls the Anthropic API through the contract's `extractDocument()` function. The application code verifies each returned snippet with `verifyField()` and caches successful response bodies in `backend/.cache/extraction-responses.json`.
- The rules engine is deterministic code. It checks uploaded required documents, required fields, and configured cross-document comparisons; it does not ask the LLM to decide findings.
- When a required value or document has no printed snippet, findings carry `source_text: null` plus an explanatory evidence note instead of fabricated source text. Extracted fields distinguish `printed`, `blank_printed`, and `not_found`.
- Express routes validate successful responses with the Zod contract and enforce `nextOutcome()` before approve/return. Reviewer actions are written to the audit log.
- The frontend is a React/Vite application that calls the Express API and displays evidence, reviewer notes, and outcome controls.
- When both Supabase credentials are configured, application metadata, documents, fields, findings, and audit entries are stored through the Supabase client. The SQL schema is in `backend/db/schema.sql`.
- Real uploaded PDFs are currently written to `backend/.cache/uploads/` on the API host. They are not uploaded to Supabase Storage.

## Mocked or unverified behavior

- With `MOCK_MODE=true`, create/process flows use the full application fixtures under `contract/fixtures/`; no PDF is processed and no LLM is called.
- `npm run seed:sample-cache` creates offline response-cache entries from each sample set's `expected.json`. Therefore `npm run test:extraction` without a live, previously cached Anthropic response checks cache wiring and output agreement, not independent LLM accuracy. The seeded set 05 data contains a null `notarization_date` and the leased-premises `business_address`.
- The live Anthropic request path has not been validated with a production API credential in this workspace.
- Supabase behavior is implemented but has not been exercised against a configured Supabase project. Without Supabase credentials the API uses its in-memory store.
- Uploaded PDFs are local to the API host; durable remote file storage and production deployment configuration are not included.

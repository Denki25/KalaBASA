# Real vs. mocked behavior

## Real implementation

- Uploaded PDFs are read with PDF.js. Pages with fewer than 24 non-whitespace text characters are rendered with `@napi-rs/canvas` and recognized with Tesseract.js.
- With `MOCK_MODE=false`, extraction uses Anthropic by default (`ANTHROPIC_API_KEY` / `KALABASA_MODEL`) or the fetch-based `openai-compatible` adapter (`LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`). The application code verifies each returned snippet with `verifyField()` and caches responses by provider and model. The adapter supports compatible Gemini endpoints, Groq, and Ollama without adding a client dependency.
- The rules engine is deterministic code. It checks uploaded required documents, required fields, and configured cross-document comparisons; it does not ask the LLM to decide findings.
- When a required value or document has no printed snippet, findings carry `source_text: null` plus an explanatory evidence note instead of fabricated source text. Extracted fields distinguish `printed`, `blank_printed`, and `not_found`.
- Express routes validate successful responses with the Zod contract and enforce `nextOutcome()` before approve/return. Reviewer actions are written to the audit log.
- Finding updates require a non-empty reviewer note when dismissed or escalated; final decisions lock further finding updates and decision attempts. Review tabs, evidence highlights, and confirmation dialogs are frontend presentation around these real API checks.
- The frontend is a React/Vite application that calls the Express API and displays evidence, reviewer notes, and outcome controls.
- In production, the Express API serves `frontend/dist` and falls back to its `index.html` for browser routes; `/api/health` reports process health and the current mock-mode setting.
- With the default Anthropic provider and no `ANTHROPIC_API_KEY`, sample PDFs replay extraction answers from `backend/.cache/extraction-responses.json`, seeded from `expected.json`; this is not live AI extraction. The normal `npm run test:extraction` prints `CACHED/SEEDED ANSWERS - NOT LIVE AI ACCURACY` and these seeded results must never be reported as AI accuracy.
- `npm run test:extraction:live` requires the API key for the selected provider, always calls the configured model, compares each field with `expected.json`, reports critical checks and accuracy, and writes only to `backend/.cache/live-responses.json`. It does not read or change the seeded cache; live responses are never used as the offline fallback unless copied over manually.
- Extraction accuracy results are valid only for the provider/model tested. Free provider tiers may use submitted content; use only fake sample data with them. Real LGU documents require a paid no-training tier or a local model.
- The startup splash checks the real requirements endpoint before showing the existing first screen; its 1.5-second minimum display time is cosmetic.
- The login screen is cosmetic and accepts any input; it does not authenticate users.
- Home statistics and recent activity are computed from stored applications and audit-log timestamps; in mock mode they are seeded from the fixture applications.
- When both Supabase credentials are configured, application metadata, documents, fields, findings, and audit entries are stored through the Supabase client. The SQL schema is in `backend/db/schema.sql`.
- Real uploaded PDFs are currently written to `backend/.cache/uploads/` on the API host. They are not uploaded to Supabase Storage.

## Mocked or unverified behavior

- With `MOCK_MODE=true`, create/process flows use the full application fixtures under `contract/fixtures/`; no PDF is processed and no LLM is called.
- `npm run seed:sample-cache` creates offline response-cache entries from each sample set's `expected.json`. Therefore `npm run test:extraction` without a live, previously cached Anthropic response checks cache wiring and output agreement, not independent LLM accuracy. The seeded set 05 data contains a null `notarization_date` and the leased-premises `business_address`.
- The live Anthropic request path has not been validated with a production API credential in this workspace.
- Supabase behavior is implemented but has not been exercised against a configured Supabase project. Without Supabase credentials the API uses its in-memory store.
- Uploaded PDFs are local to the API host; durable remote file storage and production deployment configuration are not included.

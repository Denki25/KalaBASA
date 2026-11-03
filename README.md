# KalaBASA

AI-assisted review of local government business-permit applications. Automated checks provide evidence; a human reviewer makes every final decision.

## Setup

Requires Node.js 20 or newer.

```powershell
Copy-Item .env.example .env
npm install
```

The example configuration uses live extraction and Supabase authentication (`MOCK_MODE=false`, `AUTH_DISABLED=false`). Fill in the Supabase project API URL, publishable key, service key, and Gemini API key in `.env` before starting the API. Start the API and frontend in separate terminals:

```powershell
npm run start:api
npm run dev
```

Open the Vite URL printed in the frontend terminal and sign in with a Supabase Auth user that has a matching row in `public.profiles`. To run the fixture demo locally instead, set `AUTH_DISABLED=true` and `MOCK_MODE=true`; that mode does not use live extraction.

For real use, create a Supabase project and run [backend/db/schema.sql](./backend/db/schema.sql), [backend/db/auth.sql](./backend/db/auth.sql), and [backend/db/storage.sql](./backend/db/storage.sql) in its SQL editor. Set `SUPABASE_URL` to `https://<project-ref>.supabase.co` (not the dashboard URL), and configure `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_KEY`, `GEMINI_API_KEY`, `AUTH_DISABLED=false`, and `MOCK_MODE=false` in `.env`. Create reviewer accounts under Supabase Authentication > Users, then add one matching row to `public.profiles` with the account UUID, a `full_name`, a role (`viewer`, `reviewer`, or `admin`), and an `lgu_id` such as `bagong-dalisay-demo`. The API rejects accounts without a valid profile. Keep all API keys out of `.env.example` and the frontend.

To scan uploaded PDFs with AI, configure `GEMINI_API_KEY` and keep `MOCK_MODE=false`. The default provider is Gemini 3.6 Flash (`gemini-3.6-flash`) with minimal thinking for faster field extraction; set `GEMINI_THINKING_LEVEL=low` or higher when accuracy on difficult documents needs more reasoning. Three documents are processed at a time by default; adjust `LLM_MAX_CONCURRENCY` to fit your machine and provider quota. Scanned PDFs take longer because their pages need OCR. You can instead select Anthropic with `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`, or an OpenAI-compatible provider with `LLM_PROVIDER=openai-compatible`, `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL`. Extraction sends document text to the configured provider; review its data-handling terms before using real applications.

## Troubleshooting

If the API says a Supabase variable is missing, check whether it is already set in your PowerShell session with `$env:SUPABASE_URL` (and `$env:SUPABASE_SERVICE_KEY`). Clear stale values with `Remove-Item Env:SUPABASE_URL` or `Remove-Item Env:SUPABASE_SERVICE_KEY`. Variables already present in the shell override `.env`, so `.env` does not replace them.

## Tests

```powershell
npm run test:contract
npm run test:extraction
npm run test:ocr
npm run test:rules
npm run test:api
npm run build
```

`npm run seed:sample-cache` loads the bundled expected sample fields into the offline extraction cache for demos. These seeded outputs are not independent LLM extraction results. See [docs/REAL_VS_MOCKED.md](./docs/REAL_VS_MOCKED.md) for the implementation boundaries.

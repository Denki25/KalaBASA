# KalaBASA

AI-assisted review of local government business-permit applications. Automated checks provide evidence; a human reviewer makes every final decision.

## Setup

Requires Node.js 20 or newer.

```powershell
Copy-Item .env.example .env
npm install
```

By default, `.env.example` enables `MOCK_MODE=true` and `AUTH_DISABLED=true`. Start the API and frontend in separate terminals:

```powershell
npm run start:api
npm run dev
```

Open the Vite URL printed in the frontend terminal. Demo mode needs `AUTH_DISABLED=true` (login off) and lets you load the supplied sample applications without an API key. Real use needs the Supabase keys (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SERVICE_KEY`).

For real use, create a Supabase project and run [backend/db/schema.sql](./backend/db/schema.sql) and [backend/db/storage.sql](./backend/db/storage.sql) in its SQL editor. Set `AUTH_DISABLED=false`, `MOCK_MODE=false`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SERVICE_KEY` in `.env`. Create reviewer accounts under Supabase **Authentication → Users**, then add one matching row to `public.profiles` with that user's UUID, a `full_name`, a role (`viewer`, `reviewer`, or `admin`), and an `lgu_id` such as `bagong-dalisay-demo`. The API rejects accounts without a valid profile. Keep the service key server-side only.

To scan uploaded PDFs with AI, configure `GEMINI_API_KEY` and keep `MOCK_MODE=false`. The default provider is Gemini 3.6 Flash (`gemini-3.6-flash`). You can instead select Anthropic with `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`, or an OpenAI-compatible provider with `LLM_PROVIDER=openai-compatible`, `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL`. Extraction sends document text to the configured provider; review its data-handling terms before using real applications.

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

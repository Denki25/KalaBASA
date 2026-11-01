# KalaBASA

AI-assisted review of local government business-permit applications. Automated checks provide evidence; a human reviewer makes every final decision.

## Setup

Requires Node.js 20 or newer.

```powershell
Copy-Item .env.example .env
npm install
```

By default, `.env.example` enables `MOCK_MODE=true`. Start the API and frontend in separate terminals:

```powershell
npm run start:api
npm run dev
```

Open the Vite URL printed in the frontend terminal. Demo mode lets you load the supplied sample applications without an AI provider API key.

For live extraction, set `MOCK_MODE=false`, `LLM_PROVIDER=gemini`, and `GEMINI_API_KEY` in `.env`. The default model is `gemini-3.6-flash`; confirm it is available for your key in Google AI Studio. Supabase is enabled when both `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are provided; apply [backend/db/schema.sql](./backend/db/schema.sql) first.

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

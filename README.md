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

For live extraction, set `MOCK_MODE=false` and `ANTHROPIC_API_KEY` in `.env`. Supabase is enabled when both `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are provided; apply [backend/db/schema.sql](./backend/db/schema.sql) first.

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

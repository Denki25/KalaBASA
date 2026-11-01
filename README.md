# KalaBASA

AI-assisted review of local government business-permit applications. Automated checks provide evidence; a human reviewer makes every final decision.

## Setup

Requires Node.js 22.9 or newer.

```powershell
Copy-Item .env.example .env
npm install
```

By default, `.env.example` enables local demo mode with `MOCK_MODE=true` and `AUTH_DISABLED=true`. `AUTH_DISABLED=true` is for local use only; set it to `false` for any shared deployment. Start the API and frontend in separate terminals:

```powershell
npm run start:api
npm run dev
```

Open the Vite URL printed in the frontend terminal. Demo mode lets you load the supplied sample applications without an AI provider API key.

For live extraction, set `MOCK_MODE=false` and configure either `ANTHROPIC_API_KEY` with `LLM_PROVIDER=anthropic`, or `LLM_PROVIDER=openai-compatible` with `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL`. Supabase is enabled when both `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are provided; apply [backend/db/schema.sql](./backend/db/schema.sql) first. Keep authentication enabled (`AUTH_DISABLED=false`) on shared deployments.

## Tests

```powershell
npm run test:contract
npm run test:extraction
npm run test:extraction:live
npm run test:ocr
npm run test:rules
npm run test:api
npm run test:auth
npm run test:storage
npm run test:evaluator
npm run build
```

`npm run seed:sample-cache` loads the bundled expected sample fields into the offline extraction cache for demos. These seeded outputs are not independent LLM extraction results. See [docs/REAL_VS_MOCKED.md](./docs/REAL_VS_MOCKED.md) for the implementation boundaries.

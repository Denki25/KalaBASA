# Deploy KalaBASA to Render

This setup deploys one Render Web Service. The Express process serves both the API and the built React frontend; no separate static site or CORS configuration is needed.

## 1. Prepare Supabase

Create a Supabase project and run [`backend/db/schema.sql`](../backend/db/schema.sql) and [`backend/db/storage.sql`](../backend/db/storage.sql) in its SQL editor. Create each reviewer in **Authentication → Users** and add a matching row to `public.profiles` using the auth user's UUID, full name, role (`viewer`, `reviewer`, or `admin`), and LGU ID. Without a profile row, login is rejected.

## 2. Create the Render Web Service

1. Push this repository to the Git provider connected to Render.
2. In Render, choose **New → Web Service**, connect the repository, and select the branch to deploy.
3. Set **Root Directory** to the repository root.
4. Select the Node runtime.
5. Set **Build Command** to:

   ```sh
   npm install && npm run build
   ```

6. Set **Start Command** to:

   ```sh
   npm start
   ```

7. Set the Render health check path to `/api/health`.
8. Add the environment variables below, then create the service.

Render supplies `PORT`; the Express server listens on it automatically.

## Environment variables

| Variable | Value / use |
| --- | --- |
| `GEMINI_API_KEY` | Required when `LLM_PROVIDER=gemini` (the default). Store as a secret. |
| `GEMINI_THINKING_LEVEL` | Gemini reasoning level (`minimal`, `low`, `medium`, or `high`). Defaults to `minimal` for faster field extraction. |
| `KALABASA_MODEL` | Gemini or Anthropic model identifier. Defaults to `gemini-3.5-flash-lite` for Gemini and the contract default for Anthropic. |
| `ANTHROPIC_API_KEY` | Required when `LLM_PROVIDER=anthropic`. Store as a secret. |
| `LLM_PROVIDER` | Provider selector: `gemini` (default), `anthropic`, or `openai-compatible`. |
| `LLM_BASE_URL` | Base URL for an OpenAI-compatible `/chat/completions` endpoint. |
| `LLM_API_KEY` | API key for the selected OpenAI-compatible provider. Store as a secret. |
| `LLM_MODEL` | Model name for the selected OpenAI-compatible provider. |
| `LLM_MAX_CONCURRENCY` | Optional extraction concurrency override; defaults to 5 for Anthropic, 3 for Gemini, and 2 for other providers. |
| `SUPABASE_URL` | Supabase project URL. Set together with `SUPABASE_SERVICE_KEY` to enable Supabase storage. |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase publishable (formerly anon) key used by the login endpoint. |
| `SUPABASE_SERVICE_KEY` | Supabase service-role key. Store as a secret; never expose it in frontend variables. |
| `AUTH_DISABLED` | Set to `false` to require Supabase login; use `true` only for local demos. |
| `MOCK_MODE` | Set to `true` for fixture-backed demo mode or `false` for real uploads and extraction. This is baked into the frontend at build time; changing it on the host requires a new build/deploy. |
| `RATE_LIMIT_PER_10MIN` | Maximum create/process POST requests per IP in ten minutes. Defaults to `20`. |
| `DAILY_EXTRACTION_LIMIT` | Maximum live model calls per UTC day. Defaults to `200`; cached/mock extraction does not count. |

When `MOCK_MODE=true`, the application workflow uses fixtures and does not call an LLM. For live Gemini extraction, set `MOCK_MODE=false` and provide `GEMINI_API_KEY`. Anthropic and OpenAI-compatible providers are also supported. Supabase is optional; without both Supabase URL and service key, the service uses in-memory metadata storage.

Use `AUTH_DISABLED=false` and provision Supabase profiles for a real deployment. Keep `MOCK_MODE=true` on public demos; live extraction sends document text to the configured model provider. Use live mode only after configuring the provider key and reviewing its data-handling terms.

## Operational warnings

- **Free-tier cold starts can exceed the splash timeout.** The splash gives the requirements request up to 8 seconds, then shows “Can't reach the server” with Retry. A sleeping free-tier service may take longer to wake, so reviewers may need to retry. The splash's 1.5-second minimum is cosmetic; the health/requirements checks are real.
- **Uploaded PDF and image files are lost on redeploy/restart without Supabase.** The service writes them to `backend/.cache/uploads/` on the instance filesystem. That storage is ephemeral and is not copied to Supabase Storage. Do not use real personal documents in this deployment until durable private file storage and retention controls are implemented.
- The `/api/health` endpoint only verifies that the Express process responds; it does not check Anthropic or Supabase connectivity.

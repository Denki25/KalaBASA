# Deploy KalaBASA to Render

This setup deploys one Render Web Service. The Express process serves both the API and the built React frontend; no separate static site or CORS configuration is needed.

Requires Node.js 22.9 or newer.

## 1. Prepare Supabase (optional)

Create a Supabase project and run [`backend/db/schema.sql`](../backend/db/schema.sql) and [`backend/db/auth.sql`](../backend/db/auth.sql) in its SQL editor. Add a profile for each Supabase Auth user. To store uploaded PDFs in the private `application-documents` bucket, also run [`backend/db/storage.sql`](../backend/db/storage.sql).

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
| `ANTHROPIC_API_KEY` | Required for Anthropic extraction. Store as a secret in the host environment. |
| `LLM_PROVIDER` | Provider selector: `anthropic` (default) or `openai-compatible`. |
| `LLM_BASE_URL` | Base URL for an OpenAI-compatible `/chat/completions` endpoint. |
| `LLM_API_KEY` | API key for the selected OpenAI-compatible provider. Store as a secret. |
| `LLM_MODEL` | Model name for the selected OpenAI-compatible provider. |
| `LLM_MAX_CONCURRENCY` | Optional extraction concurrency override; defaults to 5 for Anthropic and 2 for other providers. |
| `SUPABASE_URL` | Supabase project URL. Required for auth; set with `SUPABASE_SERVICE_KEY` to enable Supabase storage. |
| `SUPABASE_SERVICE_KEY` | Supabase service-role key. Required for auth and Supabase storage. Store as a secret; never expose it in frontend variables. |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key required to configure authentication. |
| `AUTH_DISABLED` | Set to `true` only for local demos without login. Defaults to authentication enabled. |
| `MOCK_MODE` | Set to `true` for fixture-backed demo mode or `false` for real uploads and extraction. This is baked into the frontend at build time; changing it on the host requires a new build/deploy. |
| `RATE_LIMIT_PER_10MIN` | Maximum create/process POST requests per IP in ten minutes. Defaults to `20`. |
| `DAILY_EXTRACTION_LIMIT` | Maximum live model calls per UTC day. Defaults to `200`; cached/mock extraction does not count. |
| `MAX_PDF_PAGES` | Maximum pages processed per PDF. Defaults to `30`. |

When `MOCK_MODE=true`, the application workflow uses fixtures and does not call an LLM. For Anthropic, set `MOCK_MODE=false` and `ANTHROPIC_API_KEY`. For an OpenAI-compatible provider, set `LLM_PROVIDER=openai-compatible`, `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL`. Supabase is optional; without both Supabase variables, the service uses in-memory metadata storage.

Keep authentication enabled for deployments and create a Supabase Auth user plus profile for each reviewer. Setting `AUTH_DISABLED=true` allows anyone with the URL to use the API; use it only for local demos. Keep `MOCK_MODE=true` on public deployments and never upload real documents to a demo deployment.

## Operational warnings

- **Free-tier cold starts can exceed the splash timeout.** The splash gives the requirements request up to 8 seconds, then shows “Can't reach the server” with Retry. A sleeping free-tier service may take longer to wake, so reviewers may need to retry. The splash's 1.5-second minimum is cosmetic; the health/requirements checks are real.
- **Local PDF storage is ephemeral.** When both `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are set, uploaded PDFs use the private Supabase bucket. Otherwise they are written to `backend/.cache/uploads/` on the instance filesystem and are lost on redeploy/restart. Configure Supabase Storage and retention controls before using real personal documents.
- The `/api/health` endpoint only verifies that the Express process responds; it does not check Anthropic or Supabase connectivity.

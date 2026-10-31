# Deploy KalaBASA to Render

This setup deploys one Render Web Service. The Express process serves both the API and the built React frontend; no separate static site or CORS configuration is needed.

## 1. Prepare Supabase (optional)

For persistent application metadata, create a Supabase project and run [`backend/db/schema.sql`](../backend/db/schema.sql) in its SQL editor. The uploaded PDF bytes are still stored on the Render service's local filesystem; see the storage warning below.

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
| `ANTHROPIC_API_KEY` | Required for live document extraction when `MOCK_MODE=false`. Store as a secret in Render. |
| `KALABASA_MODEL` | Anthropic model identifier. Optional; defaults to the model configured in `contract/extraction.js`. |
| `SUPABASE_URL` | Supabase project URL. Set together with `SUPABASE_SERVICE_KEY` to enable Supabase storage. |
| `SUPABASE_SERVICE_KEY` | Supabase service-role key. Store as a secret; never expose it in frontend variables. |
| `MOCK_MODE` | Set to `true` for fixture-backed demo mode or `false` for real uploads and extraction. This is baked into the frontend at build time; changing it on the host requires a new build/deploy. |
| `RATE_LIMIT_PER_10MIN` | Maximum create/process POST requests per IP in ten minutes. Defaults to `20`. |
| `DAILY_EXTRACTION_LIMIT` | Maximum live model calls per UTC day. Defaults to `200`; cached/mock extraction does not count. |

When `MOCK_MODE=true`, the application workflow uses fixtures and does not call Anthropic. For live extraction, set it to `false` and provide `ANTHROPIC_API_KEY`. Supabase is optional; without both Supabase variables, the service uses in-memory metadata storage.

The public URL has no real login: anyone with the link can call the API. Use a separate Anthropic key with a spending limit. Keep `MOCK_MODE=true` on the public URL; use live mode only locally or for short windows, and never upload real documents to this demo deployment.

## Operational warnings

- **Free-tier cold starts can exceed the splash timeout.** The splash gives the requirements request up to 8 seconds, then shows “Can't reach the server” with Retry. A sleeping free-tier service may take longer to wake, so reviewers may need to retry. The splash's 1.5-second minimum is cosmetic; the health/requirements checks are real.
- **Uploaded PDFs are lost on redeploy/restart.** The service currently writes PDFs to `backend/.cache/uploads/` on the instance filesystem. That storage is ephemeral and is not copied to Supabase Storage. Do not use real personal documents in this deployment until durable private file storage and retention controls are implemented.
- The `/api/health` endpoint only verifies that the Express process responds; it does not check Anthropic or Supabase connectivity.

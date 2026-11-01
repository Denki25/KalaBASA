# KalaBASA – Handoff Notes

These notes explain what was changed after the first version of the project, how to set it up, and what to keep in mind. Put this file in the `docs/` folder.

## What is done

- Real login with Supabase Auth (email and password). The old fake login is removed.
- Roles: viewer, reviewer, admin.
- LGU-specific access: each user sees and changes only their own LGU. Admins see all LGUs.
- Private PDF storage in a Supabase bucket. The browser never gets a file link.
- Audit log records the real user's email.
- The app supports Supabase Auth/storage and Anthropic or OpenAI-compatible extraction providers.
- Multi-user tests passed by hand: LGU separation, viewer read-only, admin sees all LGUs, two reviewers in one LGU, return for correction, expired session.
- Automatic tests: login/roles (8), storage (4), accuracy script (5), API (13), review rules. All pass.
- Accuracy script is ready: `npm run evaluate`.

Still to do: save the final accuracy numbers for the project report. Optional: a clear on-screen message when a viewer tries to change something, review rules per LGU, password reset.

A full guide to the Supabase side is in `SUPABASE_GUIDE.md`.

## Where the code is and what to do first

- Repo: `https://github.com/Denki25/KalaBASA`
- Branch: `login-storage-evaluator` (not merged into `main` yet; review the pull request first)
- Pull request page: `https://github.com/Denki25/KalaBASA/pull/new/login-storage-evaluator`
- Commit: `7f02ac3` (19 files changed)

First steps:

1. Get the branch:
   ```
   git fetch
   git checkout login-storage-evaluator
   npm install
   ```
2. Copy `.env.example` to `.env` and fill it in with your own Anthropic or OpenAI-compatible provider key and Supabase values, shared privately.
3. Set up Supabase: use the shared project (accept the invite) or make your own and run the SQL files. Follow `SUPABASE_GUIDE.md`, Section 7.
4. Start the app in two terminals: `npm run start:api` and `npm run dev`.
5. Sign in with a test account (see Section 3, Step 3).
6. Run the tests: `npm run test:api`, `npm run test:auth`, `npm run test:storage`, `npm run test:evaluator`, `npm run test:rules`.
7. Run `npm run evaluate` to generate the live accuracy report. It requires a provider key and makes live model calls.
8. If everything works, merge the pull request into `main`.

Not in Git on purpose (stay on the owner's computer): `.env`, `backend/.cache/extraction-responses.json`, the evaluation reports, and `package-lock.json` changes.

## 1. What changed (short version)

| Area | Before | Now |
|---|---|---|
| AI extraction | Anthropic API | Anthropic by default or an OpenAI-compatible endpoint (`backend/src/extraction/cache.js`) |
| Environment variables | Backend never read `.env` | Backend scripts use `node --env-file-if-exists=.env` |
| Supabase saving | Failed on the second save of the same application | Fixed with `onConflict` in `store.js` |
| Login | Fake login, any input worked | **Real login** with Supabase Auth (email + password) |
| Access | Everyone saw everything | **LGU-specific access** and **roles** (`viewer`, `reviewer`, `admin`) |
| Audit log | Actor was always `reviewer` | Actor is the signed-in user's email |
| PDF storage | Saved on the server's disk (`backend/.cache/uploads`) | **Private Supabase Storage bucket** `application-documents` |
| Accuracy testing | Only `test:extraction` (strict, all-or-nothing) | **`npm run evaluate`** makes a full accuracy report |
| PDF text | Extra spaces and non-breaking spaces stayed in the text | `backend/src/extraction/pdf.js` collapses all whitespace into single spaces (text layer and OCR) |
| AI prompt | Dates had a separate rule | `contract/extraction.js`: wording changed, dates are copied exactly as printed (only `execution_date` and `notarization_date` become "Month D, YYYY") |

## 2. Files added or changed

**New files**
- `backend/src/api/auth.js` – checks logins and tokens, remembers who is making a request
- `backend/src/api/auth-test.js` – 8 tests for login, roles and LGU separation
- `backend/src/api/documents.js` – stores PDFs (private Supabase bucket, or local folder as fallback)
- `backend/src/api/documents-test.js` – 4 tests for PDF storage
- `backend/src/extraction/evaluate.js` – accuracy report script
- `backend/src/extraction/evaluate-test.js` – 5 tests for the report script
- `backend/db/auth.sql` – creates the `profiles` table
- `backend/db/storage.sql` – creates the private PDF bucket
- `docs/HANDOFF.md` – this file

**Changed files**
- `backend/src/api/app.js` – login routes, role checks, LGU filtering, uses the storage module
- `backend/src/api/store.js` – `lgu_id` in the list, and `onConflict` fix for saving
- `backend/src/api/server.js` – starts login and storage; refuses to start without login settings
- `backend/src/extraction/cache.js` – provider selection, retries, live responses, and seeded cache handling
- `backend/src/extraction/pdf.js` – whitespace cleanup (see section 1). This changes the text the AI sees, so it can change accuracy results.
- `contract/extraction.js` – prompt wording for dates (see section 1)
- `frontend/src/App.jsx` – real login form, Sign out button, token sent with every request
- `frontend/src/styles.css` – styles for the login error and the sign-out button
- `package.json` – `.env`-aware scripts, plus auth, storage, extraction, and evaluator checks
- `.env.example` – new settings (no real values)
- `docs/REAL_VS_MOCKED.md` – login and storage notes updated

## 3. Setup from zero

You need Node.js 22.9 or newer.

**Step 1: Create `.env`.** Copy `.env.example` to `.env` and fill in:

```
ANTHROPIC_API_KEY=         # optional when using mock mode or seeded responses
LLM_PROVIDER=anthropic     # or openai-compatible
LLM_BASE_URL=              # OpenAI-compatible endpoint only
LLM_API_KEY=               # OpenAI-compatible provider only
LLM_MODEL=                 # OpenAI-compatible provider only
KALABASA_MODEL=            # optional Anthropic model override
SUPABASE_URL=              # Project URL
SUPABASE_SERVICE_KEY=      # the SECRET key (sb_secret_...), backend only
SUPABASE_PUBLISHABLE_KEY=  # the publishable key (sb_publishable_...)
MOCK_MODE=false
AUTH_DISABLED=false
```

Keep `AUTH_DISABLED=false` for shared deployments. `.env.example` defaults to a local mock demo; never use that unauthenticated setting on a shared host.

**Step 2: Run the SQL files in Supabase** (SQL Editor), in this order:

1. `backend/db/schema.sql` – application tables, RLS, and scoped grants
2. `backend/db/auth.sql` – profiles table
3. `backend/db/storage.sql` – private bucket

The application-table RLS and least-privilege grants are included at the end of
`backend/db/schema.sql`. Run that file for a new project. Do not use the older
`GRANT ALL ON ALL TABLES IN SCHEMA public` command: it also grants the backend
access to unrelated tables in the schema. On an existing project, review and
remove any old broad grants separately after checking which services rely on
them; the scoped script does not revoke permissions on unrelated tables.

**Step 3: Create users.** In Supabase go to Authentication, Users, Add user. Turn on **Auto Confirm User**. Then give each user a role and an LGU:

```sql
insert into profiles (id, full_name, role, lgu_id)
select id, 'FULL NAME', 'ROLE', 'LGU'
from auth.users where email = 'EMAIL';
```

Demo accounts used during testing (set unique strong passwords before any shared or public deployment):

| Email | Role | LGU |
|---|---|---|
| reviewer.a@kalabasa-demo.com | reviewer | bagong-dalisay-demo |
| reviewer.b@kalabasa-demo.com | reviewer | other-lgu-demo |
| viewer.a@kalabasa-demo.com | viewer | bagong-dalisay-demo |

**Step 4: Run it.** Use two terminals in the `KalaBASA` folder:

```
npm run start:api
npm run dev
```

Check `http://localhost:3000/api/health`. The terminal should say "Documents are stored in the private Supabase bucket."

**Sharing Supabase.** GitHub only holds the code. The database, users and PDFs live in the Supabase project. There are two ways to work together:

- **Option A: one shared project.** The owner invites the other person: click the organization name (top-left), open Team, click Invite, and use the Developer role. After accepting, the person opens Project Settings, then API Keys, and copies the URL and keys into their own `.env`. The existing test accounts keep working, and the owner sends the test passwords privately.
- **Option B: a separate project.** The other person creates their own free Supabase project, runs the SQL files from Step 2, creates their own users, and uses their own keys. No data is shared. A free account can have only 2 active projects.

Send keys only in a private message, never through GitHub, a pull request or a group chat. Keep provider and Supabase service keys in the backend environment only.

## 4. Roles and access rules

| Role | Can do |
|---|---|
| viewer | Read applications in its own LGU only |
| reviewer | Viewer + upload, process, confirm/dismiss/escalate findings, approve or return (own LGU) |
| admin | Same as reviewer, but sees all LGUs |

- Two users with the same `lgu_id` share applications. Different `lgu_id` values are separate.
- A new application always gets the uploader's LGU, even if the request says another one.
- An application from another LGU looks like "not found" (404).
- Approve and Return are final decisions. A returned application is locked, and a corrected submission is a new application.
- Audit times are stored in UTC. In Supabase use `created_at at time zone 'Asia/Manila'` to read them in Philippine time.
- Public routes (no login): `/api/health`, `/api/lgus/:id/requirements`, `/api/auth/login`. Everything else needs a token.

## 5. Commands

| Command | What it does |
|---|---|
| `npm run start:api` / `npm run dev` | Start backend / frontend |
| `npm run test:contract` | Contract and sample data checks |
| `npm run test:extraction` | Offline seeded extraction and cache tests; not live AI accuracy |
| `npm run test:ocr` | OCR and PDF page-limit checks |
| `npm run test:rules` | Review rules checks |
| `npm run test:api` | 22 API tests |
| `npm run test:auth` | 8 login / role / LGU tests |
| `npm run test:storage` | 4 PDF storage tests |
| `npm run test:evaluator` | 5 tests for the accuracy script |
| `npm run test:rules` | Review rules checks |
| `npm run evaluate` | Live accuracy report (requires a configured provider key) |
| `npm run evaluate -- --sets set_01_clean` | Report for one set only |
| `npm run evaluate -- --delay-ms 0` | No pause, when the answers are already saved |

The report is saved to `backend/.cache/evaluation-report.md` and `.json`. It shows correct, wrong, missed and invented fields, quote checks, false alarms and missed findings, OCR results, and time per document.

## 6. Keep in mind

**Keys and secrets**
- Never share `.env`, and never commit it. Make sure `.env` and `backend/.cache/` are in `.gitignore`.
- Send the project **without** `.env`, `node_modules` and `backend/.cache`. Each person makes their own `.env` and uses approved credentials.
- The Supabase secret key has full access to the database. It is for the backend only. Never put it in the frontend.

**Extraction provider**
- Live extraction makes external model requests. Use sample PDFs unless your provider agreement and privacy review explicitly allow sending real applicant documents.
- Provider rate limits may reject requests; the backend applies bounded retries and daily call limits.
- Seeded answers in `backend/.cache/extraction-responses.json` support offline demos and are not independent model results. Use `npm run test:extraction:live` or `npm run evaluate` for a live run.

**Accuracy results**
- The sample sets are made-up documents, so they are cleaner than real ones. Say this in the report.
- `set_01_clean` and `set_04_formatting_only` should produce **zero** findings. Any finding there is a false alarm (false positive).
- A current live accuracy report still has to be run and added to the project report.

**Login and sessions**
- Supabase needs email logins. A username like `123` does not work.
- The token is kept in the browser tab (`sessionStorage`). When it expires (about 1 hour by default) the app signs the user out.
- There is no sign-up and no password reset. An administrator creates users in Supabase. "Forgot password" only shows a message.
- A viewer who tries to upload is blocked by the server (403), but the screen does not show a clear message. Small UI task.
- Login limits come only from Supabase's own protection.

**Storage**
- PDFs are in the private bucket as `application id / document type.pdf`. The browser never gets a file link. The backend downloads the file, reads it from a temporary copy, and deletes the copy.
- Applications uploaded **before** the storage change are in the local folder `backend/.cache/uploads` and cannot be processed again. Upload them again.
- If Supabase is not configured, the server falls back to the local folder and prints a warning.

**Other limits**
- All LGUs use one requirements file (`samples/lgu_requirements.json`). Access is LGU-specific, but the review rules are not.
- Supabase free projects pause after about a week without use. Free hosts such as Render sleep and have temporary disks.
- Project files use Windows line endings (CRLF). Some editors show a whole file as changed in Git. This is only line endings.
- Tesseract OCR downloads language data on the first scanned PDF, so the first run is slower.
- Hosting guidance is in [`docs/DEPLOY.md`](DEPLOY.md); check it before configuring a shared deployment.

## 7. Task status

| Task | Status |
|---|---|
| Real authentication | Done |
| LGU-specific access and reviewer roles | Done |
| Secure document storage | Done |
| Run with real Supabase credentials | Done (local) |
| Realistic multi-user test | Done. Passed by hand: LGU separation, viewer read-only, admin sees all LGUs, two reviewers in one LGU, return for correction (locked afterwards), expired or broken session sends the user back to login |
| Validate the AI (accuracy report) | Script ready and one full run was started. The final numbers still need to be saved and added to the project report (`backend/.cache/evaluation-report.md`) |
| Clear message for viewers in the UI | To do |
| Rules per LGU, password reset, public hosting | Not started |

create table if not exists applications (
  id text primary key,
  lgu_id text not null,
  label text not null,
  status text not null check (status in ('uploaded', 'extracting', 'ready_for_review', 'approved', 'returned')),
  created_at timestamptz not null
);

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  application_id text not null references applications(id) on delete cascade,
  document text not null,
  filename text not null,
  pages integer not null check (pages > 0),
  method text not null check (method in ('text_layer', 'ocr')),
  unique (application_id, document)
);

create table if not exists fields (
  id uuid primary key default gen_random_uuid(),
  application_id text not null references applications(id) on delete cascade,
  field text not null,
  value text,
  document text not null,
  page integer not null check (page > 0),
  source_text text,
  presence text check (presence in ('printed', 'blank_printed', 'not_found')),
  confidence text not null check (confidence in ('high', 'medium', 'low')),
  verified boolean not null,
  match text not null check (match in ('exact', 'loose', 'none')),
  method text not null check (method in ('text_layer', 'ocr')),
  unique (application_id, document, field)
);

create table if not exists findings (
  id uuid primary key default gen_random_uuid(),
  application_id text not null references applications(id) on delete cascade,
  finding_id text not null,
  type text not null check (type in ('missing_document', 'missing_field', 'cross_document_mismatch')),
  severity text not null check (severity in ('high', 'medium', 'low')),
  rule_id text not null,
  field text not null,
  message text not null,
  evidence jsonb not null,
  status text not null default 'open' check (status in ('open', 'confirmed', 'dismissed', 'escalated')),
  reviewer_note text,
  decided_at timestamptz,
  unique (application_id, finding_id)
);

create table if not exists audit_log (
  id bigint generated always as identity primary key,
  application_id text not null references applications(id) on delete cascade,
  action text not null,
  actor text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Application data is accessed through the backend service role only.
-- RLS is enabled without public/authenticated policies, and table privileges
-- are revoked from browser roles. Existing policies cannot grant access without
-- SQL privileges; service_role bypasses RLS in Supabase.
alter table applications enable row level security;
alter table documents enable row level security;
alter table fields enable row level security;
alter table findings enable row level security;
alter table audit_log enable row level security;

revoke all privileges on table
  public.applications,
  public.documents,
  public.fields,
  public.findings,
  public.audit_log
from public, anon, authenticated;

grant usage on schema public to service_role;
grant select, insert, update, delete on table
  public.applications,
  public.documents,
  public.fields,
  public.findings,
  public.audit_log
to service_role;

-- The audit_log identity column uses this sequence. Limit access to the
-- sequence in the same way as the table.
revoke all privileges on sequence public.audit_log_id_seq from public, anon, authenticated;
grant usage, select, update on sequence public.audit_log_id_seq to service_role;

-- The other application_id foreign keys lead their unique indexes already:
-- documents(application_id, document), fields(application_id, document, field),
-- and findings(application_id, finding_id). Only audit_log needs a new index.
create index if not exists audit_log_application_id_idx on public.audit_log (application_id);

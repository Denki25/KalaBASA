-- Reviewer profiles are provisioned for Supabase Auth users by an administrator.
-- The API reads these using the service key; browser clients must not read profiles directly.
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null check (role in ('viewer', 'reviewer', 'admin')),
  lgu_id text not null,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

create table if not exists applications (
  id text primary key,
  lgu_id text not null,
  label text not null,
  status text not null check (status in ('uploaded', 'extracting', 'ready_for_review', 'approved', 'returned')),
  created_at timestamptz not null,
  verifications jsonb not null default '[]'::jsonb
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
  type text not null check (type in ('missing_document', 'missing_field', 'cross_document_mismatch', 'validity_issue')),
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

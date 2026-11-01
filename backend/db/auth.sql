-- KalaBASA login: one profile per Supabase Auth user.
-- Run this once in the Supabase SQL Editor.

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null check (role in ('viewer', 'reviewer', 'admin')),
  lgu_id text not null,
  created_at timestamptz not null default now()
);

-- Only the backend (secret key / service_role) can read or write profiles.
alter table profiles enable row level security;
grant all on profiles to service_role;

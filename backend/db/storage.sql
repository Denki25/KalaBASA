-- KalaBASA private document storage.
-- Run this once in the Supabase SQL Editor.

-- A PRIVATE bucket: public = false, PDFs only, 20 MB max per file.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('application-documents', 'application-documents', false, 20971520, array['application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = 20971520,
      allowed_mime_types = array['application/pdf'];

-- No access policies are created on purpose.
-- That means the browser keys (publishable/anon) cannot read or write these files.
-- Only the backend, using the secret key (service_role), can.

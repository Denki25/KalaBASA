-- KalaBASA private document storage.
-- Run this once in the Supabase SQL Editor.

-- A PRIVATE bucket: public = false, PDFs up to 20 MB and images up to 10 MB (API enforced).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('application-documents', 'application-documents', false, 20971520, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = 20971520,
      allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png'];

-- No access policies are created on purpose.
-- That means the browser keys (publishable/anon) cannot read or write these files.
-- Only the backend, using the secret key (service_role), can.

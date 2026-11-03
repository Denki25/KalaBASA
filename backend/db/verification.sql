-- Apply to existing Supabase projects before running this version of the API.
begin;
alter table applications add column if not exists verifications jsonb not null default '[]'::jsonb;
alter table findings drop constraint if exists findings_type_check;
alter table findings add constraint findings_type_check
  check (type in ('missing_document', 'missing_field', 'cross_document_mismatch', 'validity_issue'));
notify pgrst, 'reload schema';
commit;

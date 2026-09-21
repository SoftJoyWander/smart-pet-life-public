-- Cover every medical-platform foreign key with a leading-column index.

create index audit_events_owner_time_idx
  on private.audit_events (owner_id, occurred_at desc);
create index authorization_tokens_used_staff_idx
  on private.pet_clinic_authorization_tokens (used_by_staff_id)
  where used_by_staff_id is not null;
create index veterinary_staff_credentials_verifier_idx
  on private.veterinary_staff_credentials (verified_by_auth_user_id)
  where verified_by_auth_user_id is not null;

create index diagnostic_reports_document_pet_owner_fk_idx
  on public.diagnostic_reports (document_id, pet_id, owner_id)
  where document_id is not null;
create index diagnostic_reports_supersedes_pet_owner_fk_idx
  on public.diagnostic_reports (supersedes_id, pet_id, owner_id)
  where supersedes_id is not null;
create index diagnostic_reports_visit_pet_owner_fk_idx
  on public.diagnostic_reports (visit_id, pet_id, owner_id);
create index diagnostic_results_report_pet_owner_fk_idx
  on public.diagnostic_results (report_id, pet_id, owner_id);
create index medical_access_grants_pet_owner_fk_idx
  on public.medical_access_grants (pet_id, owner_id);
create index medical_documents_supersedes_pet_owner_fk_idx
  on public.medical_documents (supersedes_id, pet_id, owner_id)
  where supersedes_id is not null;
create index medical_documents_visit_pet_owner_fk_idx
  on public.medical_documents (visit_id, pet_id, owner_id);
create index medical_record_versions_owner_idx
  on public.medical_record_versions (owner_id);
create index medical_record_versions_pet_owner_fk_idx
  on public.medical_record_versions (pet_id, owner_id);
create index medical_visits_owner_idx
  on public.medical_visits (owner_id);
create index medical_visits_pet_owner_fk_idx
  on public.medical_visits (pet_id, owner_id);
create index medical_visits_supersedes_pet_owner_fk_idx
  on public.medical_visits (supersedes_id, pet_id, owner_id)
  where supersedes_id is not null;
create index pet_clinic_authorizations_pet_owner_fk_idx
  on public.pet_clinic_authorizations (pet_id, owner_id);

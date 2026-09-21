-- Pet medical collaboration foundation.
--
-- This migration keeps lifestyle care_records unchanged and creates a separate
-- least-privilege boundary for veterinary organizations, explicit medical
-- sharing, visits, documents and diagnostic data. Medical media is private.

create type public.medical_source_type as enum (
  'owner_reported',
  'caregiver_reported',
  'owner_uploaded_unverified',
  'clinic_submitted',
  'veterinarian_reviewed',
  'system_derived',
  'device_measured'
);

create type public.organization_verification_status as enum (
  'pending', 'verified', 'suspended', 'rejected', 'archived'
);

create type public.veterinary_staff_role as enum (
  'clinic_admin', 'clinic_staff', 'veterinarian'
);

create type public.veterinary_staff_status as enum (
  'invited', 'active', 'suspended', 'revoked'
);

create type public.authorization_status as enum ('active', 'expired', 'revoked');

create type public.clinic_authorization_scope as enum (
  'view_records', 'create_visit', 'upload_document', 'write_diagnostic_result'
);

create type public.medical_access_scope as enum (
  'view_visit', 'view_document', 'view_diagnostic_result'
);

create type public.medical_visit_status as enum (
  'draft', 'published', 'corrected', 'cancelled'
);

create type public.medical_document_status as enum (
  'uploading', 'processing', 'draft', 'published', 'rejected', 'superseded'
);

create type public.diagnostic_report_status as enum (
  'draft', 'confirmed', 'corrected', 'cancelled'
);

create type public.diagnostic_flag as enum (
  'low', 'high', 'critical_low', 'critical_high', 'abnormal', 'normal',
  'indeterminate', 'not_provided'
);

create type public.medical_entity_type as enum (
  'medical_visit', 'medical_document', 'diagnostic_report', 'diagnostic_result'
);

create type private.audit_actor_type as enum ('user', 'veterinary_staff', 'service');

create or replace function private.generate_entity_id(entity_prefix text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  sequence_value numeric;
  permuted_value bigint;
begin
  if entity_prefix not in (
    'USR', 'PET', 'REC', 'MPL', 'RMN', 'MBR', 'INV', 'PVC', 'WLK',
    'VOR', 'VST', 'PCA', 'MAG', 'VIS', 'DOC', 'DGR', 'DGS', 'MRV', 'AUD'
  ) then
    raise exception 'Unsupported entity ID prefix: %', entity_prefix;
  end if;

  sequence_value := nextval('private.entity_id_sequence'::regclass)::numeric;
  permuted_value := mod(
    sequence_value * 2654435761::numeric + 2246822519::numeric,
    4294967296::numeric
  )::bigint;

  return entity_prefix || '-' || upper(lpad(to_hex(permuted_value), 8, '0'));
end;
$$;

revoke all on function private.generate_entity_id(text) from public, anon;
grant execute on function private.generate_entity_id(text) to authenticated, service_role;

create table public.veterinary_organizations (
  id text primary key default private.generate_entity_id('VOR'),
  name text not null check (char_length(trim(name)) between 1 and 160),
  region text not null check (region ~ '^[A-Z]{2}(-[A-Z0-9]{1,8})?$'),
  verification_status public.organization_verification_status not null default 'pending',
  verified_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint veterinary_organizations_id_format check (id ~ '^VOR-[0-9A-F]{8}$'),
  constraint veterinary_organizations_verification_time check (
    verification_status <> 'verified' or verified_at is not null
  )
);

create table public.veterinary_staff (
  id text primary key default private.generate_entity_id('VST'),
  organization_id text not null references public.veterinary_organizations(id),
  profile_id text not null references public.profiles(id),
  role public.veterinary_staff_role not null,
  status public.veterinary_staff_status not null default 'invited',
  activated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint veterinary_staff_id_format check (id ~ '^VST-[0-9A-F]{8}$'),
  constraint veterinary_staff_activation_state check (
    (status = 'active' and activated_at is not null and revoked_at is null)
    or (status <> 'active')
  ),
  constraint veterinary_staff_revocation_state check (
    status <> 'revoked' or revoked_at is not null
  ),
  unique (organization_id, profile_id),
  unique (id, organization_id)
);

create table private.veterinary_staff_credentials (
  staff_id text primary key references public.veterinary_staff(id) on delete cascade,
  credential_reference text not null check (char_length(trim(credential_reference)) between 1 and 500),
  evidence_metadata jsonb not null default '{}'::jsonb,
  verified_by_auth_user_id uuid references auth.users(id),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.pet_clinic_authorizations (
  id text primary key default private.generate_entity_id('PCA'),
  owner_id text not null references public.profiles(id),
  pet_id text not null,
  organization_id text not null references public.veterinary_organizations(id),
  scope public.clinic_authorization_scope[] not null,
  status public.authorization_status not null default 'active',
  policy_version text not null check (char_length(trim(policy_version)) between 1 and 80),
  locale text not null default 'zh-TW' check (locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pet_clinic_authorizations_id_format check (id ~ '^PCA-[0-9A-F]{8}$'),
  constraint pet_clinic_authorizations_pet_owner_fk
    foreign key (pet_id, owner_id) references public.pets(id, owner_id),
  constraint pet_clinic_authorizations_scope_nonempty check (cardinality(scope) > 0),
  constraint pet_clinic_authorizations_expiry check (expires_at is null or expires_at > granted_at),
  constraint pet_clinic_authorizations_state check (
    (status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
    or status = 'expired'
  )
);

create unique index pet_clinic_authorizations_one_active_idx
  on public.pet_clinic_authorizations (pet_id, organization_id)
  where status = 'active' and revoked_at is null;

create table private.pet_clinic_authorization_tokens (
  id uuid primary key default gen_random_uuid(),
  authorization_id text not null references public.pet_clinic_authorizations(id) on delete cascade,
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by_staff_id text references public.veterinary_staff(id),
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 20),
  created_at timestamptz not null default now(),
  constraint pet_clinic_authorization_tokens_usage check (
    (used_at is null and used_by_staff_id is null)
    or (used_at is not null and used_by_staff_id is not null)
  )
);

create table public.medical_access_grants (
  id text primary key default private.generate_entity_id('MAG'),
  owner_id text not null references public.profiles(id),
  pet_id text not null,
  grantee_profile_id text not null references public.profiles(id),
  scope public.medical_access_scope[] not null,
  status public.authorization_status not null default 'active',
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint medical_access_grants_id_format check (id ~ '^MAG-[0-9A-F]{8}$'),
  constraint medical_access_grants_pet_owner_fk
    foreign key (pet_id, owner_id) references public.pets(id, owner_id),
  constraint medical_access_grants_not_owner check (grantee_profile_id <> owner_id),
  constraint medical_access_grants_scope_nonempty check (cardinality(scope) > 0),
  constraint medical_access_grants_expiry check (expires_at is null or expires_at > granted_at),
  constraint medical_access_grants_state check (
    (status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
    or status = 'expired'
  )
);

create unique index medical_access_grants_one_active_idx
  on public.medical_access_grants (pet_id, grantee_profile_id)
  where status = 'active' and revoked_at is null;

create table public.medical_visits (
  id text primary key default private.generate_entity_id('VIS'),
  owner_id text not null references public.profiles(id),
  pet_id text not null,
  organization_id text references public.veterinary_organizations(id),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  timezone text not null default 'Asia/Taipei' check (char_length(timezone) between 1 and 64),
  source_type public.medical_source_type not null,
  status public.medical_visit_status not null default 'draft',
  title text not null check (char_length(trim(title)) between 1 and 160),
  summary text check (summary is null or char_length(summary) <= 10000),
  created_by_profile_id text references public.profiles(id),
  created_by_staff_id text references public.veterinary_staff(id),
  reviewed_by_staff_id text references public.veterinary_staff(id),
  reviewed_at timestamptz,
  schema_version integer not null default 1 check (schema_version between 1 and 1000),
  supersedes_id text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint medical_visits_id_format check (id ~ '^VIS-[0-9A-F]{8}$'),
  constraint medical_visits_pet_owner_fk
    foreign key (pet_id, owner_id) references public.pets(id, owner_id),
  constraint medical_visits_creator check (
    (created_by_profile_id is not null)::integer
      + (created_by_staff_id is not null)::integer = 1
  ),
  constraint medical_visits_publish_state check (
    (status = 'draft' and published_at is null)
    or (status <> 'draft' and published_at is not null)
  ),
  constraint medical_visits_review_state check (
    (source_type = 'veterinarian_reviewed' and reviewed_by_staff_id is not null and reviewed_at is not null)
    or (source_type <> 'veterinarian_reviewed' and reviewed_by_staff_id is null and reviewed_at is null)
  ),
  constraint medical_visits_device_disabled check (source_type <> 'device_measured'),
  constraint medical_visits_supersedes_other check (supersedes_id is null or supersedes_id <> id),
  unique (id, pet_id, owner_id),
  foreign key (supersedes_id, pet_id, owner_id)
    references public.medical_visits(id, pet_id, owner_id)
);

create table public.medical_documents (
  id text primary key default private.generate_entity_id('DOC'),
  visit_id text not null,
  owner_id text not null,
  pet_id text not null,
  organization_id text references public.veterinary_organizations(id),
  document_type text not null check (char_length(trim(document_type)) between 1 and 80),
  storage_path text not null unique,
  original_filename text not null check (char_length(trim(original_filename)) between 1 and 255),
  mime_type text not null check (mime_type in (
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'
  )),
  size_bytes bigint not null check (size_bytes between 1 and 25165824),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  source_type public.medical_source_type not null,
  status public.medical_document_status not null default 'uploading',
  version integer not null default 1 check (version between 1 and 10000),
  supersedes_id text,
  uploaded_by_profile_id text references public.profiles(id),
  uploaded_by_staff_id text references public.veterinary_staff(id),
  recorded_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint medical_documents_id_format check (id ~ '^DOC-[0-9A-F]{8}$'),
  constraint medical_documents_visit_fk
    foreign key (visit_id, pet_id, owner_id)
    references public.medical_visits(id, pet_id, owner_id),
  constraint medical_documents_uploader check (
    (uploaded_by_profile_id is not null)::integer
      + (uploaded_by_staff_id is not null)::integer = 1
  ),
  constraint medical_documents_source_allowed check (
    source_type not in ('veterinarian_reviewed', 'device_measured')
  ),
  constraint medical_documents_publish_state check (
    (status in ('uploading', 'processing', 'draft', 'rejected') and published_at is null)
    or (status in ('published', 'superseded') and published_at is not null)
  ),
  constraint medical_documents_supersedes_other check (supersedes_id is null or supersedes_id <> id),
  unique (id, pet_id, owner_id),
  foreign key (supersedes_id, pet_id, owner_id)
    references public.medical_documents(id, pet_id, owner_id)
);

create table private.medical_document_processing (
  document_id text primary key references public.medical_documents(id) on delete cascade,
  scan_status text not null default 'pending'
    check (scan_status in ('pending', 'clean', 'rejected', 'error')),
  detected_mime_type text,
  scanner_reference text,
  scan_metadata jsonb not null default '{}'::jsonb,
  scanned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.diagnostic_reports (
  id text primary key default private.generate_entity_id('DGR'),
  visit_id text not null,
  document_id text,
  owner_id text not null,
  pet_id text not null,
  organization_id text references public.veterinary_organizations(id),
  report_type text not null check (char_length(trim(report_type)) between 1 and 80),
  collected_at timestamptz,
  reported_at timestamptz,
  recorded_at timestamptz not null default now(),
  timezone text not null default 'Asia/Taipei' check (char_length(timezone) between 1 and 64),
  source_type public.medical_source_type not null,
  status public.diagnostic_report_status not null default 'draft',
  created_by_profile_id text references public.profiles(id),
  created_by_staff_id text references public.veterinary_staff(id),
  confirmed_by_staff_id text references public.veterinary_staff(id),
  confirmed_at timestamptz,
  schema_version integer not null default 1 check (schema_version between 1 and 1000),
  supersedes_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint diagnostic_reports_id_format check (id ~ '^DGR-[0-9A-F]{8}$'),
  constraint diagnostic_reports_visit_fk
    foreign key (visit_id, pet_id, owner_id)
    references public.medical_visits(id, pet_id, owner_id),
  constraint diagnostic_reports_document_fk
    foreign key (document_id, pet_id, owner_id)
    references public.medical_documents(id, pet_id, owner_id),
  constraint diagnostic_reports_creator check (
    (created_by_profile_id is not null)::integer
      + (created_by_staff_id is not null)::integer = 1
  ),
  constraint diagnostic_reports_confirmation check (
    (status = 'draft' and confirmed_by_staff_id is null and confirmed_at is null)
    or (status <> 'draft' and confirmed_by_staff_id is not null and confirmed_at is not null)
  ),
  constraint diagnostic_reports_review_source check (
    source_type <> 'veterinarian_reviewed' or confirmed_by_staff_id is not null
  ),
  constraint diagnostic_reports_device_disabled check (source_type <> 'device_measured'),
  constraint diagnostic_reports_supersedes_other check (supersedes_id is null or supersedes_id <> id),
  unique (id, pet_id, owner_id),
  foreign key (supersedes_id, pet_id, owner_id)
    references public.diagnostic_reports(id, pet_id, owner_id)
);

create table public.diagnostic_results (
  id text primary key default private.generate_entity_id('DGS'),
  report_id text not null,
  owner_id text not null,
  pet_id text not null,
  organization_id text references public.veterinary_organizations(id),
  item_code text check (item_code is null or char_length(trim(item_code)) between 1 and 80),
  item_name text not null check (char_length(trim(item_name)) between 1 and 160),
  value_numeric numeric,
  value_text text check (value_text is null or char_length(trim(value_text)) between 1 and 1000),
  original_unit text check (original_unit is null or char_length(original_unit) <= 80),
  canonical_value numeric,
  canonical_unit text check (canonical_unit is null or char_length(canonical_unit) <= 80),
  reference_low numeric,
  reference_high numeric,
  reference_text text check (reference_text is null or char_length(reference_text) <= 500),
  flag public.diagnostic_flag not null default 'not_provided',
  method text check (method is null or char_length(method) <= 160),
  specimen text check (specimen is null or char_length(specimen) <= 160),
  display_order integer not null default 0 check (display_order between 0 and 100000),
  created_by_profile_id text references public.profiles(id),
  created_by_staff_id text references public.veterinary_staff(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint diagnostic_results_id_format check (id ~ '^DGS-[0-9A-F]{8}$'),
  constraint diagnostic_results_report_fk
    foreign key (report_id, pet_id, owner_id)
    references public.diagnostic_reports(id, pet_id, owner_id),
  constraint diagnostic_results_value_present check (value_numeric is not null or value_text is not null),
  constraint diagnostic_results_reference_range check (
    reference_low is null or reference_high is null or reference_low <= reference_high
  ),
  constraint diagnostic_results_canonical_pair check (
    (canonical_value is null and canonical_unit is null)
    or (canonical_value is not null and canonical_unit is not null)
  ),
  constraint diagnostic_results_creator check (
    (created_by_profile_id is not null)::integer
      + (created_by_staff_id is not null)::integer = 1
  )
);

create table public.medical_record_versions (
  id text primary key default private.generate_entity_id('MRV'),
  owner_id text not null references public.profiles(id),
  pet_id text not null,
  organization_id text references public.veterinary_organizations(id),
  entity_type public.medical_entity_type not null,
  entity_id text not null,
  version integer not null check (version between 1 and 100000),
  snapshot jsonb not null,
  changed_by_profile_id text references public.profiles(id),
  changed_by_staff_id text references public.veterinary_staff(id),
  change_reason text check (change_reason is null or char_length(trim(change_reason)) between 1 and 1000),
  created_at timestamptz not null default now(),
  constraint medical_record_versions_id_format check (id ~ '^MRV-[0-9A-F]{8}$'),
  constraint medical_record_versions_pet_owner_fk
    foreign key (pet_id, owner_id) references public.pets(id, owner_id),
  constraint medical_record_versions_actor check (
    (changed_by_profile_id is not null)::integer
      + (changed_by_staff_id is not null)::integer <= 1
  ),
  unique (entity_type, entity_id, version)
);

create table private.audit_events (
  id text primary key default private.generate_entity_id('AUD'),
  actor_type private.audit_actor_type not null,
  actor_profile_id text references public.profiles(id),
  actor_staff_id text references public.veterinary_staff(id),
  action text not null check (char_length(trim(action)) between 1 and 120),
  target_type text not null check (char_length(trim(target_type)) between 1 and 120),
  target_id text,
  owner_id text references public.profiles(id),
  pet_id text references public.pets(id),
  organization_id text references public.veterinary_organizations(id),
  occurred_at timestamptz not null default now(),
  request_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  constraint audit_events_id_format check (id ~ '^AUD-[0-9A-F]{8}$')
);

-- Foreign-key and RLS lookup indexes.
create index veterinary_staff_profile_idx on public.veterinary_staff (profile_id, status);
create index veterinary_staff_org_status_idx on public.veterinary_staff (organization_id, status, role);
create index pet_clinic_authorizations_owner_idx on public.pet_clinic_authorizations (owner_id, created_at desc);
create index pet_clinic_authorizations_org_pet_idx on public.pet_clinic_authorizations (organization_id, pet_id, status, expires_at);
create index medical_access_grants_grantee_idx on public.medical_access_grants (grantee_profile_id, pet_id, status, expires_at);
create index medical_access_grants_owner_idx on public.medical_access_grants (owner_id, pet_id, status);
create index medical_visits_pet_occurred_idx on public.medical_visits (pet_id, occurred_at desc);
create index medical_visits_org_status_idx on public.medical_visits (organization_id, status, occurred_at desc);
create index medical_visits_created_profile_idx on public.medical_visits (created_by_profile_id) where created_by_profile_id is not null;
create index medical_visits_created_staff_idx on public.medical_visits (created_by_staff_id) where created_by_staff_id is not null;
create index medical_visits_reviewed_staff_idx on public.medical_visits (reviewed_by_staff_id) where reviewed_by_staff_id is not null;
create index medical_visits_supersedes_idx on public.medical_visits (supersedes_id) where supersedes_id is not null;
create index medical_documents_visit_idx on public.medical_documents (visit_id, created_at);
create index medical_documents_pet_status_idx on public.medical_documents (pet_id, status, created_at desc);
create index medical_documents_org_status_idx on public.medical_documents (organization_id, status, created_at desc);
create index medical_documents_uploaded_profile_idx on public.medical_documents (uploaded_by_profile_id) where uploaded_by_profile_id is not null;
create index medical_documents_uploaded_staff_idx on public.medical_documents (uploaded_by_staff_id) where uploaded_by_staff_id is not null;
create index medical_documents_supersedes_idx on public.medical_documents (supersedes_id) where supersedes_id is not null;
create index diagnostic_reports_visit_idx on public.diagnostic_reports (visit_id, created_at);
create index diagnostic_reports_document_idx on public.diagnostic_reports (document_id) where document_id is not null;
create index diagnostic_reports_pet_status_idx on public.diagnostic_reports (pet_id, status, reported_at desc);
create index diagnostic_reports_org_status_idx on public.diagnostic_reports (organization_id, status, reported_at desc);
create index diagnostic_reports_created_profile_idx on public.diagnostic_reports (created_by_profile_id) where created_by_profile_id is not null;
create index diagnostic_reports_created_staff_idx on public.diagnostic_reports (created_by_staff_id) where created_by_staff_id is not null;
create index diagnostic_reports_confirmed_staff_idx on public.diagnostic_reports (confirmed_by_staff_id) where confirmed_by_staff_id is not null;
create index diagnostic_reports_supersedes_idx on public.diagnostic_reports (supersedes_id) where supersedes_id is not null;
create index diagnostic_results_report_order_idx on public.diagnostic_results (report_id, display_order, id);
create index diagnostic_results_pet_idx on public.diagnostic_results (pet_id, created_at desc);
create index diagnostic_results_org_idx on public.diagnostic_results (organization_id, created_at desc);
create index diagnostic_results_created_profile_idx on public.diagnostic_results (created_by_profile_id) where created_by_profile_id is not null;
create index diagnostic_results_created_staff_idx on public.diagnostic_results (created_by_staff_id) where created_by_staff_id is not null;
create index medical_record_versions_pet_idx on public.medical_record_versions (pet_id, created_at desc);
create index medical_record_versions_org_idx on public.medical_record_versions (organization_id, created_at desc);
create index medical_record_versions_changed_profile_idx on public.medical_record_versions (changed_by_profile_id) where changed_by_profile_id is not null;
create index medical_record_versions_changed_staff_idx on public.medical_record_versions (changed_by_staff_id) where changed_by_staff_id is not null;
create index audit_events_pet_time_idx on private.audit_events (pet_id, occurred_at desc);
create index audit_events_org_time_idx on private.audit_events (organization_id, occurred_at desc);
create index audit_events_actor_profile_idx on private.audit_events (actor_profile_id, occurred_at desc);
create index audit_events_actor_staff_idx on private.audit_events (actor_staff_id, occurred_at desc);
create index authorization_tokens_authorization_idx on private.pet_clinic_authorization_tokens (authorization_id);

create trigger veterinary_organizations_set_updated_at before update on public.veterinary_organizations
for each row execute function public.set_updated_at();
create trigger veterinary_staff_set_updated_at before update on public.veterinary_staff
for each row execute function public.set_updated_at();
create trigger medical_visits_set_updated_at before update on public.medical_visits
for each row execute function public.set_updated_at();
create trigger medical_documents_set_updated_at before update on public.medical_documents
for each row execute function public.set_updated_at();
create trigger diagnostic_reports_set_updated_at before update on public.diagnostic_reports
for each row execute function public.set_updated_at();
create trigger diagnostic_results_set_updated_at before update on public.diagnostic_results
for each row execute function public.set_updated_at();
create trigger veterinary_staff_credentials_set_updated_at before update on private.veterinary_staff_credentials
for each row execute function public.set_updated_at();
create trigger medical_document_processing_set_updated_at before update on private.medical_document_processing
for each row execute function public.set_updated_at();

-- RLS helper functions deliberately use the current Auth UUID -> USR mapping.
create or replace function private.current_active_staff_id(target_organization_id text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select staff.id
  from public.veterinary_staff staff
  join public.veterinary_organizations organization on organization.id = staff.organization_id
  where staff.organization_id = target_organization_id
    and staff.profile_id = (select private.current_profile_id())
    and staff.status = 'active'
    and staff.revoked_at is null
    and organization.verification_status = 'verified'
    and organization.archived_at is null
  limit 1
$$;

create or replace function private.is_active_clinic_admin(target_organization_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.veterinary_staff staff
    join public.veterinary_organizations organization on organization.id = staff.organization_id
    where staff.organization_id = target_organization_id
      and staff.profile_id = (select private.current_profile_id())
      and staff.role = 'clinic_admin'
      and staff.status = 'active'
      and staff.revoked_at is null
      and organization.verification_status = 'verified'
      and organization.archived_at is null
  )
$$;

create or replace function private.has_active_clinic_authorization(
  target_pet_id text,
  target_organization_id text,
  required_scope public.clinic_authorization_scope
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select private.current_active_staff_id(target_organization_id)) is not null
    and exists (
      select 1
      from public.pet_clinic_authorizations authz
      where authz.pet_id = target_pet_id
        and authz.organization_id = target_organization_id
        and authz.status = 'active'
        and authz.revoked_at is null
        and (authz.expires_at is null or authz.expires_at > now())
        and required_scope = any(authz.scope)
    )
$$;

create or replace function private.has_medical_access(
  target_pet_id text,
  required_scope public.medical_access_scope
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.pets pet
    where pet.id = target_pet_id
      and (
        pet.owner_id = (select private.current_profile_id())
        or exists (
          select 1
          from public.medical_access_grants access_grant
          where access_grant.pet_id = pet.id
            and access_grant.grantee_profile_id = (select private.current_profile_id())
            and access_grant.status = 'active'
            and access_grant.revoked_at is null
            and (access_grant.expires_at is null or access_grant.expires_at > now())
            and required_scope = any(access_grant.scope)
        )
      )
  )
$$;

create or replace function private.can_read_medical_document_path(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.medical_documents document
    where document.storage_path = object_name
      and (
        (
          document.status in ('published', 'superseded')
          and (select private.has_medical_access(document.pet_id, 'view_document'))
        )
        or (
          document.source_type = 'owner_uploaded_unverified'
          and document.uploaded_by_profile_id = (select private.current_profile_id())
        )
        or (
          document.organization_id is not null
          and (select private.has_active_clinic_authorization(
            document.pet_id, document.organization_id, 'view_records'
          ))
        )
      )
  )
$$;

create or replace function private.can_write_medical_document_path(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.medical_documents document
    where document.storage_path = object_name
      and document.status in ('uploading', 'draft', 'rejected')
      and (
        (
          document.source_type = 'owner_uploaded_unverified'
          and document.owner_id = (select private.current_profile_id())
          and document.uploaded_by_profile_id = (select private.current_profile_id())
        )
        or (
          document.organization_id is not null
          and (select private.has_active_clinic_authorization(
            document.pet_id, document.organization_id, 'upload_document'
          ))
        )
      )
  )
$$;

revoke all on function private.current_active_staff_id(text) from public, anon;
revoke all on function private.is_active_clinic_admin(text) from public, anon;
revoke all on function private.has_active_clinic_authorization(text, text, public.clinic_authorization_scope) from public, anon;
revoke all on function private.has_medical_access(text, public.medical_access_scope) from public, anon;
revoke all on function private.can_read_medical_document_path(text) from public, anon;
revoke all on function private.can_write_medical_document_path(text) from public, anon;
grant execute on function private.current_active_staff_id(text) to authenticated;
grant execute on function private.is_active_clinic_admin(text) to authenticated;
grant execute on function private.has_active_clinic_authorization(text, text, public.clinic_authorization_scope) to authenticated;
grant execute on function private.has_medical_access(text, public.medical_access_scope) to authenticated;
grant execute on function private.can_read_medical_document_path(text) to authenticated;
grant execute on function private.can_write_medical_document_path(text) to authenticated;

-- Owners may only revoke grants after creation; identity, scope and consent
-- evidence cannot be silently rewritten.
create or replace function private.protect_medical_authorization()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'active' or old.revoked_at is not null then
    raise exception 'A closed medical authorization is immutable';
  end if;

  if new.id is distinct from old.id
    or new.owner_id is distinct from old.owner_id
    or new.pet_id is distinct from old.pet_id
    or to_jsonb(new.scope) is distinct from to_jsonb(old.scope)
    or new.granted_at is distinct from old.granted_at
    or new.expires_at is distinct from old.expires_at
    or new.created_at is distinct from old.created_at
  then
    raise exception 'Medical authorization identity and scope are immutable';
  end if;

  if tg_table_name = 'pet_clinic_authorizations' then
    if new.organization_id is distinct from old.organization_id
      or new.policy_version is distinct from old.policy_version
      or new.locale is distinct from old.locale
    then
      raise exception 'Clinic authorization consent evidence is immutable';
    end if;
  elsif tg_table_name = 'medical_access_grants' then
    if new.grantee_profile_id is distinct from old.grantee_profile_id then
      raise exception 'Medical access recipient is immutable';
    end if;
  end if;

  new.status := 'revoked';
  new.revoked_at := now();
  new.updated_at := now();
  return new;
end;
$$;

create trigger pet_clinic_authorizations_protect before update on public.pet_clinic_authorizations
for each row execute function private.protect_medical_authorization();
create trigger medical_access_grants_protect before update on public.medical_access_grants
for each row execute function private.protect_medical_authorization();

create or replace function private.validate_medical_access_grant_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.pet_memberships membership
    where membership.pet_id = new.pet_id
      and membership.owner_id = new.owner_id
      and membership.user_id = new.grantee_profile_id
  ) then
    raise exception 'Medical access can only be granted to an existing pet caregiver';
  end if;
  return new;
end;
$$;

create trigger medical_access_grants_require_member before insert on public.medical_access_grants
for each row execute function private.validate_medical_access_grant_member();

create or replace function private.canonicalize_medical_document()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  visit_record public.medical_visits;
  file_extension text;
begin
  select * into visit_record from public.medical_visits where id = new.visit_id;
  if not found then
    raise exception 'Medical visit not found';
  end if;

  new.owner_id := visit_record.owner_id;
  new.pet_id := visit_record.pet_id;
  new.organization_id := visit_record.organization_id;
  file_extension := case new.mime_type
    when 'application/pdf' then 'pdf'
    when 'image/jpeg' then 'jpg'
    when 'image/png' then 'png'
    when 'image/webp' then 'webp'
    when 'image/heic' then 'heic'
    when 'image/heif' then 'heif'
    else 'bin'
  end;
  new.storage_path := new.owner_id || '/' || new.pet_id || '/' || new.visit_id || '/' || new.id || '/document.' || file_extension;
  return new;
end;
$$;

create trigger medical_documents_canonicalize before insert on public.medical_documents
for each row execute function private.canonicalize_medical_document();

create or replace function private.set_diagnostic_report_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  visit_record public.medical_visits;
begin
  select * into visit_record from public.medical_visits where id = new.visit_id;
  if not found then raise exception 'Medical visit not found'; end if;
  new.owner_id := visit_record.owner_id;
  new.pet_id := visit_record.pet_id;
  new.organization_id := visit_record.organization_id;
  if new.document_id is not null and not exists (
    select 1 from public.medical_documents document
    where document.id = new.document_id and document.visit_id = new.visit_id
  ) then
    raise exception 'Diagnostic report document must belong to the same visit';
  end if;
  return new;
end;
$$;

create trigger diagnostic_reports_set_context before insert on public.diagnostic_reports
for each row execute function private.set_diagnostic_report_context();

create or replace function private.set_diagnostic_result_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  report_record public.diagnostic_reports;
begin
  select * into report_record from public.diagnostic_reports where id = new.report_id;
  if not found then raise exception 'Diagnostic report not found'; end if;
  if report_record.status <> 'draft' then
    raise exception 'Results can only be added to a draft diagnostic report';
  end if;
  new.owner_id := report_record.owner_id;
  new.pet_id := report_record.pet_id;
  new.organization_id := report_record.organization_id;
  return new;
end;
$$;

create trigger diagnostic_results_set_context before insert on public.diagnostic_results
for each row execute function private.set_diagnostic_result_context();

create or replace function private.protect_medical_draft()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    if tg_table_name = 'medical_visits' then
      if old.status <> 'draft' or new.status <> 'draft'
        or new.id is distinct from old.id
        or new.owner_id is distinct from old.owner_id
        or new.pet_id is distinct from old.pet_id
        or new.organization_id is distinct from old.organization_id
        or new.source_type is distinct from old.source_type
        or new.created_by_profile_id is distinct from old.created_by_profile_id
        or new.created_by_staff_id is distinct from old.created_by_staff_id
        or new.received_at is distinct from old.received_at
        or new.supersedes_id is distinct from old.supersedes_id
      then raise exception 'Published identity and provenance are server controlled'; end if;
    elsif tg_table_name = 'diagnostic_reports' then
      if old.status <> 'draft' or new.status <> 'draft'
        or new.id is distinct from old.id
        or new.visit_id is distinct from old.visit_id
        or new.owner_id is distinct from old.owner_id
        or new.pet_id is distinct from old.pet_id
        or new.organization_id is distinct from old.organization_id
        or new.source_type is distinct from old.source_type
        or new.created_by_profile_id is distinct from old.created_by_profile_id
        or new.created_by_staff_id is distinct from old.created_by_staff_id
        or new.supersedes_id is distinct from old.supersedes_id
      then raise exception 'Confirmed identity and provenance are server controlled'; end if;
    elsif tg_table_name = 'diagnostic_results' then
      if new.id is distinct from old.id
        or new.report_id is distinct from old.report_id
        or new.owner_id is distinct from old.owner_id
        or new.pet_id is distinct from old.pet_id
        or new.organization_id is distinct from old.organization_id
        or new.created_by_profile_id is distinct from old.created_by_profile_id
        or new.created_by_staff_id is distinct from old.created_by_staff_id
        or not exists (
          select 1 from public.diagnostic_reports report
          where report.id = old.report_id and report.status = 'draft'
        )
      then raise exception 'Confirmed diagnostic results are immutable'; end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger medical_visits_protect_draft before update on public.medical_visits
for each row execute function private.protect_medical_draft();
create trigger diagnostic_reports_protect_draft before update on public.diagnostic_reports
for each row execute function private.protect_medical_draft();
create trigger diagnostic_results_protect_draft before update on public.diagnostic_results
for each row execute function private.protect_medical_draft();

create or replace function private.validate_medical_provenance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  staff_id text;
  reviewer_id text;
begin
  if tg_table_name = 'medical_documents' then
    staff_id := new.uploaded_by_staff_id;
  else
    staff_id := new.created_by_staff_id;
  end if;

  if new.source_type in ('clinic_submitted', 'veterinarian_reviewed') then
    if new.organization_id is null or staff_id is null or not exists (
      select 1
      from public.veterinary_staff staff
      join public.veterinary_organizations organization
        on organization.id = staff.organization_id
      where staff.id = staff_id
        and staff.organization_id = new.organization_id
        and staff.status = 'active'
        and staff.revoked_at is null
        and organization.verification_status = 'verified'
        and organization.archived_at is null
    ) then raise exception 'Clinic provenance requires active staff in the same organization'; end if;
  end if;

  if new.source_type = 'veterinarian_reviewed' then
    if tg_table_name = 'medical_visits' then
      reviewer_id := new.reviewed_by_staff_id;
    elsif tg_table_name = 'diagnostic_reports' then
      reviewer_id := new.confirmed_by_staff_id;
    else
      reviewer_id := null;
    end if;
    if reviewer_id is null or not exists (
      select 1 from public.veterinary_staff reviewer
      where reviewer.id = reviewer_id
        and reviewer.organization_id = new.organization_id
        and reviewer.role = 'veterinarian'
        and reviewer.status = 'active'
        and reviewer.revoked_at is null
    ) then raise exception 'Veterinarian-reviewed data requires active veterinarian provenance'; end if;
  end if;
  return new;
end;
$$;

create trigger medical_visits_validate_provenance before insert or update on public.medical_visits
for each row execute function private.validate_medical_provenance();
create trigger medical_documents_validate_provenance before insert or update on public.medical_documents
for each row execute function private.validate_medical_provenance();
create trigger diagnostic_reports_validate_provenance before insert or update on public.diagnostic_reports
for each row execute function private.validate_medical_provenance();

create or replace function private.log_sensitive_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_data jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  profile_id text := (select private.current_profile_id());
  organization_id text := nullif(row_data ->> 'organization_id', '');
  staff_id text;
begin
  if organization_id is not null then
    staff_id := (select private.current_active_staff_id(organization_id));
  end if;
  insert into private.audit_events (
    actor_type, actor_profile_id, actor_staff_id, action, target_type, target_id,
    owner_id, pet_id, organization_id, metadata
  ) values (
    case when staff_id is not null then 'veterinary_staff'::private.audit_actor_type
         when profile_id is not null then 'user'::private.audit_actor_type
         else 'service'::private.audit_actor_type end,
    profile_id,
    staff_id,
    lower(tg_op),
    tg_table_name,
    row_data ->> 'id',
    nullif(row_data ->> 'owner_id', ''),
    nullif(row_data ->> 'pet_id', ''),
    organization_id,
    jsonb_strip_nulls(jsonb_build_object('status', row_data ->> 'status'))
  );
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger pet_clinic_authorizations_audit after insert or update on public.pet_clinic_authorizations
for each row execute function private.log_sensitive_change();
create trigger medical_access_grants_audit after insert or update on public.medical_access_grants
for each row execute function private.log_sensitive_change();
create trigger medical_visits_audit after insert or update on public.medical_visits
for each row execute function private.log_sensitive_change();
create trigger medical_documents_audit after insert or update on public.medical_documents
for each row execute function private.log_sensitive_change();
create trigger diagnostic_reports_audit after insert or update on public.diagnostic_reports
for each row execute function private.log_sensitive_change();
create trigger diagnostic_results_audit after insert or update on public.diagnostic_results
for each row execute function private.log_sensitive_change();

revoke all on function private.protect_medical_authorization() from public, anon, authenticated;
revoke all on function private.validate_medical_access_grant_member() from public, anon, authenticated;
revoke all on function private.canonicalize_medical_document() from public, anon, authenticated;
revoke all on function private.set_diagnostic_report_context() from public, anon, authenticated;
revoke all on function private.set_diagnostic_result_context() from public, anon, authenticated;
revoke all on function private.protect_medical_draft() from public, anon, authenticated;
revoke all on function private.validate_medical_provenance() from public, anon, authenticated;
revoke all on function private.log_sensitive_change() from public, anon, authenticated;

-- RLS is enabled on every client-facing table. Private tables have RLS with no
-- client policies and no table grants; trusted server functions own those rows.
alter table public.veterinary_organizations enable row level security;
alter table public.veterinary_staff enable row level security;
alter table public.pet_clinic_authorizations enable row level security;
alter table public.medical_access_grants enable row level security;
alter table public.medical_visits enable row level security;
alter table public.medical_documents enable row level security;
alter table public.diagnostic_reports enable row level security;
alter table public.diagnostic_results enable row level security;
alter table public.medical_record_versions enable row level security;
alter table private.veterinary_staff_credentials enable row level security;
alter table private.pet_clinic_authorization_tokens enable row level security;
alter table private.medical_document_processing enable row level security;
alter table private.audit_events enable row level security;

create policy "Authenticated users can discover verified veterinary organizations"
on public.veterinary_organizations for select to authenticated
using (
  (verification_status = 'verified' and archived_at is null)
  or exists (
    select 1 from public.veterinary_staff staff
    where staff.organization_id = id
      and staff.profile_id = (select private.current_profile_id())
  )
);

create policy "Staff can read their own organization memberships"
on public.veterinary_staff for select to authenticated
using (
  profile_id = (select private.current_profile_id())
  or (select private.is_active_clinic_admin(organization_id))
);

create policy "Owners and authorized clinic staff can read clinic authorizations"
on public.pet_clinic_authorizations for select to authenticated
using (
  owner_id = (select private.current_profile_id())
  or (select private.current_active_staff_id(organization_id)) is not null
);

create policy "Owners can create clinic authorizations"
on public.pet_clinic_authorizations for insert to authenticated
with check (
  owner_id = (select private.current_profile_id())
  and status = 'active'
  and revoked_at is null
  and exists (
    select 1 from public.pets pet
    where pet.id = pet_id and pet.owner_id = (select private.current_profile_id())
  )
  and exists (
    select 1 from public.veterinary_organizations organization
    where organization.id = organization_id
      and organization.verification_status = 'verified'
      and organization.archived_at is null
  )
);

create policy "Owners can revoke clinic authorizations"
on public.pet_clinic_authorizations for update to authenticated
using (owner_id = (select private.current_profile_id()))
with check (owner_id = (select private.current_profile_id()));

create policy "Grant owners and recipients can read medical access grants"
on public.medical_access_grants for select to authenticated
using (
  owner_id = (select private.current_profile_id())
  or grantee_profile_id = (select private.current_profile_id())
);

create policy "Owners can create medical access grants"
on public.medical_access_grants for insert to authenticated
with check (
  owner_id = (select private.current_profile_id())
  and status = 'active'
  and revoked_at is null
  and exists (
    select 1 from public.pets pet
    where pet.id = pet_id and pet.owner_id = (select private.current_profile_id())
  )
);

create policy "Owners can revoke medical access grants"
on public.medical_access_grants for update to authenticated
using (owner_id = (select private.current_profile_id()))
with check (owner_id = (select private.current_profile_id()));

create policy "Explicit medical viewers and authorized clinics can read visits"
on public.medical_visits for select to authenticated
using (
  (
    (select private.has_medical_access(pet_id, 'view_visit'))
    and (
      status <> 'draft'
      or created_by_profile_id = (select private.current_profile_id())
    )
  )
  or (
    organization_id is not null
    and (select private.has_active_clinic_authorization(pet_id, organization_id, 'view_records'))
  )
);

create policy "Owners and authorized clinics can create visit drafts"
on public.medical_visits for insert to authenticated
with check (
  (
    owner_id = (select private.current_profile_id())
    and created_by_profile_id = (select private.current_profile_id())
    and created_by_staff_id is null
    and organization_id is null
    and source_type = 'owner_reported'
    and status = 'draft'
  )
  or (
    organization_id is not null
    and source_type = 'clinic_submitted'
    and status = 'draft'
    and created_by_profile_id is null
    and created_by_staff_id = (select private.current_active_staff_id(organization_id))
    and (select private.has_active_clinic_authorization(pet_id, organization_id, 'create_visit'))
  )
);

create policy "Draft creators can update visits"
on public.medical_visits for update to authenticated
using (
  status = 'draft'
  and (
    (owner_id = (select private.current_profile_id()) and created_by_profile_id = (select private.current_profile_id()))
    or (
      organization_id is not null
      and (select private.has_active_clinic_authorization(pet_id, organization_id, 'create_visit'))
    )
  )
)
with check (
  status = 'draft'
  and (
    (owner_id = (select private.current_profile_id()) and created_by_profile_id = (select private.current_profile_id()))
    or (
      organization_id is not null
      and (select private.has_active_clinic_authorization(pet_id, organization_id, 'create_visit'))
    )
  )
);

create policy "Explicit medical viewers and authorized clinics can read documents"
on public.medical_documents for select to authenticated
using (
  (
    (status in ('published', 'superseded') or uploaded_by_profile_id = (select private.current_profile_id()))
    and (select private.has_medical_access(pet_id, 'view_document'))
  )
  or (
    organization_id is not null
    and (select private.has_active_clinic_authorization(pet_id, organization_id, 'view_records'))
  )
);

create policy "Owners and authorized clinics can prepare document uploads"
on public.medical_documents for insert to authenticated
with check (
  status = 'uploading'
  and (
    (
      owner_id = (select private.current_profile_id())
      and source_type = 'owner_uploaded_unverified'
      and uploaded_by_profile_id = (select private.current_profile_id())
      and uploaded_by_staff_id is null
    )
    or (
      organization_id is not null
      and source_type = 'clinic_submitted'
      and uploaded_by_profile_id is null
      and uploaded_by_staff_id = (select private.current_active_staff_id(organization_id))
      and (select private.has_active_clinic_authorization(pet_id, organization_id, 'upload_document'))
    )
  )
);

create policy "Explicit medical viewers and authorized clinics can read diagnostic reports"
on public.diagnostic_reports for select to authenticated
using (
  (
    (status <> 'draft' or created_by_profile_id = (select private.current_profile_id()))
    and (select private.has_medical_access(pet_id, 'view_diagnostic_result'))
  )
  or (
    organization_id is not null
    and (select private.has_active_clinic_authorization(pet_id, organization_id, 'view_records'))
  )
);

create policy "Authorized clinics can create diagnostic report drafts"
on public.diagnostic_reports for insert to authenticated
with check (
  organization_id is not null
  and status = 'draft'
  and source_type = 'clinic_submitted'
  and created_by_profile_id is null
  and created_by_staff_id = (select private.current_active_staff_id(organization_id))
  and (select private.has_active_clinic_authorization(pet_id, organization_id, 'write_diagnostic_result'))
);

create policy "Authorized clinics can update diagnostic report drafts"
on public.diagnostic_reports for update to authenticated
using (
  status = 'draft'
  and organization_id is not null
  and (select private.has_active_clinic_authorization(pet_id, organization_id, 'write_diagnostic_result'))
)
with check (
  status = 'draft'
  and organization_id is not null
  and (select private.has_active_clinic_authorization(pet_id, organization_id, 'write_diagnostic_result'))
);

create policy "Explicit medical viewers and authorized clinics can read diagnostic results"
on public.diagnostic_results for select to authenticated
using (
  (
    (select private.has_medical_access(pet_id, 'view_diagnostic_result'))
    and exists (
      select 1 from public.diagnostic_reports report
      where report.id = report_id and report.status <> 'draft'
    )
  )
  or (
    organization_id is not null
    and (select private.has_active_clinic_authorization(pet_id, organization_id, 'view_records'))
  )
);

create policy "Authorized clinics can add diagnostic results to drafts"
on public.diagnostic_results for insert to authenticated
with check (
  organization_id is not null
  and created_by_profile_id is null
  and created_by_staff_id = (select private.current_active_staff_id(organization_id))
  and (select private.has_active_clinic_authorization(pet_id, organization_id, 'write_diagnostic_result'))
  and exists (
    select 1 from public.diagnostic_reports report
    where report.id = report_id and report.status = 'draft'
  )
);

create policy "Authorized clinics can update draft diagnostic results"
on public.diagnostic_results for update to authenticated
using (
  organization_id is not null
  and (select private.has_active_clinic_authorization(pet_id, organization_id, 'write_diagnostic_result'))
  and exists (
    select 1 from public.diagnostic_reports report
    where report.id = report_id and report.status = 'draft'
  )
)
with check (
  organization_id is not null
  and (select private.has_active_clinic_authorization(pet_id, organization_id, 'write_diagnostic_result'))
  and exists (
    select 1 from public.diagnostic_reports report
    where report.id = report_id and report.status = 'draft'
  )
);

create policy "Explicit medical viewers and authorized clinics can read version history"
on public.medical_record_versions for select to authenticated
using (
  (select private.has_medical_access(
    pet_id,
    case entity_type
      when 'medical_visit' then 'view_visit'::public.medical_access_scope
      when 'medical_document' then 'view_document'::public.medical_access_scope
      else 'view_diagnostic_result'::public.medical_access_scope
    end
  ))
  or (
    organization_id is not null
    and (select private.has_active_clinic_authorization(pet_id, organization_id, 'view_records'))
  )
);

-- Explicit client grants. There are intentionally no direct client grants for
-- organization/staff administration, medical versions, private evidence,
-- authorization secrets, file scan details or audit events.
revoke all on table public.veterinary_organizations from anon, authenticated;
revoke all on table public.veterinary_staff from anon, authenticated;
revoke all on table public.pet_clinic_authorizations from anon, authenticated;
revoke all on table public.medical_access_grants from anon, authenticated;
revoke all on table public.medical_visits from anon, authenticated;
revoke all on table public.medical_documents from anon, authenticated;
revoke all on table public.diagnostic_reports from anon, authenticated;
revoke all on table public.diagnostic_results from anon, authenticated;
revoke all on table public.medical_record_versions from anon, authenticated;
revoke all on table private.veterinary_staff_credentials from public, anon, authenticated;
revoke all on table private.pet_clinic_authorization_tokens from public, anon, authenticated;
revoke all on table private.medical_document_processing from public, anon, authenticated;
revoke all on table private.audit_events from public, anon, authenticated;

grant select on table public.veterinary_organizations to authenticated;
grant select on table public.veterinary_staff to authenticated;
grant select, insert, update on table public.pet_clinic_authorizations to authenticated;
grant select, insert, update on table public.medical_access_grants to authenticated;
grant select, insert, update on table public.medical_visits to authenticated;
grant select, insert on table public.medical_documents to authenticated;
grant select, insert, update on table public.diagnostic_reports to authenticated;
grant select, insert, update on table public.diagnostic_results to authenticated;
grant select on table public.medical_record_versions to authenticated;

grant usage on type public.medical_source_type to authenticated;
grant usage on type public.organization_verification_status to authenticated;
grant usage on type public.veterinary_staff_role to authenticated;
grant usage on type public.veterinary_staff_status to authenticated;
grant usage on type public.authorization_status to authenticated;
grant usage on type public.clinic_authorization_scope to authenticated;
grant usage on type public.medical_access_scope to authenticated;
grant usage on type public.medical_visit_status to authenticated;
grant usage on type public.medical_document_status to authenticated;
grant usage on type public.diagnostic_report_status to authenticated;
grant usage on type public.diagnostic_flag to authenticated;
grant usage on type public.medical_entity_type to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'medical-media',
  'medical-media',
  false,
  25165824,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "Authorized medical users can read medical media"
on storage.objects for select to authenticated
using (
  bucket_id = 'medical-media'
  and (select private.can_read_medical_document_path(name))
);

create policy "Authorized medical uploaders can upload medical media"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'medical-media'
  and (select private.can_write_medical_document_path(name))
);

create policy "Authorized medical uploaders can replace draft medical media"
on storage.objects for update to authenticated
using (
  bucket_id = 'medical-media'
  and (select private.can_write_medical_document_path(name))
)
with check (
  bucket_id = 'medical-media'
  and (select private.can_write_medical_document_path(name))
);

create policy "Authorized medical uploaders can delete draft medical media"
on storage.objects for delete to authenticated
using (
  bucket_id = 'medical-media'
  and (select private.can_write_medical_document_path(name))
);

comment on table public.medical_visits is
  'Formal pet medical visits. Lifestyle care_records remain a separate domain.';
comment on table public.medical_documents is
  'One private medical file per row; storage paths are server-canonicalized.';
comment on table public.diagnostic_results is
  'Clinic-provided result values, original units, reference ranges and flags; not diagnoses.';
comment on table private.audit_events is
  'Non-client audit trail containing metadata only, never document contents or raw authorization secrets.';
comment on column public.medical_visits.received_at is
  'Server receipt time; distinct from the real-world occurred_at and submitter-entered recorded_at.';
comment on column public.medical_documents.sha256 is
  'Content integrity/deduplication evidence, never an authorization credential.';

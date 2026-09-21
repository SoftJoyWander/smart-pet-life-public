-- Stool-presence screening MVP.
-- Images are operational inputs only: no training-consent field is inferred here.
-- Routing thresholds intentionally remain NULL, so every model result requires review.

-- Extend the repository's allow-listed prefixed ID generator for this bounded domain.
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
    'VOR', 'VST', 'PCA', 'MAG', 'VIS', 'DOC', 'DGR', 'DGS', 'MRV', 'AUD',
    'STO', 'INF', 'RVQ', 'ANN'
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

create table public.stool_observations (
  id text primary key default private.generate_entity_id('STO'),
  owner_id text not null references public.profiles(id) on delete cascade,
  pet_id text not null references public.pets(id) on delete cascade,
  captured_by text not null references public.profiles(id),
  client_request_key text not null,
  captured_at timestamptz not null,
  captured_timezone text not null,
  received_at timestamptz not null default now(),
  capture_method text not null default 'live_camera'
    check (capture_method = 'live_camera'),
  media_path text,
  content_type text,
  byte_size bigint,
  analysis_status text not null default 'awaiting_upload'
    check (analysis_status in (
      'awaiting_upload', 'queued', 'analysing', 'awaiting_human_review',
      'completed', 'failed', 'cancelled', 'deletion_requested', 'deleted'
    )),
  owner_visible_result text
    check (owner_visible_result is null or owner_visible_result in ('present', 'absent', 'uncertain', 'not_assessable')),
  latest_confidence numeric(7,6)
    check (latest_confidence is null or latest_confidence between 0 and 1),
  failure_code text,
  schema_version text not null default 'stool-observation-v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (captured_by, client_request_key),
  unique (media_path),
  unique (id, pet_id, owner_id)
);

create index stool_observations_pet_received_idx
  on public.stool_observations (pet_id, received_at desc);
create index stool_observations_owner_status_idx
  on public.stool_observations (owner_id, analysis_status, received_at desc);

create table private.stool_model_versions (
  id text primary key,
  task text not null check (task = 'stool_presence'),
  artifact_sha256 text,
  dataset_manifest jsonb not null default '{}'::jsonb,
  preprocessing_version text not null,
  positive_threshold numeric(7,6),
  negative_threshold numeric(7,6),
  threshold_status text not null default 'not_approved'
    check (threshold_status in ('not_approved', 'approved', 'retired')),
  created_at timestamptz not null default now(),
  check (
    (threshold_status = 'not_approved' and positive_threshold is null and negative_threshold is null)
    or (threshold_status <> 'not_approved' and positive_threshold is not null and negative_threshold is not null
      and negative_threshold < positive_threshold)
  )
);

create table private.stool_inference_runs (
  id text primary key default private.generate_entity_id('INF'),
  observation_id text not null references public.stool_observations(id) on delete cascade,
  model_version_id text not null references private.stool_model_versions(id),
  result_code text not null check (result_code in ('present', 'absent', 'uncertain', 'not_assessable')),
  stool_probability numeric(7,6) check (stool_probability is null or stool_probability between 0 and 1),
  review_required boolean not null default true,
  raw_response jsonb not null default '{}'::jsonb,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  created_at timestamptz not null default now()
);

create index stool_inference_runs_observation_idx
  on private.stool_inference_runs (observation_id, created_at desc);

create table private.stool_reviewers (
  profile_id text primary key references public.profiles(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table private.stool_review_queue (
  id text primary key default private.generate_entity_id('RVQ'),
  observation_id text not null unique references public.stool_observations(id) on delete cascade,
  inference_run_id text not null references private.stool_inference_runs(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'claimed', 'completed', 'cancelled')),
  priority smallint not null default 100,
  claimed_by text references public.profiles(id),
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index stool_review_queue_work_idx
  on private.stool_review_queue (status, priority, created_at);

create table private.stool_annotations (
  id text primary key default private.generate_entity_id('ANN'),
  observation_id text not null references public.stool_observations(id) on delete cascade,
  inference_run_id text references private.stool_inference_runs(id),
  reviewer_profile_id text not null references public.profiles(id),
  label text not null check (label in ('present', 'absent', 'not_assessable')),
  note text,
  provenance text not null default 'human_review' check (provenance = 'human_review'),
  created_at timestamptz not null default now()
);

create index stool_annotations_observation_idx
  on private.stool_annotations (observation_id, created_at desc);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('stool-media', 'stool-media', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function private.can_edit_stool_media(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.stool_observations observation
    where observation.owner_id = split_part(object_name, '/', 1)
      and observation.pet_id = split_part(object_name, '/', 2)
      and observation.id = split_part(object_name, '/', 3)
      and observation.captured_by = (select private.current_profile_id())
      and observation.analysis_status = 'awaiting_upload'
      and (select private.can_edit_pet(observation.pet_id))
  )
$$;

revoke all on function private.can_edit_stool_media(text) from public, anon;
grant execute on function private.can_edit_stool_media(text) to authenticated;

alter table public.stool_observations enable row level security;
create policy "Authorized users can read stool observations"
on public.stool_observations for select to authenticated
using ((select private.can_access_pet(pet_id)));

create policy "Capturers can upload stool media"
on storage.objects for insert to authenticated
with check (bucket_id = 'stool-media' and (select private.can_edit_stool_media(name)));
create policy "Capturers can replace stool media before analysis"
on storage.objects for update to authenticated
using (bucket_id = 'stool-media' and (select private.can_edit_stool_media(name)))
with check (bucket_id = 'stool-media' and (select private.can_edit_stool_media(name)));
create policy "Capturers can remove stool media before analysis"
on storage.objects for delete to authenticated
using (bucket_id = 'stool-media' and (select private.can_edit_stool_media(name)));

revoke all on public.stool_observations from anon;
grant select on public.stool_observations to authenticated;
grant all on public.stool_observations to service_role;

alter table private.stool_model_versions enable row level security;
alter table private.stool_inference_runs enable row level security;
alter table private.stool_reviewers enable row level security;
alter table private.stool_review_queue enable row level security;
alter table private.stool_annotations enable row level security;

revoke all on private.stool_model_versions from public, anon, authenticated;
revoke all on private.stool_inference_runs from public, anon, authenticated;
revoke all on private.stool_reviewers from public, anon, authenticated;
revoke all on private.stool_review_queue from public, anon, authenticated;
revoke all on private.stool_annotations from public, anon, authenticated;

create or replace function public.create_stool_observation(
  stool_pet_id text,
  stool_client_request_key text,
  stool_captured_at timestamptz,
  stool_captured_timezone text
)
returns public.stool_observations
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id text := (select private.current_profile_id());
  pet_owner_id text;
  result public.stool_observations;
begin
  if caller_id is null or not (select private.can_edit_pet(stool_pet_id)) then
    raise exception 'Not allowed to capture for this pet';
  end if;
  if length(trim(stool_client_request_key)) < 8 then
    raise exception 'Invalid client request key';
  end if;
  select owner_id into pet_owner_id from public.pets where id = stool_pet_id;

  insert into public.stool_observations (
    owner_id, pet_id, captured_by, client_request_key, captured_at, captured_timezone
  ) values (
    pet_owner_id, stool_pet_id, caller_id, trim(stool_client_request_key),
    stool_captured_at, coalesce(nullif(trim(stool_captured_timezone), ''), 'UTC')
  )
  on conflict (captured_by, client_request_key) do update
    set updated_at = public.stool_observations.updated_at
  returning * into result;
  return result;
end
$$;

revoke all on function public.create_stool_observation(text, text, timestamptz, text) from public, anon;
grant execute on function public.create_stool_observation(text, text, timestamptz, text) to authenticated;

create or replace function public.queue_stool_observation_analysis(
  stool_observation_id text,
  stool_media_path text,
  stool_content_type text,
  stool_byte_size bigint
)
returns public.stool_observations
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id text := (select private.current_profile_id());
  result public.stool_observations;
begin
  update public.stool_observations observation
  set media_path = stool_media_path,
      content_type = stool_content_type,
      byte_size = stool_byte_size,
      analysis_status = 'queued',
      failure_code = null,
      updated_at = now()
  where observation.id = stool_observation_id
    and observation.captured_by = caller_id
    and observation.analysis_status in ('awaiting_upload', 'failed')
    and stool_media_path = observation.owner_id || '/' || observation.pet_id || '/' || observation.id || '/analysis.jpg'
    and stool_content_type = 'image/jpeg'
    and stool_byte_size between 1 and 10485760
    and (select private.can_edit_pet(observation.pet_id))
  returning * into result;
  if result.id is null then raise exception 'Observation cannot be queued'; end if;
  return result;
end
$$;

revoke all on function public.queue_stool_observation_analysis(text, text, text, bigint) from public, anon;
grant execute on function public.queue_stool_observation_analysis(text, text, text, bigint) to authenticated;

create or replace function public.begin_stool_observation_analysis(stool_observation_id text)
returns public.stool_observations
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id text := (select private.current_profile_id());
  result public.stool_observations;
begin
  update public.stool_observations observation
  set analysis_status = 'analysing', updated_at = now()
  where observation.id = stool_observation_id
    and observation.captured_by = caller_id
    and observation.analysis_status = 'queued'
    and (select private.can_edit_pet(observation.pet_id))
  returning * into result;
  if result.id is null then raise exception 'Observation cannot begin analysis'; end if;
  return result;
end
$$;

revoke all on function public.begin_stool_observation_analysis(text) from public, anon;
grant execute on function public.begin_stool_observation_analysis(text) to authenticated;

-- Backend-only recording function. Thresholds stay unapproved, therefore review_required is forced true.
create or replace function public.record_stool_inference_result(
  stool_observation_id text,
  stool_model_version text,
  stool_probability numeric,
  stool_raw_response jsonb,
  stool_latency_ms integer
)
returns public.stool_observations
language plpgsql
security definer
set search_path = ''
as $$
declare
  inference_id text;
  result public.stool_observations;
begin
  if stool_probability < 0 or stool_probability > 1 then raise exception 'Invalid probability'; end if;

  insert into private.stool_model_versions (id, task, preprocessing_version)
  values (stool_model_version, 'stool_presence', 'imagenet-center-crop-v1')
  on conflict (id) do nothing;

  insert into private.stool_inference_runs (
    observation_id, model_version_id, result_code, stool_probability,
    review_required, raw_response, latency_ms
  ) values (
    stool_observation_id, stool_model_version, 'uncertain', stool_probability,
    true, coalesce(stool_raw_response, '{}'::jsonb), stool_latency_ms
  ) returning id into inference_id;

  insert into private.stool_review_queue (observation_id, inference_run_id)
  values (stool_observation_id, inference_id)
  on conflict (observation_id) do update set
    inference_run_id = excluded.inference_run_id,
    status = 'pending', claimed_by = null, claimed_at = null, completed_at = null;

  update public.stool_observations
  set analysis_status = 'awaiting_human_review', owner_visible_result = 'uncertain',
      latest_confidence = stool_probability, failure_code = null, updated_at = now()
  where id = stool_observation_id and analysis_status in ('queued', 'analysing')
  returning * into result;
  if result.id is null then raise exception 'Observation is not queued'; end if;
  return result;
end
$$;

revoke all on function public.record_stool_inference_result(text, text, numeric, jsonb, integer) from public, anon, authenticated;
grant execute on function public.record_stool_inference_result(text, text, numeric, jsonb, integer) to service_role;

create or replace function public.record_stool_inference_failure(
  stool_observation_id text,
  stool_failure_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.stool_observations
  set analysis_status = 'failed', failure_code = left(coalesce(stool_failure_code, 'inference_failed'), 80), updated_at = now()
  where id = stool_observation_id and analysis_status = 'analysing';
end
$$;

revoke all on function public.record_stool_inference_failure(text, text) from public, anon, authenticated;
grant execute on function public.record_stool_inference_failure(text, text) to service_role;

create or replace function public.claim_next_stool_review()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id text := (select private.current_profile_id());
  queue_row private.stool_review_queue;
  observation public.stool_observations;
begin
  if not exists (select 1 from private.stool_reviewers where profile_id = caller_id and status = 'active') then
    raise exception 'Reviewer access required';
  end if;
  select * into queue_row
  from private.stool_review_queue
  where status = 'pending'
  order by priority asc, created_at asc
  for update skip locked
  limit 1;
  if queue_row.id is null then return null; end if;
  update private.stool_review_queue
  set status = 'claimed', claimed_by = caller_id, claimed_at = now()
  where id = queue_row.id;
  select * into observation from public.stool_observations where id = queue_row.observation_id;
  return jsonb_build_object(
    'queueId', queue_row.id,
    'observationId', observation.id,
    'mediaPath', observation.media_path,
    'modelConfidence', observation.latest_confidence,
    'capturedAt', observation.captured_at
  );
end
$$;

revoke all on function public.claim_next_stool_review() from public, anon;
grant execute on function public.claim_next_stool_review() to authenticated;

create or replace function public.submit_stool_human_review(
  stool_observation_id text,
  stool_label text,
  stool_note text default null
)
returns public.stool_observations
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id text := (select private.current_profile_id());
  inference_id text;
  result public.stool_observations;
begin
  if stool_label not in ('present', 'absent', 'not_assessable') then raise exception 'Invalid review label'; end if;
  if not exists (select 1 from private.stool_reviewers where profile_id = caller_id and status = 'active') then
    raise exception 'Reviewer access required';
  end if;
  select inference_run_id into inference_id
  from private.stool_review_queue
  where observation_id = stool_observation_id and status in ('pending', 'claimed')
  for update;
  if inference_id is null then raise exception 'No pending review'; end if;

  insert into private.stool_annotations (
    observation_id, inference_run_id, reviewer_profile_id, label, note
  ) values (stool_observation_id, inference_id, caller_id, stool_label, nullif(trim(stool_note), ''));
  update private.stool_review_queue
  set status = 'completed', claimed_by = caller_id, claimed_at = coalesce(claimed_at, now()), completed_at = now()
  where observation_id = stool_observation_id;
  update public.stool_observations
  set analysis_status = 'completed', owner_visible_result = stool_label, updated_at = now()
  where id = stool_observation_id
  returning * into result;
  return result;
end
$$;

revoke all on function public.submit_stool_human_review(text, text, text) from public, anon;
grant execute on function public.submit_stool_human_review(text, text, text) to authenticated;

create trigger stool_observations_protect_id before update on public.stool_observations
for each row execute function private.protect_entity_id();

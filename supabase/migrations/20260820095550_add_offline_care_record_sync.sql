-- Offline-first routine care records.
-- Device event time is accepted only for explicitly marked offline owner/caregiver
-- reports. The server still owns received_at, created_at, and recorded_by.

alter table public.care_records
  add column recorded_by text references public.profiles(id) on delete set null,
  add column client_request_key text,
  add column recorded_timezone text,
  add column received_at timestamptz,
  add column capture_mode text not null default 'online';

update public.care_records
set received_at = created_at
where received_at is null;

alter table public.care_records
  alter column received_at set default now(),
  alter column received_at set not null,
  add constraint care_records_capture_mode_check
    check (capture_mode in ('online', 'offline')),
  add constraint care_records_offline_provenance_check
    check (
      capture_mode <> 'offline'
      or (
        source = 'manual'::public.record_source
        and kind in (
          'meal'::public.care_record_kind,
          'water'::public.care_record_kind,
          'stool'::public.care_record_kind,
          'urine'::public.care_record_kind
        )
        and recorded_by is not null
        and client_request_key is not null
        and recorded_timezone is not null
      )
    );

create unique index care_records_recorded_by_request_key_idx
  on public.care_records(recorded_by, client_request_key)
  where client_request_key is not null;

create index care_records_pending_provenance_idx
  on public.care_records(pet_id, received_at desc)
  where capture_mode = 'offline';

create or replace function public.set_care_record_server_time()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  linked_walk public.walk_sessions%rowtype;
  caller_id text := (select private.current_profile_id());
begin
  new.created_at = now();
  new.received_at = now();
  new.recorded_by = caller_id;

  if new.source = 'walk_tracking'::public.record_source then
    if new.walk_session_id is null then
      raise exception 'walk_tracking care records require walk_session_id';
    end if;

    select walk.* into linked_walk
    from public.walk_sessions walk
    where walk.id = new.walk_session_id;

    if not found
      or linked_walk.pet_id <> new.pet_id
      or linked_walk.owner_id <> new.owner_id
      or new.occurred_at < linked_walk.started_at
      or new.occurred_at > linked_walk.ended_at then
      raise exception 'Walk event must belong to the linked pet and walk time range';
    end if;

    new.capture_mode = 'online';
    new.client_request_key = null;
    new.recorded_timezone = null;
  elsif new.capture_mode = 'offline' then
    if caller_id is null or not (select private.can_edit_pet(new.pet_id)) then
      raise exception 'Only an authorized pet editor can sync offline care records';
    end if;
    if new.walk_session_id is not null then
      raise exception 'Offline routine care records cannot link to a walk session';
    end if;
    if new.source <> 'manual'::public.record_source
      or new.kind not in (
        'meal'::public.care_record_kind,
        'water'::public.care_record_kind,
        'stool'::public.care_record_kind,
        'urine'::public.care_record_kind
      ) then
      raise exception 'This care record kind cannot be synced from the offline queue';
    end if;
    if new.client_request_key is null
      or length(new.client_request_key) < 16
      or length(new.client_request_key) > 180
      or new.client_request_key !~ '^[A-Za-z0-9:._-]+$' then
      raise exception 'Invalid offline client request key';
    end if;
    if new.recorded_timezone is null
      or length(new.recorded_timezone) > 64
      or not exists (
        select 1 from pg_catalog.pg_timezone_names timezone_name
        where timezone_name.name = new.recorded_timezone
      ) then
      raise exception 'Invalid offline record timezone';
    end if;
    if new.occurred_at is null or new.occurred_at > now() + interval '5 minutes' then
      raise exception 'Offline occurrence time cannot be in the future';
    end if;
  else
    if new.walk_session_id is not null then
      raise exception 'Only walk_tracking care records may link to a walk session';
    end if;
    new.capture_mode = 'online';
    new.client_request_key = null;
    new.recorded_timezone = null;
    new.occurred_at = now();
  end if;

  return new;
end;
$$;

create or replace function public.protect_care_record_time()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.occurred_at is distinct from old.occurred_at then
    raise exception 'care_records.occurred_at cannot be changed';
  end if;

  new.created_at = old.created_at;
  new.received_at = old.received_at;
  new.recorded_by = old.recorded_by;
  new.client_request_key = old.client_request_key;
  new.recorded_timezone = old.recorded_timezone;
  new.capture_mode = old.capture_mode;
  return new;
end;
$$;

create or replace function public.sync_offline_care_record(
  offline_pet_id text,
  offline_client_request_key text,
  offline_occurred_at timestamptz,
  offline_timezone text,
  offline_kind public.care_record_kind,
  offline_title text,
  offline_note text,
  offline_amount numeric,
  offline_unit text,
  offline_food_type text,
  offline_stool_texture text,
  offline_stool_color text,
  offline_stool_status text,
  offline_urine_color text,
  offline_metadata jsonb
)
returns public.care_records
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id text := (select private.current_profile_id());
  pet_owner_id text;
  synced_record public.care_records%rowtype;
begin
  if caller_id is null or not (select private.can_edit_pet(offline_pet_id)) then
    raise exception 'Only an authorized pet editor can sync offline care records';
  end if;

  select pet.owner_id into pet_owner_id
  from public.pets pet
  where pet.id = offline_pet_id;

  if pet_owner_id is null then
    raise exception 'Pet not found';
  end if;

  if offline_metadata is null or jsonb_typeof(offline_metadata) <> 'object'
    or octet_length(offline_metadata::text) > 16384 then
    raise exception 'Offline record metadata must be a JSON object under 16 KB';
  end if;

  if length(coalesce(offline_title, '')) > 160
    or length(coalesce(offline_note, '')) > 2000
    or length(coalesce(offline_unit, '')) > 32 then
    raise exception 'Offline record text is too long';
  end if;

  insert into public.care_records (
    owner_id, pet_id, kind, occurred_at, source, amount, unit, food_type,
    stool_texture, stool_color, stool_status, urine_color, title, note,
    metadata, client_request_key, recorded_timezone, capture_mode
  ) values (
    pet_owner_id, offline_pet_id, offline_kind, offline_occurred_at,
    'manual'::public.record_source, offline_amount, offline_unit,
    offline_food_type, offline_stool_texture, offline_stool_color,
    offline_stool_status, offline_urine_color, offline_title, offline_note,
    offline_metadata || jsonb_build_object('offline_sync', true, 'offline_schema_version', 1),
    offline_client_request_key, offline_timezone, 'offline'
  )
  on conflict (recorded_by, client_request_key)
    where client_request_key is not null
  do nothing
  returning * into synced_record;

  if synced_record.id is null then
    select record.* into synced_record
    from public.care_records record
    where record.recorded_by = caller_id
      and record.client_request_key = offline_client_request_key;

    if synced_record.id is null then
      raise exception 'Unable to acknowledge offline care record';
    end if;

    if synced_record.pet_id <> offline_pet_id
      or synced_record.kind <> offline_kind
      or synced_record.occurred_at <> offline_occurred_at then
      raise exception 'Offline request key was already used for different data';
    end if;
  end if;

  return synced_record;
end;
$$;

revoke all on function public.sync_offline_care_record(
  text, text, timestamptz, text, public.care_record_kind, text, text,
  numeric, text, text, text, text, text, text, jsonb
) from public, anon, authenticated;

grant execute on function public.sync_offline_care_record(
  text, text, timestamptz, text, public.care_record_kind, text, text,
  numeric, text, text, text, text, text, text, jsonb
) to authenticated;

-- Completed dog-walk summaries. Raw GPS route points are intentionally not
-- persisted in Supabase; they remain temporary on the user's device.

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
  if entity_prefix not in ('USR', 'PET', 'REC', 'MPL', 'RMN', 'MBR', 'INV', 'PVC', 'WLK') then
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

create table public.walk_sessions (
  id text primary key default private.generate_entity_id('WLK'),
  owner_id text not null,
  pet_id text not null,
  recorded_by text not null references public.profiles(id),
  client_request_key text not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  duration_seconds integer not null,
  distance_m numeric(10, 2) not null,
  average_speed_mps numeric(8, 3) generated always as (
    case when duration_seconds > 0 then distance_m / duration_seconds else 0 end
  ) stored,
  weight_kg_snapshot numeric(6, 2),
  energy_kcal_low numeric(8, 2),
  energy_kcal_high numeric(8, 2),
  energy_model_version text,
  stool_count smallint not null default 0,
  urine_count smallint not null default 0,
  created_at timestamptz not null default now(),
  constraint walk_sessions_id_format check (id ~ '^WLK-[0-9A-F]{8}$'),
  constraint walk_sessions_request_key_format check (
    char_length(client_request_key) between 16 and 160
    and client_request_key ~ '^[A-Za-z0-9:._-]+$'
  ),
  constraint walk_sessions_pet_owner_fk
    foreign key (pet_id, owner_id) references public.pets(id, owner_id) on delete cascade,
  constraint walk_sessions_time_range check (
    ended_at > started_at
    and duration_seconds between 1 and 86400
    and duration_seconds <= extract(epoch from (ended_at - started_at))::integer + 2
  ),
  constraint walk_sessions_distance_range check (distance_m between 0 and 300000),
  constraint walk_sessions_weight_range check (weight_kg_snapshot is null or weight_kg_snapshot between 0.5 and 150),
  constraint walk_sessions_energy_consistency check (
    (energy_kcal_low is null and energy_kcal_high is null and energy_model_version is null)
    or (
      energy_kcal_low is not null
      and energy_kcal_high is not null
      and energy_model_version is not null
      and energy_kcal_low >= 0
      and energy_kcal_high >= energy_kcal_low
    )
  ),
  constraint walk_sessions_event_count_range check (
    stool_count between 0 and 50 and urine_count between 0 and 50
  ),
  unique (pet_id, client_request_key)
);

comment on table public.walk_sessions is
  'Completed dog-walk summaries. Raw GPS points and route geometry are intentionally device-local only.';
comment on column public.walk_sessions.recorded_by is
  'The owner or editor caregiver who held the server walk lease.';
comment on column public.walk_sessions.client_request_key is
  'Stable client key used to make completion retries idempotent.';
comment on column public.walk_sessions.energy_kcal_low is
  'System-derived approximate locomotion energy; not feeding or medical advice.';
comment on column public.walk_sessions.energy_model_version is
  'Versioned coefficient model used for the displayed estimate.';

create index walk_sessions_pet_started_at_idx
  on public.walk_sessions(pet_id, started_at desc);
create index walk_sessions_owner_started_at_idx
  on public.walk_sessions(owner_id, started_at desc);
create index walk_sessions_recorded_by_started_at_idx
  on public.walk_sessions(recorded_by, started_at desc);
create index walk_sessions_pet_owner_fk_idx
  on public.walk_sessions(pet_id, owner_id);

create table private.active_walk_leases (
  pet_id text primary key,
  owner_id text not null,
  holder_id text not null references public.profiles(id) on delete cascade,
  client_request_key text not null,
  lease_token uuid not null default gen_random_uuid(),
  acquired_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 minutes'),
  constraint active_walk_leases_pet_owner_fk
    foreign key (pet_id, owner_id) references public.pets(id, owner_id) on delete cascade,
  constraint active_walk_leases_request_key_format check (
    char_length(client_request_key) between 16 and 160
    and client_request_key ~ '^[A-Za-z0-9:._-]+$'
  ),
  constraint active_walk_leases_time_order check (
    acquired_at <= heartbeat_at and heartbeat_at < expires_at
  )
);

comment on table private.active_walk_leases is
  'Ephemeral one-row-per-pet lease used to prevent concurrent caregiver walks.';

create index active_walk_leases_holder_idx
  on private.active_walk_leases(holder_id);
create index active_walk_leases_expires_at_idx
  on private.active_walk_leases(expires_at);

revoke all on table private.active_walk_leases from public, anon, authenticated;

alter table public.care_records
  add column walk_session_id text references public.walk_sessions(id) on delete set null;

create index care_records_walk_session_idx
  on public.care_records(walk_session_id)
  where walk_session_id is not null;

-- Manual records keep server-assigned time. Walk events may preserve the
-- device event time only when it belongs to the linked walk and pet.
create or replace function public.set_care_record_server_time()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  linked_walk public.walk_sessions%rowtype;
begin
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
  else
    if new.walk_session_id is not null then
      raise exception 'Only walk_tracking care records may link to a walk session';
    end if;
    new.occurred_at = now();
  end if;

  new.created_at = now();
  return new;
end;
$$;

alter table public.walk_sessions enable row level security;

create policy "Authorized users can read walk sessions"
on public.walk_sessions for select to authenticated
using ((select private.can_access_pet(pet_id)));

create policy "Authorized editors can delete walk sessions"
on public.walk_sessions for delete to authenticated
using ((select private.can_edit_pet(pet_id)));

revoke all on table public.walk_sessions from public, anon, authenticated;
grant select, delete on table public.walk_sessions to authenticated;

create trigger walk_sessions_protect_id
before update on public.walk_sessions
for each row execute function private.protect_entity_id();

create or replace function public.begin_walk_session(
  walk_pet_id text,
  walk_client_request_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id text := (select private.current_profile_id());
  session_owner_id text;
  acquired_lease private.active_walk_leases%rowtype;
  active_lease private.active_walk_leases%rowtype;
  holder_name text;
  completed_walk_id text;
begin
  if caller_id is null or not (select private.can_edit_pet(walk_pet_id)) then
    raise exception 'Not authorized to start this pet walk';
  end if;

  if char_length(walk_client_request_key) not between 16 and 160
    or walk_client_request_key !~ '^[A-Za-z0-9:._-]+$' then
    raise exception 'Walk request key is invalid';
  end if;

  select walk.id into completed_walk_id
  from public.walk_sessions walk
  where walk.pet_id = walk_pet_id
    and walk.client_request_key = walk_client_request_key;

  if completed_walk_id is not null then
    return jsonb_build_object(
      'acquired', false,
      'reason', 'already_completed',
      'walk_session_id', completed_walk_id
    );
  end if;

  select pet.owner_id into session_owner_id
  from public.pets pet
  where pet.id = walk_pet_id;

  if session_owner_id is null then
    raise exception 'Pet not found';
  end if;

  insert into private.active_walk_leases (
    pet_id, owner_id, holder_id, client_request_key
  ) values (
    walk_pet_id, session_owner_id, caller_id, walk_client_request_key
  )
  on conflict (pet_id) do update
  set owner_id = excluded.owner_id,
      holder_id = excluded.holder_id,
      client_request_key = excluded.client_request_key,
      lease_token = case
        when active_walk_leases.holder_id = excluded.holder_id
          and active_walk_leases.client_request_key = excluded.client_request_key
          then active_walk_leases.lease_token
        else excluded.lease_token
      end,
      acquired_at = case
        when active_walk_leases.holder_id = excluded.holder_id
          and active_walk_leases.client_request_key = excluded.client_request_key
          then active_walk_leases.acquired_at
        else now()
      end,
      heartbeat_at = now(),
      expires_at = now() + interval '2 minutes'
  where active_walk_leases.expires_at <= now()
     or (
       active_walk_leases.holder_id = excluded.holder_id
       and active_walk_leases.client_request_key = excluded.client_request_key
     )
  returning * into acquired_lease;

  if acquired_lease.pet_id is null then
    select lease.* into active_lease
    from private.active_walk_leases lease
    where lease.pet_id = walk_pet_id;

    select coalesce(nullif(trim(profile.display_name), ''), '其他照護者')
    into holder_name
    from public.profiles profile
    where profile.id = active_lease.holder_id;

    return jsonb_build_object(
      'acquired', false,
      'reason', 'active_by_other',
      'holder_name', holder_name,
      'active_since', active_lease.acquired_at,
      'expires_at', active_lease.expires_at
    );
  end if;

  return jsonb_build_object(
    'acquired', true,
    'lease_token', acquired_lease.lease_token,
    'expires_at', acquired_lease.expires_at
  );
end;
$$;

create or replace function public.heartbeat_walk_session(
  walk_pet_id text,
  walk_client_request_key text,
  walk_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id text := (select private.current_profile_id());
  renewed_lease private.active_walk_leases%rowtype;
begin
  if caller_id is null or not (select private.can_edit_pet(walk_pet_id)) then
    raise exception 'Not authorized to renew this pet walk';
  end if;

  update private.active_walk_leases
  set heartbeat_at = now(),
      expires_at = now() + interval '2 minutes'
  where pet_id = walk_pet_id
    and holder_id = caller_id
    and client_request_key = walk_client_request_key
    and lease_token = walk_lease_token
    and expires_at > now()
  returning * into renewed_lease;

  if renewed_lease.pet_id is null then
    return jsonb_build_object('renewed', false, 'reason', 'lease_lost');
  end if;

  return jsonb_build_object(
    'renewed', true,
    'expires_at', renewed_lease.expires_at
  );
end;
$$;

create or replace function public.abandon_walk_session(
  walk_pet_id text,
  walk_client_request_key text,
  walk_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id text := (select private.current_profile_id());
  removed_pet_id text;
begin
  if caller_id is null or not (select private.can_edit_pet(walk_pet_id)) then
    raise exception 'Not authorized to abandon this pet walk';
  end if;

  delete from private.active_walk_leases
  where pet_id = walk_pet_id
    and holder_id = caller_id
    and client_request_key = walk_client_request_key
    and lease_token = walk_lease_token
  returning pet_id into removed_pet_id;

  return removed_pet_id is not null;
end;
$$;

create or replace function public.complete_walk_session(
  walk_pet_id text,
  walk_client_request_key text,
  walk_lease_token uuid,
  walk_started_at timestamptz,
  walk_ended_at timestamptz,
  walk_duration_seconds integer,
  walk_distance_m numeric,
  walk_weight_kg_snapshot numeric default null,
  walk_energy_kcal_low numeric default null,
  walk_energy_kcal_high numeric default null,
  walk_energy_model_version text default null,
  walk_stool_times timestamptz[] default '{}'::timestamptz[],
  walk_urine_times timestamptz[] default '{}'::timestamptz[]
)
returns public.walk_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id text := (select private.current_profile_id());
  session_owner_id text;
  active_lease private.active_walk_leases%rowtype;
  created_walk public.walk_sessions%rowtype;
  event_time timestamptz;
begin
  if caller_id is null or not (select private.can_edit_pet(walk_pet_id)) then
    raise exception 'Not authorized to record this pet walk';
  end if;

  select walk.* into created_walk
  from public.walk_sessions walk
  where walk.pet_id = walk_pet_id
    and walk.client_request_key = walk_client_request_key;

  if found then
    return created_walk;
  end if;

  select lease.* into active_lease
  from private.active_walk_leases lease
  where lease.pet_id = walk_pet_id
    and lease.holder_id = caller_id
    and lease.client_request_key = walk_client_request_key
    and lease.lease_token = walk_lease_token
    and lease.expires_at > now()
  for update;

  if not found then
    raise exception 'WALK_LEASE_LOST: this pet walk is no longer reserved by this device';
  end if;

  select pet.owner_id into session_owner_id
  from public.pets pet
  where pet.id = walk_pet_id;

  if session_owner_id is null then
    raise exception 'Pet not found';
  end if;

  if walk_ended_at > now() + interval '5 minutes'
    or walk_started_at < walk_ended_at - interval '24 hours' then
    raise exception 'Walk time range is invalid';
  end if;

  if coalesce(cardinality(walk_stool_times), 0) > 50
    or coalesce(cardinality(walk_urine_times), 0) > 50 then
    raise exception 'Walk event count exceeds the allowed range';
  end if;

  foreach event_time in array coalesce(walk_stool_times, '{}'::timestamptz[]) loop
    if event_time < walk_started_at or event_time > walk_ended_at then
      raise exception 'Stool event is outside the walk time range';
    end if;
  end loop;

  foreach event_time in array coalesce(walk_urine_times, '{}'::timestamptz[]) loop
    if event_time < walk_started_at or event_time > walk_ended_at then
      raise exception 'Urine event is outside the walk time range';
    end if;
  end loop;

  insert into public.walk_sessions (
    owner_id,
    pet_id,
    recorded_by,
    client_request_key,
    started_at,
    ended_at,
    duration_seconds,
    distance_m,
    weight_kg_snapshot,
    energy_kcal_low,
    energy_kcal_high,
    energy_model_version,
    stool_count,
    urine_count
  ) values (
    session_owner_id,
    walk_pet_id,
    caller_id,
    walk_client_request_key,
    walk_started_at,
    walk_ended_at,
    walk_duration_seconds,
    walk_distance_m,
    walk_weight_kg_snapshot,
    walk_energy_kcal_low,
    walk_energy_kcal_high,
    walk_energy_model_version,
    coalesce(cardinality(walk_stool_times), 0),
    coalesce(cardinality(walk_urine_times), 0)
  ) returning * into created_walk;

  insert into public.care_records (
    owner_id, pet_id, kind, occurred_at, source, title, note,
    stool_texture, stool_color, stool_status, walk_session_id, metadata
  )
  select
    session_owner_id,
    walk_pet_id,
    'stool'::public.care_record_kind,
    item.event_time,
    'walk_tracking'::public.record_source,
    '排便',
    '遛狗途中快速記錄',
    null,
    null,
    null,
    created_walk.id,
    jsonb_build_object('structured_form_version', 1, 'walk_tracking', true)
  from unnest(coalesce(walk_stool_times, '{}'::timestamptz[])) as item(event_time);

  insert into public.care_records (
    owner_id, pet_id, kind, occurred_at, source, title, note,
    urine_color, walk_session_id, metadata
  )
  select
    session_owner_id,
    walk_pet_id,
    'urine'::public.care_record_kind,
    item.event_time,
    'walk_tracking'::public.record_source,
    '尿尿',
    '遛狗途中快速記錄',
    'unknown',
    created_walk.id,
    jsonb_build_object('structured_form_version', 1, 'walk_tracking', true)
  from unnest(coalesce(walk_urine_times, '{}'::timestamptz[])) as item(event_time);

  delete from private.active_walk_leases
  where pet_id = walk_pet_id
    and holder_id = caller_id
    and client_request_key = walk_client_request_key
    and lease_token = walk_lease_token;

  return created_walk;
end;
$$;

revoke all on function public.begin_walk_session(text, text) from public, anon, authenticated;
revoke all on function public.heartbeat_walk_session(text, text, uuid) from public, anon, authenticated;
revoke all on function public.abandon_walk_session(text, text, uuid) from public, anon, authenticated;
revoke all on function public.complete_walk_session(
  text, text, uuid, timestamptz, timestamptz, integer, numeric,
  numeric, numeric, numeric, text, timestamptz[], timestamptz[]
) from public, anon, authenticated;

grant execute on function public.begin_walk_session(text, text) to authenticated;
grant execute on function public.heartbeat_walk_session(text, text, uuid) to authenticated;
grant execute on function public.abandon_walk_session(text, text, uuid) to authenticated;
grant execute on function public.complete_walk_session(
  text, text, uuid, timestamptz, timestamptz, integer, numeric,
  numeric, numeric, numeric, text, timestamptz[], timestamptz[]
) to authenticated;

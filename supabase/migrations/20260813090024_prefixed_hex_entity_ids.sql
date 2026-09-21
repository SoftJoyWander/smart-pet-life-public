-- Replace business UUIDs with stable, human-readable entity IDs.
--
-- Format: <TYPE>-<8 uppercase hexadecimal characters>, for example
-- PET-02BD14E8. A single non-cycling sequence is passed through an odd
-- multiplicative permutation modulo 2^32. This produces non-sequential-looking
-- values without collisions until the 32-bit namespace is exhausted.
-- Supabase Auth keeps its UUID in profiles.auth_user_id.

create sequence private.entity_id_sequence
  as bigint
  minvalue 1
  maxvalue 4294967295
  start with 1
  no cycle;

revoke all on sequence private.entity_id_sequence from public, anon, authenticated;

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
  if entity_prefix not in ('USR', 'PET', 'REC', 'MPL', 'RMN', 'MBR', 'INV', 'PVC') then
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
grant execute on function private.generate_entity_id(text) to authenticated;
grant execute on function private.generate_entity_id(text) to service_role;

-- Policies and typed functions must be rebuilt after the key columns change.
drop policy if exists "Owners can read their profile" on public.profiles;
drop policy if exists "Owners can update their profile" on public.profiles;
drop policy if exists "Owners can create their pets" on public.pets;
drop policy if exists "Authorized users can read pets" on public.pets;
drop policy if exists "Authorized editors can update pets" on public.pets;
drop policy if exists "Authorized editors can create care records" on public.care_records;
drop policy if exists "Authorized users can read care records" on public.care_records;
drop policy if exists "Authorized editors can update care records" on public.care_records;
drop policy if exists "Authorized editors can delete care records" on public.care_records;
drop policy if exists "Authorized editors can create medication plans" on public.medication_plans;
drop policy if exists "Authorized users can read medication plans" on public.medication_plans;
drop policy if exists "Authorized editors can update medication plans" on public.medication_plans;
drop policy if exists "Authorized editors can create medication reminders" on public.medication_reminders;
drop policy if exists "Authorized users can read medication reminders" on public.medication_reminders;
drop policy if exists "Authorized editors can update medication reminders" on public.medication_reminders;
drop policy if exists "Authorized users can read memberships" on public.pet_memberships;
drop policy if exists "Owners can update memberships" on public.pet_memberships;
drop policy if exists "Owners can remove memberships" on public.pet_memberships;
drop policy if exists "Invitees can create their invited membership" on public.pet_memberships;
drop policy if exists "Authorized users can read invitations" on public.pet_invitations;
drop policy if exists "Owners can create invitations" on public.pet_invitations;
drop policy if exists "Owners can update invitations" on public.pet_invitations;
drop policy if exists "Owners can delete invitations" on public.pet_invitations;
drop policy if exists "Invitees can accept their invitation" on public.pet_invitations;
drop policy if exists "Authorized users can read preventive care schedules" on public.preventive_care_schedules;
drop policy if exists "Authorized editors can create preventive care schedules" on public.preventive_care_schedules;
drop policy if exists "Authorized editors can update preventive care schedules" on public.preventive_care_schedules;

drop policy if exists "Authorized users can read pet media" on storage.objects;
drop policy if exists "Authorized editors can upload pet media" on storage.objects;
drop policy if exists "Authorized editors can update pet media" on storage.objects;
drop policy if exists "Authorized editors can delete pet media" on storage.objects;

drop trigger if exists on_auth_user_created on auth.users;
drop trigger if exists pet_invitations_validate_recipient on public.pet_invitations;

drop function if exists public.handle_new_user();
drop function if exists private.can_access_pet(uuid);
drop function if exists private.can_edit_pet(uuid);
drop function if exists private.can_access_pet_media(text);
drop function if exists private.can_edit_pet_media(text);
drop function if exists private.validate_pet_invitation_recipient();
drop function if exists public.accept_pet_invitation(uuid);
drop function if exists public.accept_pet_invitation_code(text);
drop function if exists public.complete_preventive_care(uuid);
drop function if exists public.sync_medication_plan_reminders(uuid);
drop function if exists public.refresh_medication_reminders(uuid);
drop function if exists public.complete_medication_reminder(uuid, timestamptz);
drop function if exists public.resolve_missed_medication_reminder(uuid, boolean, timestamptz);
drop function if exists public.create_medication_plan_with_reminders(
  uuid, uuid, text, text, numeric, text, time[], date, date, text, text, text, text
);

-- Create replacement values while all UUID relationships are still available.
alter table public.profiles
  add column auth_user_id uuid,
  add column new_id text;
update public.profiles
set auth_user_id = id,
    new_id = private.generate_entity_id('USR');

alter table public.pets
  add column new_id text,
  add column new_owner_id text;
update public.pets pet
set new_id = private.generate_entity_id('PET'),
    new_owner_id = profile.new_id
from public.profiles profile
where pet.owner_id = profile.auth_user_id;

alter table public.medication_plans
  add column new_id text,
  add column new_owner_id text,
  add column new_pet_id text;
update public.medication_plans plan
set new_id = private.generate_entity_id('MPL'),
    new_owner_id = profile.new_id,
    new_pet_id = pet.new_id
from public.profiles profile, public.pets pet
where plan.owner_id = profile.auth_user_id
  and plan.pet_id = pet.id;

alter table public.care_records
  add column new_id text,
  add column new_owner_id text,
  add column new_pet_id text;
update public.care_records record
set new_id = private.generate_entity_id('REC'),
    new_owner_id = profile.new_id,
    new_pet_id = pet.new_id
from public.profiles profile, public.pets pet
where record.owner_id = profile.auth_user_id
  and record.pet_id = pet.id;

alter table public.medication_reminders
  add column new_id text,
  add column new_owner_id text,
  add column new_pet_id text,
  add column new_medication_plan_id text,
  add column new_resolved_by text,
  add column new_care_record_id text;
update public.medication_reminders reminder
set new_id = private.generate_entity_id('RMN'),
    new_owner_id = profile.new_id,
    new_pet_id = pet.new_id,
    new_medication_plan_id = plan.new_id
from public.profiles profile
join public.pets pet on pet.owner_id = profile.auth_user_id
join public.medication_plans plan on plan.pet_id = pet.id
where reminder.owner_id = profile.auth_user_id
  and reminder.pet_id = pet.id
  and reminder.medication_plan_id = plan.id;

update public.medication_reminders reminder
set new_resolved_by = resolver.new_id
from public.profiles resolver
where reminder.resolved_by = resolver.auth_user_id;

update public.medication_reminders reminder
set new_care_record_id = record.new_id
from public.care_records record
where reminder.care_record_id = record.id;

alter table public.pet_memberships
  add column new_id text,
  add column new_pet_id text,
  add column new_owner_id text,
  add column new_user_id text,
  add column new_invited_by text;
update public.pet_memberships membership
set new_id = private.generate_entity_id('MBR'),
    new_pet_id = pet.new_id,
    new_owner_id = owner_profile.new_id,
    new_user_id = member_profile.new_id,
    new_invited_by = inviter_profile.new_id
from public.pets pet, public.profiles owner_profile, public.profiles member_profile, public.profiles inviter_profile
where membership.pet_id = pet.id
  and membership.owner_id = owner_profile.auth_user_id
  and membership.user_id = member_profile.auth_user_id
  and membership.invited_by = inviter_profile.auth_user_id;

alter table public.pet_invitations
  add column new_id text,
  add column new_pet_id text,
  add column new_owner_id text,
  add column new_invited_by text,
  add column new_accepted_by text;
update public.pet_invitations invitation
set new_id = private.generate_entity_id('INV'),
    new_pet_id = pet.new_id,
    new_owner_id = owner_profile.new_id,
    new_invited_by = inviter_profile.new_id
from public.pets pet, public.profiles owner_profile, public.profiles inviter_profile
where invitation.pet_id = pet.id
  and invitation.owner_id = owner_profile.auth_user_id
  and invitation.invited_by = inviter_profile.auth_user_id;

update public.pet_invitations invitation
set new_accepted_by = accepter_profile.new_id
from public.profiles accepter_profile
where invitation.accepted_by = accepter_profile.auth_user_id;

alter table public.preventive_care_schedules
  add column new_id text,
  add column new_owner_id text,
  add column new_pet_id text;
update public.preventive_care_schedules schedule
set new_id = private.generate_entity_id('PVC'),
    new_owner_id = profile.new_id,
    new_pet_id = pet.new_id
from public.profiles profile, public.pets pet
where schedule.owner_id = profile.auth_user_id
  and schedule.pet_id = pet.id;

-- Keep a private compatibility map for objects whose Storage names contain the
-- former pet UUID. New uploads use the new PET ID and do not add to this table.
create table private.legacy_pet_media_ids (
  legacy_pet_id uuid primary key,
  pet_id text not null unique
);
revoke all on private.legacy_pet_media_ids from public, anon, authenticated;
insert into private.legacy_pet_media_ids (legacy_pet_id, pet_id)
select id, new_id from public.pets;

-- Rewrite entity references stored inside operational JSON metadata.
update public.care_records record
set metadata = jsonb_set(record.metadata, '{medication_plan_id}', to_jsonb(plan.new_id), false)
from public.medication_plans plan
where record.metadata ->> 'medication_plan_id' = plan.id::text;

update public.care_records record
set metadata = jsonb_set(record.metadata, '{medication_reminder_id}', to_jsonb(reminder.new_id), false)
from public.medication_reminders reminder
where record.metadata ->> 'medication_reminder_id' = reminder.id::text;

update public.care_records record
set metadata = jsonb_set(record.metadata, '{preventive_care_schedule_id}', to_jsonb(schedule.new_id), false)
from public.preventive_care_schedules schedule
where record.metadata ->> 'preventive_care_schedule_id' = schedule.id::text;

update public.care_records record
set metadata = jsonb_set(record.metadata, '{resolved_by}', to_jsonb(profile.new_id), false)
from public.profiles profile
where record.metadata ->> 'resolved_by' = profile.auth_user_id::text;

do $$
begin
  if exists (select 1 from public.profiles where auth_user_id is null or new_id is null)
    or exists (select 1 from public.pets where new_id is null or new_owner_id is null)
    or exists (select 1 from public.medication_plans where new_id is null or new_owner_id is null or new_pet_id is null)
    or exists (select 1 from public.care_records where new_id is null or new_owner_id is null or new_pet_id is null)
    or exists (
      select 1 from public.medication_reminders
      where new_id is null or new_owner_id is null or new_pet_id is null or new_medication_plan_id is null
        or (resolved_by is not null and new_resolved_by is null)
        or (care_record_id is not null and new_care_record_id is null)
    )
    or exists (
      select 1 from public.pet_memberships
      where new_id is null or new_pet_id is null or new_owner_id is null or new_user_id is null or new_invited_by is null
    )
    or exists (
      select 1 from public.pet_invitations
      where new_id is null or new_pet_id is null or new_owner_id is null or new_invited_by is null
        or (accepted_by is not null and new_accepted_by is null)
    )
    or exists (
      select 1 from public.preventive_care_schedules
      where new_id is null or new_owner_id is null or new_pet_id is null
    ) then
    raise exception 'Entity ID migration aborted because one or more relationships could not be mapped';
  end if;
end;
$$;

-- Remove UUID constraints before replacing their columns.
alter table public.medication_reminders
  drop constraint if exists medication_reminders_plan_owner_fk,
  drop constraint if exists medication_reminders_care_record_id_fkey,
  drop constraint if exists medication_reminders_resolved_by_fkey,
  drop constraint if exists medication_reminders_medication_plan_id_scheduled_at_key,
  drop constraint if exists medication_reminders_pkey;
alter table public.preventive_care_schedules
  drop constraint if exists preventive_care_schedules_pet_owner_fk,
  drop constraint if exists preventive_care_schedules_pet_id_kind_key,
  drop constraint if exists preventive_care_schedules_pkey;
alter table public.pet_invitations
  drop constraint if exists pet_invitations_pet_owner_fk,
  drop constraint if exists pet_invitations_invited_by_fkey,
  drop constraint if exists pet_invitations_accepted_by_fkey,
  drop constraint if exists pet_invitations_pkey;
alter table public.pet_memberships
  drop constraint if exists pet_memberships_pet_owner_fk,
  drop constraint if exists pet_memberships_user_id_fkey,
  drop constraint if exists pet_memberships_invited_by_fkey,
  drop constraint if exists pet_memberships_pet_id_user_id_key,
  drop constraint if exists pet_memberships_not_owner,
  drop constraint if exists pet_memberships_pkey;
alter table public.care_records
  drop constraint if exists care_records_pet_owner_fk,
  drop constraint if exists care_records_pkey;
alter table public.medication_plans
  drop constraint if exists medication_plans_pet_owner_fk,
  drop constraint if exists medication_plans_id_pet_id_owner_id_key,
  drop constraint if exists medication_plans_owner_request_key_unique,
  drop constraint if exists medication_plans_pkey;
alter table public.pets
  drop constraint if exists pets_owner_id_fkey,
  drop constraint if exists pets_id_owner_id_key,
  drop constraint if exists pets_pkey;
alter table public.profiles
  drop constraint if exists profiles_id_fkey,
  drop constraint if exists profiles_pkey;

alter table public.medication_reminders
  drop column id,
  drop column owner_id,
  drop column pet_id,
  drop column medication_plan_id,
  drop column resolved_by,
  drop column care_record_id;
alter table public.medication_reminders rename column new_id to id;
alter table public.medication_reminders rename column new_owner_id to owner_id;
alter table public.medication_reminders rename column new_pet_id to pet_id;
alter table public.medication_reminders rename column new_medication_plan_id to medication_plan_id;
alter table public.medication_reminders rename column new_resolved_by to resolved_by;
alter table public.medication_reminders rename column new_care_record_id to care_record_id;

alter table public.preventive_care_schedules drop column id, drop column owner_id, drop column pet_id;
alter table public.preventive_care_schedules rename column new_id to id;
alter table public.preventive_care_schedules rename column new_owner_id to owner_id;
alter table public.preventive_care_schedules rename column new_pet_id to pet_id;

alter table public.pet_invitations
  drop column id,
  drop column pet_id,
  drop column owner_id,
  drop column invited_by,
  drop column accepted_by;
alter table public.pet_invitations rename column new_id to id;
alter table public.pet_invitations rename column new_pet_id to pet_id;
alter table public.pet_invitations rename column new_owner_id to owner_id;
alter table public.pet_invitations rename column new_invited_by to invited_by;
alter table public.pet_invitations rename column new_accepted_by to accepted_by;

alter table public.pet_memberships
  drop column id,
  drop column pet_id,
  drop column owner_id,
  drop column user_id,
  drop column invited_by;
alter table public.pet_memberships rename column new_id to id;
alter table public.pet_memberships rename column new_pet_id to pet_id;
alter table public.pet_memberships rename column new_owner_id to owner_id;
alter table public.pet_memberships rename column new_user_id to user_id;
alter table public.pet_memberships rename column new_invited_by to invited_by;

alter table public.care_records drop column id, drop column owner_id, drop column pet_id;
alter table public.care_records rename column new_id to id;
alter table public.care_records rename column new_owner_id to owner_id;
alter table public.care_records rename column new_pet_id to pet_id;

alter table public.medication_plans drop column id, drop column owner_id, drop column pet_id;
alter table public.medication_plans rename column new_id to id;
alter table public.medication_plans rename column new_owner_id to owner_id;
alter table public.medication_plans rename column new_pet_id to pet_id;

alter table public.pets drop column id, drop column owner_id;
alter table public.pets rename column new_id to id;
alter table public.pets rename column new_owner_id to owner_id;

alter table public.profiles drop column id;
alter table public.profiles rename column new_id to id;

-- Defaults, format constraints, keys, and relationships for the new IDs.
alter table public.profiles
  alter column id set not null,
  alter column id set default private.generate_entity_id('USR'),
  alter column auth_user_id set not null,
  add constraint profiles_id_format check (id ~ '^USR-[0-9A-F]{8}$'),
  add constraint profiles_pkey primary key (id),
  add constraint profiles_auth_user_id_key unique (auth_user_id),
  add constraint profiles_auth_user_id_fkey foreign key (auth_user_id) references auth.users(id) on delete cascade;

alter table public.pets
  alter column id set not null,
  alter column id set default private.generate_entity_id('PET'),
  alter column owner_id set not null,
  add constraint pets_id_format check (id ~ '^PET-[0-9A-F]{8}$'),
  add constraint pets_pkey primary key (id),
  add constraint pets_owner_id_fkey foreign key (owner_id) references public.profiles(id) on delete cascade,
  add constraint pets_id_owner_id_key unique (id, owner_id);

alter table public.medication_plans
  alter column id set not null,
  alter column id set default private.generate_entity_id('MPL'),
  alter column owner_id set not null,
  alter column pet_id set not null,
  add constraint medication_plans_id_format check (id ~ '^MPL-[0-9A-F]{8}$'),
  add constraint medication_plans_pkey primary key (id),
  add constraint medication_plans_pet_owner_fk foreign key (pet_id, owner_id) references public.pets(id, owner_id),
  add constraint medication_plans_id_pet_id_owner_id_key unique (id, pet_id, owner_id),
  add constraint medication_plans_owner_request_key_unique unique (owner_id, client_request_key);

alter table public.care_records
  alter column id set not null,
  alter column id set default private.generate_entity_id('REC'),
  alter column owner_id set not null,
  alter column pet_id set not null,
  add constraint care_records_id_format check (id ~ '^REC-[0-9A-F]{8}$'),
  add constraint care_records_pkey primary key (id),
  add constraint care_records_pet_owner_fk foreign key (pet_id, owner_id) references public.pets(id, owner_id);

alter table public.medication_reminders
  alter column id set not null,
  alter column id set default private.generate_entity_id('RMN'),
  alter column owner_id set not null,
  alter column pet_id set not null,
  alter column medication_plan_id set not null,
  add constraint medication_reminders_id_format check (id ~ '^RMN-[0-9A-F]{8}$'),
  add constraint medication_reminders_pkey primary key (id),
  add constraint medication_reminders_plan_owner_fk foreign key (medication_plan_id, pet_id, owner_id)
    references public.medication_plans(id, pet_id, owner_id),
  add constraint medication_reminders_care_record_id_fkey foreign key (care_record_id) references public.care_records(id),
  add constraint medication_reminders_resolved_by_fkey foreign key (resolved_by) references public.profiles(id),
  add constraint medication_reminders_medication_plan_id_scheduled_at_key unique (medication_plan_id, scheduled_at);

alter table public.pet_memberships
  alter column id set not null,
  alter column id set default private.generate_entity_id('MBR'),
  alter column pet_id set not null,
  alter column owner_id set not null,
  alter column user_id set not null,
  alter column invited_by set not null,
  add constraint pet_memberships_id_format check (id ~ '^MBR-[0-9A-F]{8}$'),
  add constraint pet_memberships_pkey primary key (id),
  add constraint pet_memberships_pet_owner_fk foreign key (pet_id, owner_id) references public.pets(id, owner_id) on delete cascade,
  add constraint pet_memberships_user_id_fkey foreign key (user_id) references public.profiles(id) on delete cascade,
  add constraint pet_memberships_invited_by_fkey foreign key (invited_by) references public.profiles(id),
  add constraint pet_memberships_not_owner check (user_id <> owner_id),
  add constraint pet_memberships_pet_id_user_id_key unique (pet_id, user_id);

alter table public.pet_invitations
  alter column id set not null,
  alter column id set default private.generate_entity_id('INV'),
  alter column pet_id set not null,
  alter column owner_id set not null,
  alter column invited_by set not null,
  add constraint pet_invitations_id_format check (id ~ '^INV-[0-9A-F]{8}$'),
  add constraint pet_invitations_pkey primary key (id),
  add constraint pet_invitations_pet_owner_fk foreign key (pet_id, owner_id) references public.pets(id, owner_id) on delete cascade,
  add constraint pet_invitations_invited_by_fkey foreign key (invited_by) references public.profiles(id),
  add constraint pet_invitations_accepted_by_fkey foreign key (accepted_by) references public.profiles(id);

alter table public.preventive_care_schedules
  alter column id set not null,
  alter column id set default private.generate_entity_id('PVC'),
  alter column owner_id set not null,
  alter column pet_id set not null,
  add constraint preventive_care_schedules_id_format check (id ~ '^PVC-[0-9A-F]{8}$'),
  add constraint preventive_care_schedules_pkey primary key (id),
  add constraint preventive_care_schedules_pet_owner_fk foreign key (pet_id, owner_id) references public.pets(id, owner_id) on delete cascade,
  add constraint preventive_care_schedules_pet_id_kind_key unique (pet_id, kind);

alter table private.legacy_pet_media_ids
  add constraint legacy_pet_media_ids_pet_id_fkey foreign key (pet_id) references public.pets(id) on delete cascade;

create or replace function private.protect_entity_id()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id then
    raise exception 'Entity IDs cannot be changed';
  end if;
  return new;
end;
$$;

revoke all on function private.protect_entity_id() from public, anon, authenticated;

create trigger profiles_protect_id before update on public.profiles
for each row execute function private.protect_entity_id();
create trigger pets_protect_id before update on public.pets
for each row execute function private.protect_entity_id();
create trigger care_records_protect_id before update on public.care_records
for each row execute function private.protect_entity_id();
create trigger medication_plans_protect_id before update on public.medication_plans
for each row execute function private.protect_entity_id();
create trigger medication_reminders_protect_id before update on public.medication_reminders
for each row execute function private.protect_entity_id();
create trigger pet_memberships_protect_id before update on public.pet_memberships
for each row execute function private.protect_entity_id();
create trigger pet_invitations_protect_id before update on public.pet_invitations
for each row execute function private.protect_entity_id();
create trigger preventive_care_schedules_protect_id before update on public.preventive_care_schedules
for each row execute function private.protect_entity_id();

-- Rebuild indexes dropped with the UUID columns.
create index pets_owner_id_idx on public.pets(owner_id);
create index care_records_pet_occurred_at_idx on public.care_records(pet_id, occurred_at desc);
create index care_records_owner_occurred_at_idx on public.care_records(owner_id, occurred_at desc);
create index care_records_pet_owner_fk_idx on public.care_records(pet_id, owner_id);
create index medication_plans_pet_active_idx on public.medication_plans(pet_id, is_active);
create index medication_plans_pet_owner_fk_idx on public.medication_plans(pet_id, owner_id);
create index medication_reminders_pet_scheduled_at_idx on public.medication_reminders(pet_id, scheduled_at);
create index medication_reminders_plan_owner_fk_idx on public.medication_reminders(medication_plan_id, pet_id, owner_id);
create index medication_reminders_care_record_idx on public.medication_reminders(care_record_id) where care_record_id is not null;
create index medication_reminders_actionable_idx on public.medication_reminders(pet_id, scheduled_at) where status in ('pending', 'overdue');
create index medication_reminders_plan_status_idx on public.medication_reminders(medication_plan_id, status, scheduled_at);
create index medication_reminders_resolved_by_idx on public.medication_reminders(resolved_by) where resolved_by is not null;
create index pet_memberships_user_pet_idx on public.pet_memberships(user_id, pet_id);
create index pet_memberships_pet_user_idx on public.pet_memberships(pet_id, user_id);
create index pet_memberships_pet_owner_fk_idx on public.pet_memberships(pet_id, owner_id);
create index pet_memberships_invited_by_idx on public.pet_memberships(invited_by);
create unique index pet_memberships_pet_member_email_idx on public.pet_memberships(pet_id, member_email) where member_email is not null;
create unique index pet_invitations_one_pending_email_idx on public.pet_invitations(pet_id, invited_email) where status = 'pending';
create index pet_invitations_pet_status_idx on public.pet_invitations(pet_id, status);
create index pet_invitations_pet_owner_fk_idx on public.pet_invitations(pet_id, owner_id);
create index pet_invitations_invited_by_idx on public.pet_invitations(invited_by);
create index pet_invitations_accepted_by_idx on public.pet_invitations(accepted_by) where accepted_by is not null;
create index preventive_care_schedules_pet_owner_idx on public.preventive_care_schedules(pet_id, owner_id);

create or replace function private.current_profile_id()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select profile.id
  from public.profiles profile
  where profile.auth_user_id = (select auth.uid())
$$;

revoke all on function private.current_profile_id() from public, anon;
grant execute on function private.current_profile_id() to authenticated;

create or replace function private.can_access_pet(target_pet_id text)
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
          select 1 from public.pet_memberships membership
          where membership.pet_id = pet.id
            and membership.user_id = (select private.current_profile_id())
        )
      )
  )
$$;

create or replace function private.can_edit_pet(target_pet_id text)
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
          select 1 from public.pet_memberships membership
          where membership.pet_id = pet.id
            and membership.user_id = (select private.current_profile_id())
            and membership.role = 'editor'
        )
      )
  )
$$;

revoke all on function private.can_access_pet(text) from public, anon;
revoke all on function private.can_edit_pet(text) from public, anon;
grant execute on function private.can_access_pet(text) to authenticated;
grant execute on function private.can_edit_pet(text) to authenticated;

create or replace function private.can_access_pet_media(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.pets pet
    where (
      pet.id = split_part(object_name, '/', 2)
      or exists (
        select 1 from private.legacy_pet_media_ids legacy
        where legacy.legacy_pet_id::text = split_part(object_name, '/', 2)
          and legacy.pet_id = pet.id
      )
    )
      and (
        pet.owner_id = (select private.current_profile_id())
        or exists (
          select 1 from public.pet_memberships membership
          where membership.pet_id = pet.id
            and membership.user_id = (select private.current_profile_id())
        )
      )
  )
$$;

create or replace function private.can_edit_pet_media(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.pets pet
    where (
      pet.id = split_part(object_name, '/', 2)
      or exists (
        select 1 from private.legacy_pet_media_ids legacy
        where legacy.legacy_pet_id::text = split_part(object_name, '/', 2)
          and legacy.pet_id = pet.id
      )
    )
      and (
        pet.owner_id = (select private.current_profile_id())
        or exists (
          select 1 from public.pet_memberships membership
          where membership.pet_id = pet.id
            and membership.user_id = (select private.current_profile_id())
            and membership.role = 'editor'
        )
      )
  )
$$;

revoke all on function private.can_access_pet_media(text) from public, anon;
revoke all on function private.can_edit_pet_media(text) from public, anon;
grant execute on function private.can_access_pet_media(text) to authenticated;
grant execute on function private.can_edit_pet_media(text) to authenticated;

-- RLS now maps the JWT's Auth UUID to the internal USR ID.
create policy "Owners can read their profile" on public.profiles for select to authenticated
using (auth_user_id = (select auth.uid()));
create policy "Owners can update their profile" on public.profiles for update to authenticated
using (auth_user_id = (select auth.uid())) with check (auth_user_id = (select auth.uid()));

create policy "Owners can create their pets" on public.pets for insert to authenticated
with check (owner_id = (select private.current_profile_id()));
create policy "Authorized users can read pets" on public.pets for select to authenticated
using ((select private.can_access_pet(id)));
create policy "Authorized editors can update pets" on public.pets for update to authenticated
using ((select private.can_edit_pet(id))) with check ((select private.can_edit_pet(id)));

create policy "Authorized editors can create care records" on public.care_records for insert to authenticated
with check ((select private.can_edit_pet(pet_id)));
create policy "Authorized users can read care records" on public.care_records for select to authenticated
using ((select private.can_access_pet(pet_id)));
create policy "Authorized editors can update care records" on public.care_records for update to authenticated
using ((select private.can_edit_pet(pet_id))) with check ((select private.can_edit_pet(pet_id)));
create policy "Authorized editors can delete care records" on public.care_records for delete to authenticated
using ((select private.can_edit_pet(pet_id)));

create policy "Authorized editors can create medication plans" on public.medication_plans for insert to authenticated
with check ((select private.can_edit_pet(pet_id)));
create policy "Authorized users can read medication plans" on public.medication_plans for select to authenticated
using ((select private.can_access_pet(pet_id)));
create policy "Authorized editors can update medication plans" on public.medication_plans for update to authenticated
using ((select private.can_edit_pet(pet_id))) with check ((select private.can_edit_pet(pet_id)));

create policy "Authorized editors can create medication reminders" on public.medication_reminders for insert to authenticated
with check ((select private.can_edit_pet(pet_id)));
create policy "Authorized users can read medication reminders" on public.medication_reminders for select to authenticated
using ((select private.can_access_pet(pet_id)));
create policy "Authorized editors can update medication reminders" on public.medication_reminders for update to authenticated
using ((select private.can_edit_pet(pet_id))) with check ((select private.can_edit_pet(pet_id)));

create policy "Authorized users can read memberships" on public.pet_memberships for select to authenticated
using (owner_id = (select private.current_profile_id()) or user_id = (select private.current_profile_id()));
create policy "Owners can update memberships" on public.pet_memberships for update to authenticated
using (owner_id = (select private.current_profile_id())) with check (owner_id = (select private.current_profile_id()));
create policy "Owners can remove memberships" on public.pet_memberships for delete to authenticated
using (owner_id = (select private.current_profile_id()));

create policy "Authorized users can read invitations" on public.pet_invitations for select to authenticated
using (
  owner_id = (select private.current_profile_id())
  or (
    status = 'pending'
    and expires_at > now()
    and invited_email = lower(coalesce((select auth.jwt()) ->> 'email', ''))
  )
);
create policy "Owners can create invitations" on public.pet_invitations for insert to authenticated
with check (
  owner_id = (select private.current_profile_id())
  and invited_by = (select private.current_profile_id())
);
create policy "Owners can update invitations" on public.pet_invitations for update to authenticated
using (owner_id = (select private.current_profile_id()))
with check (owner_id = (select private.current_profile_id()));
create policy "Owners can delete invitations" on public.pet_invitations for delete to authenticated
using (owner_id = (select private.current_profile_id()));

create policy "Authorized users can read preventive care schedules" on public.preventive_care_schedules for select to authenticated
using ((select private.can_access_pet(pet_id)));
create policy "Authorized editors can create preventive care schedules" on public.preventive_care_schedules for insert to authenticated
with check ((select private.can_edit_pet(pet_id)));
create policy "Authorized editors can update preventive care schedules" on public.preventive_care_schedules for update to authenticated
using ((select private.can_edit_pet(pet_id))) with check ((select private.can_edit_pet(pet_id)));

create policy "Authorized users can read pet media" on storage.objects for select to authenticated
using (bucket_id = 'pet-media' and (select private.can_access_pet_media(name)));
create policy "Authorized editors can upload pet media" on storage.objects for insert to authenticated
with check (bucket_id = 'pet-media' and (select private.can_edit_pet_media(name)));
create policy "Authorized editors can update pet media" on storage.objects for update to authenticated
using (bucket_id = 'pet-media' and (select private.can_edit_pet_media(name)))
with check (bucket_id = 'pet-media' and (select private.can_edit_pet_media(name)));
create policy "Authorized editors can delete pet media" on storage.objects for delete to authenticated
using (bucket_id = 'pet-media' and (select private.can_edit_pet_media(name)));

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (auth_user_id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''));
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function private.validate_pet_invitation_recipient()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id text := (select private.current_profile_id());
  target_user_id text;
begin
  if caller_id is null then
    raise exception 'Authentication is required to create an invitation';
  end if;
  if caller_id <> new.owner_id or caller_id <> new.invited_by then
    raise exception 'Only the pet owner can create an invitation';
  end if;
  if not exists (
    select 1 from public.pets pet
    where pet.id = new.pet_id and pet.owner_id = caller_id and pet.archived_at is null
  ) then
    raise exception 'Pet is not available for invitation';
  end if;

  new.invited_email := lower(trim(new.invited_email));
  select profile.id into target_user_id
  from auth.users auth_user
  join public.profiles profile on profile.auth_user_id = auth_user.id
  where lower(auth_user.email) = new.invited_email and auth_user.deleted_at is null
  order by auth_user.created_at asc
  limit 1;

  if target_user_id is null then raise exception 'No registered account exists for this email'; end if;
  if target_user_id = new.owner_id then raise exception 'Pet owners cannot invite themselves'; end if;
  if exists (
    select 1 from public.pet_memberships membership
    where membership.pet_id = new.pet_id and membership.owner_id = new.owner_id and membership.user_id = target_user_id
  ) then
    raise exception 'This email is already a caregiver for this pet';
  end if;
  if exists (
    select 1 from public.pet_invitations invitation
    where invitation.pet_id = new.pet_id
      and invitation.owner_id = new.owner_id
      and invitation.invited_email = new.invited_email
      and invitation.status = 'pending'
      and invitation.expires_at > now()
  ) then
    raise exception 'A pending invitation already exists for this email';
  end if;
  return new;
end;
$$;

revoke all on function private.validate_pet_invitation_recipient() from public, anon, authenticated;
create trigger pet_invitations_validate_recipient before insert on public.pet_invitations
for each row execute function private.validate_pet_invitation_recipient();

create policy "Invitees can create their invited membership" on public.pet_memberships for insert to authenticated
with check (
  user_id = (select private.current_profile_id())
  and exists (
    select 1 from public.pet_invitations invitation
    where invitation.pet_id = pet_memberships.pet_id
      and invitation.owner_id = pet_memberships.owner_id
      and invitation.invited_by = pet_memberships.invited_by
      and invitation.role = pet_memberships.role
      and invitation.status = 'pending'
      and invitation.expires_at > now()
      and invitation.invited_email = lower(coalesce((select auth.jwt()) ->> 'email', ''))
  )
);

create policy "Invitees can accept their invitation" on public.pet_invitations for update to authenticated
using (
  status = 'pending'
  and expires_at > now()
  and invited_email = lower(coalesce((select auth.jwt()) ->> 'email', ''))
)
with check (
  status = 'accepted'
  and accepted_by = (select private.current_profile_id())
  and accepted_at is not null
  and invited_email = lower(coalesce((select auth.jwt()) ->> 'email', ''))
);

grant update (status, accepted_by, accepted_at) on public.pet_invitations to authenticated;

create or replace function public.accept_pet_invitation(invitation_id text)
returns public.pet_memberships
language plpgsql
security invoker
set search_path = ''
as $$
declare
  invitation public.pet_invitations;
  membership public.pet_memberships;
  caller_id text := (select private.current_profile_id());
  caller_email text := lower(coalesce((select auth.jwt() ->> 'email'), ''));
begin
  if caller_id is null or caller_email = '' then raise exception 'Authentication with a verified email is required'; end if;
  select * into invitation from public.pet_invitations where id = invitation_id for update;
  if invitation.id is null or invitation.status <> 'pending' then raise exception 'Invitation is no longer available'; end if;
  if invitation.expires_at <= now() then raise exception 'Invitation has expired'; end if;
  if invitation.invited_email <> caller_email then raise exception 'Invitation belongs to another email address'; end if;
  if invitation.owner_id = caller_id then raise exception 'Pet owners cannot accept their own invitation'; end if;

  insert into public.pet_memberships (pet_id, owner_id, user_id, role, invited_by, member_email)
  values (invitation.pet_id, invitation.owner_id, caller_id, invitation.role, invitation.invited_by, caller_email)
  on conflict (pet_id, user_id) do nothing
  returning * into membership;
  if membership.id is null then
    select * into membership from public.pet_memberships
    where pet_id = invitation.pet_id and user_id = caller_id;
  end if;
  update public.pet_invitations
  set status = 'accepted', accepted_by = caller_id, accepted_at = now()
  where id = invitation.id;
  return membership;
end;
$$;

create or replace function public.accept_pet_invitation_code(join_code text)
returns public.pet_memberships
language plpgsql
security invoker
set search_path = ''
as $$
declare
  invitation public.pet_invitations;
  membership public.pet_memberships;
  caller_id text := (select private.current_profile_id());
  caller_email text := lower(coalesce((select auth.jwt() ->> 'email'), ''));
  normalized_code text := upper(regexp_replace(coalesce(join_code, ''), '[^a-zA-Z0-9]', '', 'g'));
begin
  if caller_id is null or caller_email = '' then raise exception 'Authentication with a verified email is required'; end if;
  select * into invitation from public.pet_invitations where invite_code = normalized_code for update;
  if invitation.id is null or invitation.status <> 'pending' then raise exception 'Invitation code is invalid or no longer available'; end if;
  if invitation.expires_at <= now() then raise exception 'Invitation has expired'; end if;
  if invitation.invited_email <> caller_email then raise exception 'Invitation belongs to another email address'; end if;
  if invitation.owner_id = caller_id then raise exception 'Pet owners cannot accept their own invitation'; end if;

  insert into public.pet_memberships (pet_id, owner_id, user_id, role, invited_by, member_email)
  values (invitation.pet_id, invitation.owner_id, caller_id, invitation.role, invitation.invited_by, caller_email)
  on conflict (pet_id, user_id) do nothing
  returning * into membership;
  if membership.id is null then
    select * into membership from public.pet_memberships
    where pet_id = invitation.pet_id and user_id = caller_id;
  end if;
  update public.pet_invitations
  set status = 'accepted', accepted_by = caller_id, accepted_at = now()
  where id = invitation.id;
  return membership;
end;
$$;

create or replace function public.complete_preventive_care(schedule_id text)
returns public.preventive_care_schedules
language plpgsql
security invoker
set search_path = ''
as $$
declare
  schedule public.preventive_care_schedules;
begin
  select * into schedule from public.preventive_care_schedules where id = schedule_id for update;
  if schedule.id is null then raise exception 'Preventive care schedule not found or not editable'; end if;
  insert into public.care_records (owner_id, pet_id, kind, title, note, metadata)
  values (
    schedule.owner_id,
    schedule.pet_id,
    case when schedule.kind = 'vaccine' then 'vaccine'::public.care_record_kind else 'medical'::public.care_record_kind end,
    schedule.title,
    schedule.note,
    jsonb_build_object('preventive_care_schedule_id', schedule.id, 'preventive_care_kind', schedule.kind)
  );
  update public.preventive_care_schedules
  set last_completed_on = current_date,
      next_due_on = (current_date + make_interval(months => schedule.interval_months))::date
  where id = schedule.id
  returning * into schedule;
  return schedule;
end;
$$;

create or replace function public.sync_medication_plan_reminders(target_plan_id text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_plan public.medication_plans%rowtype;
begin
  select * into target_plan from public.medication_plans where id = target_plan_id;
  if not found then raise exception 'Medication plan not found'; end if;
  update public.medication_reminders
  set status = 'cancelled'
  where medication_plan_id = target_plan.id
    and status in ('pending', 'overdue')
    and (not target_plan.is_active or scheduled_at >= now());
  if not target_plan.is_active then return; end if;
  insert into public.medication_reminders (owner_id, pet_id, medication_plan_id, scheduled_at)
  select
    target_plan.owner_id,
    target_plan.pet_id,
    target_plan.id,
    ((generated_day.value::date + reminder_clock.value)::timestamp at time zone target_plan.timezone)
  from generate_series(target_plan.start_date, target_plan.end_date, interval '1 day') as generated_day(value)
  cross join unnest(target_plan.times) as reminder_clock(value)
  where ((generated_day.value::date + reminder_clock.value)::timestamp at time zone target_plan.timezone) >= now() - interval '24 hours'
  on conflict (medication_plan_id, scheduled_at) do update
    set status = case when public.medication_reminders.status = 'cancelled' then 'pending' else public.medication_reminders.status end;
end;
$$;

create or replace function public.refresh_medication_reminders(target_pet_id text)
returns setof public.medication_reminders
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.medication_reminders as current_reminder
  set status = 'overdue', overdue_at = coalesce(current_reminder.overdue_at, now())
  where current_reminder.pet_id = target_pet_id
    and current_reminder.status = 'pending'
    and current_reminder.scheduled_at < now()
    and (
      current_reminder.scheduled_at < now() - interval '6 hours'
      or exists (
        select 1 from public.medication_reminders later_reminder
        where later_reminder.medication_plan_id = current_reminder.medication_plan_id
          and later_reminder.scheduled_at > current_reminder.scheduled_at
          and later_reminder.scheduled_at <= now()
          and later_reminder.status <> 'cancelled'
      )
    );
  return query
  select reminder.* from public.medication_reminders reminder
  where reminder.pet_id = target_pet_id and reminder.status in ('pending', 'overdue')
  order by reminder.scheduled_at;
end;
$$;

create or replace function public.complete_medication_reminder(
  reminder_id text,
  actual_administered_at timestamptz default now()
)
returns public.medication_reminders
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_reminder public.medication_reminders%rowtype;
  target_plan public.medication_plans%rowtype;
  created_record_id text;
  server_now timestamptz := now();
  resolver_id text := (select private.current_profile_id());
begin
  select * into target_reminder from public.medication_reminders where id = reminder_id for update;
  if not found then raise exception 'Medication reminder not found'; end if;
  if target_reminder.status not in ('pending', 'overdue') then raise exception 'Medication reminder has already been resolved'; end if;
  if actual_administered_at > server_now + interval '5 minutes' then raise exception 'Administration time cannot be in the future'; end if;
  select * into target_plan from public.medication_plans where id = target_reminder.medication_plan_id;
  insert into public.care_records (
    owner_id, pet_id, kind, occurred_at, source, title, medication_name, medication_dose, note, metadata
  ) values (
    target_reminder.owner_id,
    target_reminder.pet_id,
    'medication',
    actual_administered_at,
    'medication_reminder',
    target_plan.title,
    target_plan.title,
    case
      when target_plan.dose_amount is not null and target_plan.dose_unit is not null
        then concat(target_plan.dose_amount, ' ', target_plan.dose_unit)
      else target_plan.dose
    end,
    target_plan.instruction,
    jsonb_build_object(
      'schema_version', 1,
      'medication_plan_id', target_plan.id,
      'medication_reminder_id', target_reminder.id,
      'scheduled_at', target_reminder.scheduled_at,
      'dose_amount', target_plan.dose_amount,
      'dose_unit', target_plan.dose_unit,
      'resolved_by', resolver_id
    )
  ) returning id into created_record_id;
  update public.medication_reminders
  set status = 'completed',
      completed_at = server_now,
      administered_at = actual_administered_at,
      resolved_by = resolver_id,
      care_record_id = created_record_id
  where id = target_reminder.id
  returning * into target_reminder;
  return target_reminder;
end;
$$;

create or replace function public.resolve_missed_medication_reminder(
  reminder_id text,
  was_administered boolean,
  actual_administered_at timestamptz default null
)
returns public.medication_reminders
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_reminder public.medication_reminders%rowtype;
begin
  select * into target_reminder from public.medication_reminders where id = reminder_id for update;
  if not found then raise exception 'Medication reminder not found'; end if;
  if target_reminder.status <> 'overdue' then raise exception 'Only overdue reminders can be resolved'; end if;
  if was_administered then
    return public.complete_medication_reminder(reminder_id, coalesce(actual_administered_at, target_reminder.scheduled_at));
  end if;
  update public.medication_reminders
  set status = 'skipped', skipped_at = now(), resolved_by = (select private.current_profile_id())
  where id = reminder_id
  returning * into target_reminder;
  return target_reminder;
end;
$$;

create or replace function public.create_medication_plan_with_reminders(
  plan_owner_id text,
  plan_pet_id text,
  plan_title text,
  plan_dose text,
  plan_dose_amount numeric,
  plan_dose_unit text,
  plan_times time[],
  plan_start_date date,
  plan_end_date date,
  plan_instruction text default null,
  plan_note text default null,
  plan_timezone text default 'Asia/Taipei',
  plan_request_key text default null
)
returns public.medication_plans
language plpgsql
security invoker
set search_path = public
as $$
declare
  created_plan public.medication_plans%rowtype;
  time_index integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if plan_owner_id is null or plan_pet_id is null then raise exception 'Pet and owner are required'; end if;
  if plan_request_key is null or char_length(trim(plan_request_key)) < 8 then raise exception 'A valid request key is required'; end if;
  if cardinality(plan_times) not between 1 and 3 then raise exception 'Medication times must contain between 1 and 3 values'; end if;
  if plan_end_date < plan_start_date or plan_end_date > plan_start_date + 365 then raise exception 'Medication plan date range is invalid'; end if;
  for time_index in 2..cardinality(plan_times) loop
    if plan_times[time_index] < plan_times[time_index - 1] + interval '5 minutes' then
      raise exception 'Medication times must be at least 5 minutes apart and strictly increasing';
    end if;
  end loop;
  insert into public.medication_plans (
    owner_id, pet_id, title, dose, dose_amount, dose_unit, times,
    start_date, end_date, instruction, note, timezone, client_request_key
  ) values (
    plan_owner_id, plan_pet_id, plan_title, plan_dose, plan_dose_amount, plan_dose_unit, plan_times,
    plan_start_date, plan_end_date, plan_instruction, plan_note, plan_timezone, trim(plan_request_key)
  )
  on conflict (owner_id, client_request_key) do nothing
  returning * into created_plan;
  if created_plan.id is null then
    select * into created_plan from public.medication_plans
    where owner_id = plan_owner_id and client_request_key = trim(plan_request_key);
  end if;
  if created_plan.id is null then raise exception 'Medication plan could not be created'; end if;
  perform public.sync_medication_plan_reminders(created_plan.id);
  return created_plan;
end;
$$;

revoke all on function public.accept_pet_invitation(text) from public, anon;
revoke all on function public.accept_pet_invitation_code(text) from public, anon;
revoke all on function public.complete_preventive_care(text) from public, anon;
revoke all on function public.sync_medication_plan_reminders(text) from public, anon;
revoke all on function public.refresh_medication_reminders(text) from public, anon;
revoke all on function public.complete_medication_reminder(text, timestamptz) from public, anon;
revoke all on function public.resolve_missed_medication_reminder(text, boolean, timestamptz) from public, anon;
revoke all on function public.create_medication_plan_with_reminders(
  text, text, text, text, numeric, text, time[], date, date, text, text, text, text
) from public, anon;

grant execute on function public.accept_pet_invitation(text) to authenticated;
grant execute on function public.accept_pet_invitation_code(text) to authenticated;
grant execute on function public.complete_preventive_care(text) to authenticated;
grant execute on function public.sync_medication_plan_reminders(text) to authenticated;
grant execute on function public.refresh_medication_reminders(text) to authenticated;
grant execute on function public.complete_medication_reminder(text, timestamptz) to authenticated;
grant execute on function public.resolve_missed_medication_reminder(text, boolean, timestamptz) to authenticated;
grant execute on function public.create_medication_plan_with_reminders(
  text, text, text, text, numeric, text, time[], date, date, text, text, text, text
) to authenticated;

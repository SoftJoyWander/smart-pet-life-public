-- Multi-pet access and shared caregiver authorization.
-- Pet ownership stays immutable; collaborators receive explicit memberships.

create type public.pet_member_role as enum ('viewer', 'editor');
create type public.pet_invitation_status as enum ('pending', 'accepted', 'revoked', 'expired');

create table public.pet_memberships (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null,
  owner_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.pet_member_role not null default 'editor',
  invited_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pet_memberships_pet_owner_fk
    foreign key (pet_id, owner_id) references public.pets(id, owner_id) on delete cascade,
  constraint pet_memberships_not_owner check (user_id <> owner_id),
  unique (pet_id, user_id)
);

create table public.pet_invitations (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null,
  owner_id uuid not null,
  invited_email text not null check (
    char_length(trim(invited_email)) between 3 and 320
    and invited_email = lower(trim(invited_email))
  ),
  role public.pet_member_role not null default 'editor',
  status public.pet_invitation_status not null default 'pending',
  invited_by uuid not null references public.profiles(id),
  accepted_by uuid references public.profiles(id),
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pet_invitations_pet_owner_fk
    foreign key (pet_id, owner_id) references public.pets(id, owner_id) on delete cascade
);

create unique index pet_invitations_one_pending_email_idx
  on public.pet_invitations (pet_id, invited_email)
  where status = 'pending';
create index pet_memberships_user_pet_idx on public.pet_memberships (user_id, pet_id);
create index pet_memberships_pet_user_idx on public.pet_memberships (pet_id, user_id);
create index pet_invitations_email_status_idx on public.pet_invitations (invited_email, status);
create index pet_invitations_pet_status_idx on public.pet_invitations (pet_id, status);

create trigger pet_memberships_set_updated_at before update on public.pet_memberships
for each row execute function public.set_updated_at();
create trigger pet_invitations_set_updated_at before update on public.pet_invitations
for each row execute function public.set_updated_at();

create or replace function public.protect_pet_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.owner_id is distinct from old.owner_id then
    raise exception 'pets.owner_id cannot be changed';
  end if;
  return new;
end;
$$;

create trigger pets_protect_owner before update on public.pets
for each row execute function public.protect_pet_owner();

alter table public.pet_memberships enable row level security;
alter table public.pet_invitations enable row level security;

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.can_access_pet(target_pet_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.pets p
    where p.id = target_pet_id
      and (
        p.owner_id = (select auth.uid())
        or exists (
          select 1 from public.pet_memberships pm
          where pm.pet_id = p.id and pm.user_id = (select auth.uid())
        )
      )
  );
$$;

create or replace function private.can_edit_pet(target_pet_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.pets p
    where p.id = target_pet_id
      and (
        p.owner_id = (select auth.uid())
        or exists (
          select 1 from public.pet_memberships pm
          where pm.pet_id = p.id
            and pm.user_id = (select auth.uid())
            and pm.role = 'editor'
        )
      )
  );
$$;

revoke all on function private.can_access_pet(uuid) from public, anon;
revoke all on function private.can_edit_pet(uuid) from public, anon;
grant execute on function private.can_access_pet(uuid) to authenticated;
grant execute on function private.can_edit_pet(uuid) to authenticated;

-- Replace owner-only policies with membership-aware policies.
drop policy "Owners can read their pets" on public.pets;
drop policy "Owners can update their pets" on public.pets;
create policy "Authorized users can read pets" on public.pets for select to authenticated
using ((select private.can_access_pet(id)));
create policy "Authorized editors can update pets" on public.pets for update to authenticated
using ((select private.can_edit_pet(id)))
with check ((select private.can_edit_pet(id)));

drop policy "Owners can create their care records" on public.care_records;
drop policy "Owners can read their care records" on public.care_records;
drop policy "Owners can update their care records" on public.care_records;
drop policy "Owners can delete their care records" on public.care_records;
create policy "Authorized editors can create care records" on public.care_records for insert to authenticated
with check ((select private.can_edit_pet(pet_id)));
create policy "Authorized users can read care records" on public.care_records for select to authenticated
using ((select private.can_access_pet(pet_id)));
create policy "Authorized editors can update care records" on public.care_records for update to authenticated
using ((select private.can_edit_pet(pet_id))) with check ((select private.can_edit_pet(pet_id)));
create policy "Authorized editors can delete care records" on public.care_records for delete to authenticated
using ((select private.can_edit_pet(pet_id)));

drop policy "Owners can create their medication plans" on public.medication_plans;
drop policy "Owners can read their medication plans" on public.medication_plans;
drop policy "Owners can update their medication plans" on public.medication_plans;
create policy "Authorized editors can create medication plans" on public.medication_plans for insert to authenticated
with check ((select private.can_edit_pet(pet_id)));
create policy "Authorized users can read medication plans" on public.medication_plans for select to authenticated
using ((select private.can_access_pet(pet_id)));
create policy "Authorized editors can update medication plans" on public.medication_plans for update to authenticated
using ((select private.can_edit_pet(pet_id))) with check ((select private.can_edit_pet(pet_id)));

drop policy "Owners can create their medication reminders" on public.medication_reminders;
drop policy "Owners can read their medication reminders" on public.medication_reminders;
drop policy "Owners can update their medication reminders" on public.medication_reminders;
create policy "Authorized editors can create medication reminders" on public.medication_reminders for insert to authenticated
with check ((select private.can_edit_pet(pet_id)));
create policy "Authorized users can read medication reminders" on public.medication_reminders for select to authenticated
using ((select private.can_access_pet(pet_id)));
create policy "Authorized editors can update medication reminders" on public.medication_reminders for update to authenticated
using ((select private.can_edit_pet(pet_id))) with check ((select private.can_edit_pet(pet_id)));

create policy "Owners can read memberships" on public.pet_memberships for select to authenticated
using (owner_id = (select auth.uid()));
create policy "Owners can update memberships" on public.pet_memberships for update to authenticated
using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "Owners can remove memberships" on public.pet_memberships for delete to authenticated
using (owner_id = (select auth.uid()));
create policy "Members can read their membership" on public.pet_memberships for select to authenticated
using (user_id = (select auth.uid()));

create policy "Owners can manage invitations" on public.pet_invitations for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()) and invited_by = (select auth.uid()));
create policy "Invitees can read invitations" on public.pet_invitations for select to authenticated
using (
  status = 'pending'
  and expires_at > now()
  and invited_email = lower(coalesce((select auth.jwt() ->> 'email'), ''))
);

create or replace function public.accept_pet_invitation(invitation_id uuid)
returns public.pet_memberships
language plpgsql
security definer
set search_path = ''
as $$
declare
  invitation public.pet_invitations;
  membership public.pet_memberships;
  caller_id uuid := (select auth.uid());
  caller_email text := lower(coalesce((select auth.jwt() ->> 'email'), ''));
begin
  if caller_id is null or caller_email = '' then
    raise exception 'Authentication with a verified email is required';
  end if;

  select * into invitation
  from public.pet_invitations
  where id = invitation_id
  for update;

  if invitation.id is null or invitation.status <> 'pending' then
    raise exception 'Invitation is no longer available';
  end if;
  if invitation.expires_at <= now() then
    update public.pet_invitations set status = 'expired' where id = invitation.id;
    raise exception 'Invitation has expired';
  end if;
  if invitation.invited_email <> caller_email then
    raise exception 'Invitation belongs to another email address';
  end if;
  if invitation.owner_id = caller_id then
    raise exception 'Pet owners cannot accept their own invitation';
  end if;

  insert into public.pet_memberships (pet_id, owner_id, user_id, role, invited_by)
  values (invitation.pet_id, invitation.owner_id, caller_id, invitation.role, invitation.invited_by)
  on conflict (pet_id, user_id) do update set role = excluded.role, updated_at = now()
  returning * into membership;

  update public.pet_invitations
  set status = 'accepted', accepted_by = caller_id, accepted_at = now()
  where id = invitation.id;

  return membership;
end;
$$;

revoke all on function public.accept_pet_invitation(uuid) from public, anon;
grant execute on function public.accept_pet_invitation(uuid) to authenticated;

-- New Supabase projects no longer expose public tables automatically.
revoke all on public.pet_memberships from authenticated;
revoke all on public.pet_invitations from authenticated;
grant select, delete on public.pet_memberships to authenticated;
grant update (role) on public.pet_memberships to authenticated;
grant select, insert on public.pet_invitations to authenticated;
grant update (status) on public.pet_invitations to authenticated;
grant usage on type public.pet_member_role to authenticated;
grant usage on type public.pet_invitation_status to authenticated;

-- Track the accepted email on memberships so owners can prevent duplicate
-- invitations without exposing auth.users to the client.

alter table public.pet_memberships
  add column member_email text
  check (
    member_email is null
    or (
      char_length(trim(member_email)) between 3 and 320
      and member_email = lower(trim(member_email))
    )
  );

update public.pet_memberships membership
set member_email = (
  select invitation.invited_email
  from public.pet_invitations invitation
  where invitation.pet_id = membership.pet_id
    and invitation.owner_id = membership.owner_id
    and invitation.accepted_by = membership.user_id
    and invitation.status = 'accepted'
  order by invitation.accepted_at desc nulls last
  limit 1
)
where membership.member_email is null;

create unique index pet_memberships_pet_member_email_idx
  on public.pet_memberships (pet_id, member_email)
  where member_email is not null;

create or replace function public.prevent_duplicate_pet_invitation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.invited_email := lower(trim(new.invited_email));

  if exists (
    select 1
    from public.pet_memberships membership
    where membership.pet_id = new.pet_id
      and membership.owner_id = new.owner_id
      and membership.member_email = new.invited_email
  ) then
    raise exception 'This email is already a caregiver for this pet';
  end if;

  if exists (
    select 1
    from public.pet_invitations invitation
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

revoke all on function public.prevent_duplicate_pet_invitation() from public, anon, authenticated;

create trigger pet_invitations_prevent_duplicates
before insert on public.pet_invitations
for each row execute function public.prevent_duplicate_pet_invitation();

create or replace function public.accept_pet_invitation(invitation_id uuid)
returns public.pet_memberships
language plpgsql
security invoker
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
    raise exception 'Invitation has expired';
  end if;
  if invitation.invited_email <> caller_email then
    raise exception 'Invitation belongs to another email address';
  end if;
  if invitation.owner_id = caller_id then
    raise exception 'Pet owners cannot accept their own invitation';
  end if;

  insert into public.pet_memberships (pet_id, owner_id, user_id, role, invited_by, member_email)
  values (invitation.pet_id, invitation.owner_id, caller_id, invitation.role, invitation.invited_by, caller_email)
  on conflict (pet_id, user_id) do nothing
  returning * into membership;

  if membership.id is null then
    select * into membership
    from public.pet_memberships
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
  caller_id uuid := (select auth.uid());
  caller_email text := lower(coalesce((select auth.jwt() ->> 'email'), ''));
  normalized_code text := upper(regexp_replace(coalesce(join_code, ''), '[^a-zA-Z0-9]', '', 'g'));
begin
  if caller_id is null or caller_email = '' then
    raise exception 'Authentication with a verified email is required';
  end if;

  select * into invitation
  from public.pet_invitations
  where invite_code = normalized_code
  for update;

  if invitation.id is null or invitation.status <> 'pending' then
    raise exception 'Invitation code is invalid or no longer available';
  end if;
  if invitation.expires_at <= now() then
    raise exception 'Invitation has expired';
  end if;
  if invitation.invited_email <> caller_email then
    raise exception 'Invitation belongs to another email address';
  end if;
  if invitation.owner_id = caller_id then
    raise exception 'Pet owners cannot accept their own invitation';
  end if;

  insert into public.pet_memberships (pet_id, owner_id, user_id, role, invited_by, member_email)
  values (invitation.pet_id, invitation.owner_id, caller_id, invitation.role, invitation.invited_by, caller_email)
  on conflict (pet_id, user_id) do nothing
  returning * into membership;

  if membership.id is null then
    select * into membership
    from public.pet_memberships
    where pet_id = invitation.pet_id and user_id = caller_id;
  end if;

  update public.pet_invitations
  set status = 'accepted', accepted_by = caller_id, accepted_at = now()
  where id = invitation.id;

  return membership;
end;
$$;

-- Validate invitation recipients against Supabase Auth and compare memberships
-- by user id. This remains authoritative even when older membership rows do not
-- have member_email populated.

drop trigger if exists pet_invitations_prevent_duplicates on public.pet_invitations;
drop function if exists public.prevent_duplicate_pet_invitation();

create or replace function private.validate_pet_invitation_recipient()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  target_user_id uuid;
begin
  if caller_id is null then
    raise exception 'Authentication is required to create an invitation';
  end if;

  if caller_id <> new.owner_id or caller_id <> new.invited_by then
    raise exception 'Only the pet owner can create an invitation';
  end if;

  if not exists (
    select 1
    from public.pets pet
    where pet.id = new.pet_id
      and pet.owner_id = caller_id
      and pet.archived_at is null
  ) then
    raise exception 'Pet is not available for invitation';
  end if;

  new.invited_email := lower(trim(new.invited_email));

  select auth_user.id
  into target_user_id
  from auth.users auth_user
  where lower(auth_user.email) = new.invited_email
    and auth_user.deleted_at is null
  order by auth_user.created_at asc
  limit 1;

  if target_user_id is null then
    raise exception 'No registered account exists for this email';
  end if;

  if target_user_id = new.owner_id then
    raise exception 'Pet owners cannot invite themselves';
  end if;

  if exists (
    select 1
    from public.pet_memberships membership
    where membership.pet_id = new.pet_id
      and membership.owner_id = new.owner_id
      and membership.user_id = target_user_id
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

revoke all on function private.validate_pet_invitation_recipient() from public, anon, authenticated;

create trigger pet_invitations_validate_recipient
before insert on public.pet_invitations
for each row execute function private.validate_pet_invitation_recipient();

-- Revoke stale pending invitations which would now fail validation.
update public.pet_invitations invitation
set status = 'revoked', updated_at = now()
where invitation.status = 'pending'
  and (
    not exists (
      select 1
      from auth.users auth_user
      where lower(auth_user.email) = invitation.invited_email
        and auth_user.deleted_at is null
    )
    or exists (
      select 1
      from auth.users auth_user
      join public.pet_memberships membership
        on membership.user_id = auth_user.id
       and membership.pet_id = invitation.pet_id
       and membership.owner_id = invitation.owner_id
      where lower(auth_user.email) = invitation.invited_email
        and auth_user.deleted_at is null
    )
  );

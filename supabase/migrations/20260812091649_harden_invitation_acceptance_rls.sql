-- Accepting an invitation now runs with the caller's privileges. Narrow RLS
-- policies authorize only the membership insert and invitation update tied to
-- the signed-in user's verified email.

create policy "Invitees can create their invited membership"
on public.pet_memberships for insert to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.pet_invitations invitation
    where invitation.pet_id = pet_memberships.pet_id
      and invitation.owner_id = pet_memberships.owner_id
      and invitation.invited_by = pet_memberships.invited_by
      and invitation.role = pet_memberships.role
      and invitation.status = 'pending'
      and invitation.expires_at > now()
      and invitation.invited_email = (select lower(coalesce(auth.jwt() ->> 'email', '')))
  )
);

create policy "Invitees can accept their invitation"
on public.pet_invitations for update to authenticated
using (
  status = 'pending'
  and expires_at > now()
  and invited_email = (select lower(coalesce(auth.jwt() ->> 'email', '')))
)
with check (
  status = 'accepted'
  and accepted_by = (select auth.uid())
  and accepted_at is not null
  and invited_email = (select lower(coalesce(auth.jwt() ->> 'email', '')))
);

grant insert on public.pet_memberships to authenticated;
grant update (status, accepted_by, accepted_at) on public.pet_invitations to authenticated;

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

  insert into public.pet_memberships (pet_id, owner_id, user_id, role, invited_by)
  values (invitation.pet_id, invitation.owner_id, caller_id, invitation.role, invitation.invited_by)
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

  insert into public.pet_memberships (pet_id, owner_id, user_id, role, invited_by)
  values (invitation.pet_id, invitation.owner_id, caller_id, invitation.role, invitation.invited_by)
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

revoke all on function public.accept_pet_invitation(uuid) from public, anon;
revoke all on function public.accept_pet_invitation_code(text) from public, anon;
grant execute on function public.accept_pet_invitation(uuid) to authenticated;
grant execute on function public.accept_pet_invitation_code(text) to authenticated;

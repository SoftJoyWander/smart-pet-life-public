-- A short code lets the intended invitee accept a collaboration invitation
-- through manual entry or a QR code. Email ownership is still verified by the
-- acceptance function, so possession of a code alone never grants pet access.

alter table public.pet_invitations
  add column invite_code text
  default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));

update public.pet_invitations
set invite_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
where invite_code is null;

alter table public.pet_invitations
  alter column invite_code set not null;

alter table public.pet_invitations
  add constraint pet_invitations_invite_code_format
  check (invite_code ~ '^[A-F0-9]{10}$');

create unique index pet_invitations_invite_code_idx
  on public.pet_invitations (invite_code);

create or replace function public.accept_pet_invitation_code(join_code text)
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
  on conflict (pet_id, user_id) do update
    set role = excluded.role, updated_at = now()
  returning * into membership;

  update public.pet_invitations
  set status = 'accepted', accepted_by = caller_id, accepted_at = now()
  where id = invitation.id;

  return membership;
end;
$$;

revoke all on function public.accept_pet_invitation_code(text) from public, anon;
grant execute on function public.accept_pet_invitation_code(text) to authenticated;

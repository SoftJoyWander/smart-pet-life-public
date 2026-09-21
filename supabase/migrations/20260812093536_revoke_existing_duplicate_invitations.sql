-- Remove stale pending invitations for emails that already have membership.
update public.pet_invitations invitation
set status = 'revoked', updated_at = now()
where invitation.status = 'pending'
  and exists (
    select 1
    from public.pet_memberships membership
    where membership.pet_id = invitation.pet_id
      and membership.owner_id = invitation.owner_id
      and membership.member_email = invitation.invited_email
  );

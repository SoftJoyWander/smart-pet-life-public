-- Cache Auth helper results once per statement. This policy is evaluated for
-- both REST reads and RLS-protected Realtime Postgres Changes.
drop policy "Authorized users can read invitations" on public.pet_invitations;

create policy "Authorized users can read invitations"
on public.pet_invitations for select to authenticated
using (
  owner_id = (select auth.uid())
  or (
    status = 'pending'
    and expires_at > now()
    and invited_email = lower(coalesce((select auth.jwt()) ->> 'email', ''))
  )
);

-- Security and query-plan hardening after advisor review.

revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop policy "Owners can read memberships" on public.pet_memberships;
drop policy "Members can read their membership" on public.pet_memberships;
create policy "Authorized users can read memberships"
on public.pet_memberships for select to authenticated
using (owner_id = (select auth.uid()) or user_id = (select auth.uid()));

drop policy "Owners can manage invitations" on public.pet_invitations;
drop policy "Invitees can read invitations" on public.pet_invitations;
create policy "Authorized users can read invitations"
on public.pet_invitations for select to authenticated
using (
  owner_id = (select auth.uid())
  or (
    status = 'pending'
    and expires_at > now()
    and invited_email = (select lower(coalesce(auth.jwt() ->> 'email', '')))
  )
);
create policy "Owners can create invitations"
on public.pet_invitations for insert to authenticated
with check (owner_id = (select auth.uid()) and invited_by = (select auth.uid()));
create policy "Owners can update invitations"
on public.pet_invitations for update to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));
create policy "Owners can delete invitations"
on public.pet_invitations for delete to authenticated
using (owner_id = (select auth.uid()));

drop policy "Owners can read their profile" on public.profiles;
drop policy "Owners can update their profile" on public.profiles;
create policy "Owners can read their profile" on public.profiles for select to authenticated
using (id = (select auth.uid()));
create policy "Owners can update their profile" on public.profiles for update to authenticated
using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy "Owners can create their pets" on public.pets;
create policy "Owners can create their pets" on public.pets for insert to authenticated
with check (owner_id = (select auth.uid()));

create index care_records_pet_owner_fk_idx on public.care_records (pet_id, owner_id);
create index medication_plans_pet_owner_fk_idx on public.medication_plans (pet_id, owner_id);
create index medication_reminders_plan_owner_fk_idx on public.medication_reminders (medication_plan_id, pet_id, owner_id);
create index medication_reminders_care_record_idx on public.medication_reminders (care_record_id) where care_record_id is not null;
create index pet_memberships_pet_owner_fk_idx on public.pet_memberships (pet_id, owner_id);
create index pet_memberships_invited_by_idx on public.pet_memberships (invited_by);
create index pet_invitations_pet_owner_fk_idx on public.pet_invitations (pet_id, owner_id);
create index pet_invitations_invited_by_idx on public.pet_invitations (invited_by);
create index pet_invitations_accepted_by_idx on public.pet_invitations (accepted_by) where accepted_by is not null;

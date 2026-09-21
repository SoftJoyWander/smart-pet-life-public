-- `insert(...).select()` evaluates the SELECT policy in the same statement.
-- The membership helper is STABLE and looks the pet up again, so it cannot see
-- the just-inserted row in that statement snapshot. Let the owner pass directly
-- from the candidate row while retaining the existing membership-aware helper.
drop policy if exists "Authorized users can read pets" on public.pets;

create policy "Authorized users can read pets"
on public.pets
for select
to authenticated
using (
  owner_id = (select private.current_profile_id())
  or (select private.can_access_pet(id))
);

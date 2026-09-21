-- Pet avatar objects live under owner_id/pet_id. Storage access follows the
-- same owner/editor/viewer permissions as the pet itself.

create or replace function private.can_access_pet_media(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.pets p
    where p.id::text = split_part(object_name, '/', 2)
      and (
        p.owner_id = (select auth.uid())
        or exists (
          select 1
          from public.pet_memberships pm
          where pm.pet_id = p.id
            and pm.user_id = (select auth.uid())
        )
      )
  );
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
    from public.pets p
    where p.id::text = split_part(object_name, '/', 2)
      and (
        p.owner_id = (select auth.uid())
        or exists (
          select 1
          from public.pet_memberships pm
          where pm.pet_id = p.id
            and pm.user_id = (select auth.uid())
            and pm.role = 'editor'
        )
      )
  );
$$;

revoke all on function private.can_access_pet_media(text) from public, anon;
revoke all on function private.can_edit_pet_media(text) from public, anon;
grant execute on function private.can_access_pet_media(text) to authenticated;
grant execute on function private.can_edit_pet_media(text) to authenticated;

drop policy "Owners can read their pet media" on storage.objects;
drop policy "Owners can upload their pet media" on storage.objects;
drop policy "Owners can update their pet media" on storage.objects;
drop policy "Owners can delete their pet media" on storage.objects;

create policy "Authorized users can read pet media"
on storage.objects for select to authenticated
using (
  bucket_id = 'pet-media'
  and (select private.can_access_pet_media(name))
);

create policy "Authorized editors can upload pet media"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'pet-media'
  and (select private.can_edit_pet_media(name))
);

create policy "Authorized editors can update pet media"
on storage.objects for update to authenticated
using (
  bucket_id = 'pet-media'
  and (select private.can_edit_pet_media(name))
)
with check (
  bucket_id = 'pet-media'
  and (select private.can_edit_pet_media(name))
);

create policy "Authorized editors can delete pet media"
on storage.objects for delete to authenticated
using (
  bucket_id = 'pet-media'
  and (select private.can_edit_pet_media(name))
);

create or replace function private.protect_pet_birthday()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
     and new.birthday is distinct from old.birthday then
    raise exception using
      errcode = '23514',
      message = 'Pet birthday cannot be changed after creation';
  end if;
  return new;
end;
$$;

revoke all on function private.protect_pet_birthday() from public, anon, authenticated;

create trigger pets_protect_birthday
before update of birthday on public.pets
for each row execute function private.protect_pet_birthday();

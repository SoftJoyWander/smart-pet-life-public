-- Care record time is assigned by the database and is immutable afterwards.
-- Owners may still edit record details or delete the complete historical row.

create or replace function public.set_care_record_server_time()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.occurred_at = now();
  new.created_at = now();
  return new;
end;
$$;

create trigger care_records_set_server_time
before insert on public.care_records
for each row execute function public.set_care_record_server_time();

create or replace function public.protect_care_record_time()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.occurred_at is distinct from old.occurred_at then
    raise exception 'care_records.occurred_at cannot be changed';
  end if;

  -- created_at is an audit field and must also stay unchanged.
  new.created_at = old.created_at;
  return new;
end;
$$;

create trigger care_records_protect_time
before update on public.care_records
for each row execute function public.protect_care_record_time();

create policy "Owners can delete their care records"
on public.care_records for delete
using (owner_id = auth.uid());

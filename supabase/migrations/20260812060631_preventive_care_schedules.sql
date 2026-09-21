-- Configurable vaccine and deworming schedules for each pet.

create type public.preventive_care_kind as enum ('deworming', 'vaccine');

create table public.preventive_care_schedules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  pet_id uuid not null,
  kind public.preventive_care_kind not null,
  title text not null check (char_length(trim(title)) between 1 and 80),
  interval_days smallint not null check (interval_days between 1 and 1095),
  last_completed_on date,
  next_due_on date not null,
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint preventive_care_schedules_pet_owner_fk
    foreign key (pet_id, owner_id) references public.pets(id, owner_id) on delete cascade,
  constraint preventive_care_dates_ordered
    check (last_completed_on is null or next_due_on > last_completed_on),
  unique (pet_id, kind)
);

create index preventive_care_schedules_pet_owner_idx
  on public.preventive_care_schedules (pet_id, owner_id);
create index preventive_care_schedules_due_idx
  on public.preventive_care_schedules (next_due_on);

create trigger preventive_care_schedules_set_updated_at
before update on public.preventive_care_schedules
for each row execute function public.set_updated_at();

alter table public.preventive_care_schedules enable row level security;

create policy "Authorized users can read preventive care schedules"
on public.preventive_care_schedules for select to authenticated
using ((select private.can_access_pet(pet_id)));

create policy "Authorized editors can create preventive care schedules"
on public.preventive_care_schedules for insert to authenticated
with check ((select private.can_edit_pet(pet_id)));

create policy "Authorized editors can update preventive care schedules"
on public.preventive_care_schedules for update to authenticated
using ((select private.can_edit_pet(pet_id)))
with check ((select private.can_edit_pet(pet_id)));

grant select, insert, update on public.preventive_care_schedules to authenticated;
grant usage on type public.preventive_care_kind to authenticated;

create or replace function public.complete_preventive_care(schedule_id uuid)
returns public.preventive_care_schedules
language plpgsql
security invoker
set search_path = ''
as $$
declare
  schedule public.preventive_care_schedules;
begin
  select * into schedule
  from public.preventive_care_schedules
  where id = schedule_id
  for update;

  if schedule.id is null then
    raise exception 'Preventive care schedule not found or not editable';
  end if;

  insert into public.care_records (
    owner_id,
    pet_id,
    kind,
    title,
    note,
    metadata
  ) values (
    schedule.owner_id,
    schedule.pet_id,
    case when schedule.kind = 'vaccine' then 'vaccine'::public.care_record_kind else 'medical'::public.care_record_kind end,
    schedule.title,
    schedule.note,
    jsonb_build_object('preventive_care_schedule_id', schedule.id, 'preventive_care_kind', schedule.kind)
  );

  update public.preventive_care_schedules
  set last_completed_on = current_date,
      next_due_on = current_date + schedule.interval_days
  where id = schedule.id
  returning * into schedule;

  return schedule;
end;
$$;

revoke all on function public.complete_preventive_care(uuid) from public, anon;
grant execute on function public.complete_preventive_care(uuid) to authenticated;

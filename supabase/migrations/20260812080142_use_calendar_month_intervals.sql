-- Month choices follow calendar months. For example, completing on March 4
-- with a one-month interval produces an April 4 due date.

alter table public.preventive_care_schedules
rename column interval_days to interval_months;

alter table public.preventive_care_schedules
drop constraint preventive_care_schedules_interval_days_check;

update public.preventive_care_schedules
set interval_months = case
  when kind = 'vaccine' then 12
  when interval_months = 60 then 2
  when interval_months = 90 then 3
  else 1
end;

alter table public.preventive_care_schedules
add constraint preventive_care_schedules_interval_months_check
check (interval_months between 1 and 36);

update public.preventive_care_schedules
set next_due_on = (last_completed_on + make_interval(months => interval_months))::date;

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
      next_due_on = (current_date + make_interval(months => schedule.interval_months))::date
  where id = schedule.id
  returning * into schedule;

  return schedule;
end;
$$;

revoke all on function public.complete_preventive_care(uuid) from public, anon;
grant execute on function public.complete_preventive_care(uuid) to authenticated;

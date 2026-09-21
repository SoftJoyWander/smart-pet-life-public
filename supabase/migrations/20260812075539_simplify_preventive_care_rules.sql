-- A schedule represents a treatment that has already been completed. The next
-- due date is always derived from that completion date and the fixed interval.

update public.preventive_care_schedules
set last_completed_on = next_due_on - interval_days
where last_completed_on is null;

update public.preventive_care_schedules
set title = '疫苗',
    interval_days = 365
where kind = 'vaccine';

update public.preventive_care_schedules
set interval_days = case
  when interval_days in (30, 60, 90) then interval_days
  else 30
end
where kind = 'deworming';

update public.preventive_care_schedules
set next_due_on = last_completed_on + interval_days;

alter table public.preventive_care_schedules
alter column last_completed_on set not null;

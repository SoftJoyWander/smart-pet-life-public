alter table public.medication_reminders alter column status drop default;
alter table public.medication_reminders alter column status type text using status::text;
alter table public.medication_reminders alter column status set default 'pending';
alter table public.medication_reminders
  add constraint medication_reminders_status_valid
  check (status in ('pending', 'overdue', 'completed', 'skipped', 'cancelled'));

alter table public.medication_plans
  add column dose_amount numeric(10, 3),
  add column dose_unit text,
  add column timezone text not null default 'Asia/Taipei',
  add constraint medication_plans_dose_amount_positive check (dose_amount is null or dose_amount > 0),
  add constraint medication_plans_dose_unit_valid check (
    dose_unit is null or dose_unit in ('mcg', 'mg', 'g', 'ml', 'tablet', 'capsule', 'packet', 'drop', 'spray', 'iu', 'other')
  );

alter table public.medication_reminders
  add column administered_at timestamptz,
  add column overdue_at timestamptz,
  add column skipped_at timestamptz,
  add column resolved_by uuid references public.profiles(id),
  add constraint medication_reminders_resolution_fields check (
    (status = 'completed' and completed_at is not null and administered_at is not null)
    or (status = 'skipped' and skipped_at is not null)
    or (status in ('pending', 'overdue', 'cancelled'))
  ) not valid;

create index medication_reminders_actionable_idx
  on public.medication_reminders (pet_id, scheduled_at)
  where status in ('pending', 'overdue');

create index medication_reminders_plan_status_idx
  on public.medication_reminders (medication_plan_id, status, scheduled_at);
create index medication_reminders_resolved_by_idx
  on public.medication_reminders (resolved_by)
  where resolved_by is not null;

create or replace function public.sync_medication_plan_reminders(target_plan_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_plan public.medication_plans%rowtype;
begin
  select * into target_plan
  from public.medication_plans
  where id = target_plan_id;

  if not found then
    raise exception 'Medication plan not found';
  end if;

  update public.medication_reminders
  set status = 'cancelled'
  where medication_plan_id = target_plan.id
    and status in ('pending', 'overdue')
    and (not target_plan.is_active or scheduled_at >= now());

  if not target_plan.is_active then return; end if;

  insert into public.medication_reminders (owner_id, pet_id, medication_plan_id, scheduled_at)
  select
    target_plan.owner_id,
    target_plan.pet_id,
    target_plan.id,
    ((generated_day.value::date + reminder_clock.value)::timestamp at time zone target_plan.timezone)
  from generate_series(target_plan.start_date, target_plan.end_date, interval '1 day') as generated_day(value)
  cross join unnest(target_plan.times) as reminder_clock(value)
  where ((generated_day.value::date + reminder_clock.value)::timestamp at time zone target_plan.timezone) >= now() - interval '24 hours'
  on conflict (medication_plan_id, scheduled_at) do update
    set status = case
      when public.medication_reminders.status = 'cancelled' then 'pending'
      else public.medication_reminders.status
    end;
end;
$$;

create or replace function public.refresh_medication_reminders(target_pet_id uuid)
returns setof public.medication_reminders
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.medication_reminders as current_reminder
  set status = 'overdue', overdue_at = coalesce(current_reminder.overdue_at, now())
  where current_reminder.pet_id = target_pet_id
    and current_reminder.status = 'pending'
    and current_reminder.scheduled_at < now()
    and (
      current_reminder.scheduled_at < now() - interval '6 hours'
      or exists (
        select 1
        from public.medication_reminders later_reminder
        where later_reminder.medication_plan_id = current_reminder.medication_plan_id
          and later_reminder.scheduled_at > current_reminder.scheduled_at
          and later_reminder.scheduled_at <= now()
          and later_reminder.status <> 'cancelled'
      )
    );

  return query
  select reminder.*
  from public.medication_reminders reminder
  where reminder.pet_id = target_pet_id
    and reminder.status in ('pending', 'overdue')
  order by reminder.scheduled_at;
end;
$$;

create or replace function public.complete_medication_reminder(
  reminder_id uuid,
  actual_administered_at timestamptz default now()
)
returns public.medication_reminders
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_reminder public.medication_reminders%rowtype;
  target_plan public.medication_plans%rowtype;
  created_record_id uuid;
  server_now timestamptz := now();
begin
  select * into target_reminder
  from public.medication_reminders
  where id = reminder_id
  for update;

  if not found then raise exception 'Medication reminder not found'; end if;
  if target_reminder.status not in ('pending', 'overdue') then
    raise exception 'Medication reminder has already been resolved';
  end if;
  if actual_administered_at > server_now + interval '5 minutes' then
    raise exception 'Administration time cannot be in the future';
  end if;

  select * into target_plan from public.medication_plans where id = target_reminder.medication_plan_id;

  insert into public.care_records (
    owner_id, pet_id, kind, occurred_at, source, title, medication_name, medication_dose, note, metadata
  ) values (
    target_reminder.owner_id,
    target_reminder.pet_id,
    'medication',
    actual_administered_at,
    'medication_reminder',
    target_plan.title,
    target_plan.title,
    case
      when target_plan.dose_amount is not null and target_plan.dose_unit is not null
        then concat(target_plan.dose_amount, ' ', target_plan.dose_unit)
      else target_plan.dose
    end,
    target_plan.instruction,
    jsonb_build_object(
      'schema_version', 1,
      'medication_plan_id', target_plan.id,
      'medication_reminder_id', target_reminder.id,
      'scheduled_at', target_reminder.scheduled_at,
      'dose_amount', target_plan.dose_amount,
      'dose_unit', target_plan.dose_unit,
      'resolved_by', auth.uid()
    )
  ) returning id into created_record_id;

  update public.medication_reminders
  set status = 'completed',
      completed_at = server_now,
      administered_at = actual_administered_at,
      resolved_by = auth.uid(),
      care_record_id = created_record_id
  where id = target_reminder.id
  returning * into target_reminder;

  return target_reminder;
end;
$$;

create or replace function public.resolve_missed_medication_reminder(
  reminder_id uuid,
  was_administered boolean,
  actual_administered_at timestamptz default null
)
returns public.medication_reminders
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_reminder public.medication_reminders%rowtype;
begin
  select * into target_reminder
  from public.medication_reminders
  where id = reminder_id
  for update;

  if not found then raise exception 'Medication reminder not found'; end if;
  if target_reminder.status <> 'overdue' then raise exception 'Only overdue reminders can be resolved'; end if;

  if was_administered then
    return public.complete_medication_reminder(reminder_id, coalesce(actual_administered_at, target_reminder.scheduled_at));
  end if;

  update public.medication_reminders
  set status = 'skipped', skipped_at = now(), resolved_by = auth.uid()
  where id = reminder_id
  returning * into target_reminder;

  return target_reminder;
end;
$$;

revoke all on function public.sync_medication_plan_reminders(uuid) from public, anon;
revoke all on function public.refresh_medication_reminders(uuid) from public, anon;
revoke all on function public.complete_medication_reminder(uuid, timestamptz) from public, anon;
revoke all on function public.resolve_missed_medication_reminder(uuid, boolean, timestamptz) from public, anon;
grant execute on function public.sync_medication_plan_reminders(uuid) to authenticated;
grant execute on function public.refresh_medication_reminders(uuid) to authenticated;
grant execute on function public.complete_medication_reminder(uuid, timestamptz) to authenticated;
grant execute on function public.resolve_missed_medication_reminder(uuid, boolean, timestamptz) to authenticated;

do $$
declare
  active_plan_id uuid;
begin
  for active_plan_id in select id from public.medication_plans where is_active loop
    perform public.sync_medication_plan_reminders(active_plan_id);
  end loop;
end;
$$;

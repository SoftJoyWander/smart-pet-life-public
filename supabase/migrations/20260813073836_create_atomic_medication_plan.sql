alter table public.medication_plans
  add column client_request_key text,
  add constraint medication_plans_owner_request_key_unique unique (owner_id, client_request_key);

create or replace function public.create_medication_plan_with_reminders(
  plan_owner_id uuid,
  plan_pet_id uuid,
  plan_title text,
  plan_dose text,
  plan_dose_amount numeric,
  plan_dose_unit text,
  plan_times time[],
  plan_start_date date,
  plan_end_date date,
  plan_instruction text default null,
  plan_note text default null,
  plan_timezone text default 'Asia/Taipei',
  plan_request_key text default null
)
returns public.medication_plans
language plpgsql
security invoker
set search_path = public
as $$
declare
  created_plan public.medication_plans%rowtype;
  time_index integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if plan_owner_id is null or plan_pet_id is null then
    raise exception 'Pet and owner are required';
  end if;
  if plan_request_key is null or char_length(trim(plan_request_key)) < 8 then
    raise exception 'A valid request key is required';
  end if;
  if cardinality(plan_times) not between 1 and 3 then
    raise exception 'Medication times must contain between 1 and 3 values';
  end if;
  if plan_end_date < plan_start_date or plan_end_date > plan_start_date + 365 then
    raise exception 'Medication plan date range is invalid';
  end if;

  for time_index in 2..cardinality(plan_times) loop
    if plan_times[time_index] < plan_times[time_index - 1] + interval '5 minutes' then
      raise exception 'Medication times must be at least 5 minutes apart and strictly increasing';
    end if;
  end loop;

  insert into public.medication_plans (
    owner_id,
    pet_id,
    title,
    dose,
    dose_amount,
    dose_unit,
    times,
    start_date,
    end_date,
    instruction,
    note,
    timezone,
    client_request_key
  ) values (
    plan_owner_id,
    plan_pet_id,
    plan_title,
    plan_dose,
    plan_dose_amount,
    plan_dose_unit,
    plan_times,
    plan_start_date,
    plan_end_date,
    plan_instruction,
    plan_note,
    plan_timezone,
    trim(plan_request_key)
  )
  on conflict (owner_id, client_request_key) do nothing
  returning * into created_plan;

  if created_plan.id is null then
    select * into created_plan
    from public.medication_plans
    where owner_id = plan_owner_id
      and client_request_key = trim(plan_request_key);
  end if;

  if created_plan.id is null then
    raise exception 'Medication plan could not be created';
  end if;

  perform public.sync_medication_plan_reminders(created_plan.id);
  return created_plan;
end;
$$;

revoke all on function public.create_medication_plan_with_reminders(
  uuid, uuid, text, text, numeric, text, time[], date, date, text, text, text, text
) from public, anon;
grant execute on function public.create_medication_plan_with_reminders(
  uuid, uuid, text, text, numeric, text, time[], date, date, text, text, text, text
) to authenticated;

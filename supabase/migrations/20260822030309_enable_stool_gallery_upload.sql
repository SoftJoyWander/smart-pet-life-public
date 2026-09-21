alter table public.stool_observations
  drop constraint stool_observations_capture_method_check;

alter table public.stool_observations
  add constraint stool_observations_capture_method_check
  check (capture_method in ('live_camera', 'gallery_upload'));

comment on column public.stool_observations.capture_method is
  'Image provenance. live_camera means captured in the current App flow; gallery_upload means selected from the device library. For gallery uploads, captured_at is the client selection time, not a trusted original-photo timestamp.';

drop function public.create_stool_observation(text, text, timestamptz, text);

create function public.create_stool_observation(
  stool_pet_id text,
  stool_client_request_key text,
  stool_captured_at timestamptz,
  stool_captured_timezone text,
  stool_capture_method text default 'live_camera'
)
returns public.stool_observations
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id text := (select private.current_profile_id());
  pet_owner_id text;
  result public.stool_observations;
begin
  if caller_id is null or not (select private.can_edit_pet(stool_pet_id)) then
    raise exception 'Not allowed to capture for this pet';
  end if;
  if length(trim(stool_client_request_key)) < 8 then
    raise exception 'Invalid client request key';
  end if;
  if stool_capture_method not in ('live_camera', 'gallery_upload') then
    raise exception 'Invalid stool capture method';
  end if;
  select owner_id into pet_owner_id from public.pets where id = stool_pet_id;

  insert into public.stool_observations (
    owner_id, pet_id, captured_by, client_request_key, captured_at, captured_timezone, capture_method
  ) values (
    pet_owner_id, stool_pet_id, caller_id, trim(stool_client_request_key),
    stool_captured_at, coalesce(nullif(trim(stool_captured_timezone), ''), 'UTC'), stool_capture_method
  )
  on conflict (captured_by, client_request_key) do update
    set updated_at = public.stool_observations.updated_at
  returning * into result;
  return result;
end
$$;

revoke all on function public.create_stool_observation(text, text, timestamptz, text, text)
  from public, anon, authenticated;
grant execute on function public.create_stool_observation(text, text, timestamptz, text, text)
  to authenticated;

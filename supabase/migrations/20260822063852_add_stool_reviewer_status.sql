create or replace function public.is_stool_reviewer()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.stool_reviewers reviewer
    where reviewer.profile_id = (select private.current_profile_id())
      and reviewer.status = 'active'
  );
$$;

revoke all on function public.is_stool_reviewer() from public, anon;
grant execute on function public.is_stool_reviewer() to authenticated;

create or replace function public.claim_next_stool_review()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id text := (select private.current_profile_id());
  queue_row private.stool_review_queue;
  observation public.stool_observations;
begin
  if not exists (
    select 1 from private.stool_reviewers
    where profile_id = caller_id and status = 'active'
  ) then
    raise exception 'Reviewer access required';
  end if;

  select * into queue_row
  from private.stool_review_queue
  where status = 'pending'
     or (status = 'claimed' and claimed_at < now() - interval '15 minutes')
  order by priority asc, created_at asc
  for update skip locked
  limit 1;

  if queue_row.id is null then return null; end if;

  update private.stool_review_queue
  set status = 'claimed', claimed_by = caller_id, claimed_at = now()
  where id = queue_row.id;

  select * into observation
  from public.stool_observations
  where id = queue_row.observation_id;

  return jsonb_build_object(
    'queueId', queue_row.id,
    'observationId', observation.id,
    'mediaPath', observation.media_path,
    'capturedAt', observation.captured_at,
    'captureMethod', observation.capture_method
  );
end
$$;

revoke all on function public.claim_next_stool_review() from public, anon;
grant execute on function public.claim_next_stool_review() to authenticated;

create or replace function public.submit_stool_human_review(
  stool_observation_id text,
  stool_label text,
  stool_note text default null
)
returns public.stool_observations
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id text := (select private.current_profile_id());
  inference_id text;
  result public.stool_observations;
begin
  if stool_label not in ('present', 'absent', 'not_assessable') then
    raise exception 'Invalid review label';
  end if;
  if not exists (
    select 1 from private.stool_reviewers
    where profile_id = caller_id and status = 'active'
  ) then
    raise exception 'Reviewer access required';
  end if;

  select inference_run_id into inference_id
  from private.stool_review_queue
  where observation_id = stool_observation_id
    and status = 'claimed'
    and claimed_by = caller_id
  for update;

  if inference_id is null then raise exception 'Review is not claimed by caller'; end if;

  insert into private.stool_annotations (
    observation_id, inference_run_id, reviewer_profile_id, label, note
  ) values (
    stool_observation_id, inference_id, caller_id, stool_label, nullif(trim(stool_note), '')
  );

  update private.stool_review_queue
  set status = 'completed', completed_at = now()
  where observation_id = stool_observation_id;

  update public.stool_observations
  set analysis_status = 'completed',
      owner_visible_result = stool_label,
      updated_at = now()
  where id = stool_observation_id
  returning * into result;

  return result;
end
$$;

revoke all on function public.submit_stool_human_review(text, text, text) from public, anon;
grant execute on function public.submit_stool_human_review(text, text, text) to authenticated;

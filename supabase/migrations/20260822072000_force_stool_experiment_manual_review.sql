create or replace function public.record_stool_inference_result(
  stool_observation_id text,
  stool_model_version text,
  stool_probability numeric,
  stool_raw_response jsonb,
  stool_latency_ms integer
)
returns public.stool_observations
language plpgsql
security definer
set search_path = ''
as $$
declare
  inference_id text;
  result public.stool_observations;
  recorded_response jsonb;
begin
  if stool_probability is null or stool_probability < 0 or stool_probability > 1 then
    raise exception 'Invalid probability';
  end if;

  recorded_response := coalesce(stool_raw_response, '{}'::jsonb) || jsonb_build_object(
    'database_routing', jsonb_build_object(
      'review_required', true,
      'result_code', 'uncertain',
      'policy', 'experiment_all_images_require_blind_human_review_v1'
    )
  );

  insert into private.stool_model_versions (id, task, preprocessing_version)
  values (
    stool_model_version,
    'stool_presence',
    coalesce(nullif(stool_raw_response ->> 'preprocessing_version', ''), 'unconfigured')
  )
  on conflict (id) do nothing;

  insert into private.stool_inference_runs (
    observation_id, model_version_id, result_code, stool_probability,
    review_required, raw_response, latency_ms
  ) values (
    stool_observation_id, stool_model_version, 'uncertain', stool_probability,
    true, recorded_response, stool_latency_ms
  ) returning id into inference_id;

  insert into private.stool_review_queue (observation_id, inference_run_id)
  values (stool_observation_id, inference_id)
  on conflict (observation_id) do update set
    inference_run_id = excluded.inference_run_id,
    status = 'pending',
    claimed_by = null,
    claimed_at = null,
    completed_at = null;

  update public.stool_observations
  set analysis_status = 'awaiting_human_review',
      owner_visible_result = 'uncertain',
      latest_confidence = stool_probability,
      failure_code = null,
      updated_at = now()
  where id = stool_observation_id
    and analysis_status in ('queued', 'analysing')
  returning * into result;

  if result.id is null then
    raise exception 'Observation is not queued';
  end if;

  return result;
end
$$;

revoke all on function public.record_stool_inference_result(text, text, numeric, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.record_stool_inference_result(text, text, numeric, jsonb, integer)
  to service_role;

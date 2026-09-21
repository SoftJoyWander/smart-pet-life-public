import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Observation = {
  id: string;
  owner_id: string;
  pet_id: string;
  media_path: string | null;
  analysis_status: string;
  owner_visible_result: 'present' | 'absent' | 'uncertain' | 'not_assessable' | null;
  latest_confidence: number | null;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function logAnalysis(stage: string, fields: Record<string, unknown> = {}) {
  console.info(JSON.stringify({
    event: 'stool_analysis',
    stage,
    executionId: Deno.env.get('SB_EXECUTION_ID') ?? null,
    deploymentId: Deno.env.get('DENO_DEPLOYMENT_ID') ?? null,
    ...fields,
  }));
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: 'authentication_required' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const publishableKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !publishableKey || !serviceRoleKey) return json({ error: 'server_not_configured' }, 500);

  const userClient = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data: authData, error: authError } = await userClient.auth.getUser();
  if (authError || !authData.user) return json({ error: 'invalid_session' }, 401);
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const action = payload.action;
  if (action === 'reviewer-status') {
    const { data, error } = await userClient.rpc('is_stool_reviewer');
    if (error) return json({ error: 'reviewer_status_failed', detail: error.message }, 500);
    return json({ isReviewer: data === true });
  }

  if (action === 'claim-review') {
    const { data: review, error } = await userClient.rpc('claim_next_stool_review');
    if (error) return json({ error: 'reviewer_access_required', detail: error.message }, 403);
    if (!review) return json({ review: null });
    const reviewItem = review as { mediaPath: string } & Record<string, unknown>;
    const { mediaPath, ...blindReview } = reviewItem;
    const { data: signed, error: signedError } = await serviceClient.storage
      .from('stool-media').createSignedUrl(mediaPath, 300);
    if (signedError) return json({ error: 'review_media_unavailable' }, 500);
    return json({ review: { ...blindReview, signedImageUrl: signed.signedUrl } });
  }

  if (action === 'submit-review') {
    const { data, error } = await userClient.rpc('submit_stool_human_review', {
      stool_observation_id: payload.observationId,
      stool_label: payload.label,
      stool_note: payload.note ?? null,
    });
    if (error) return json({ error: 'review_submission_failed', detail: error.message }, 400);
    return json({ observation: data as Observation });
  }

  if (action === 'create') {
    const { data, error } = await userClient.rpc('create_stool_observation', {
      stool_pet_id: payload.petId,
      stool_client_request_key: payload.clientRequestKey,
      stool_captured_at: payload.capturedAt,
      stool_captured_timezone: payload.capturedTimezone,
      stool_capture_method: payload.captureMethod ?? 'live_camera',
    });
    if (error) {
      const permissionDenied = /permission|not allowed|editor|owner/i.test(error.message);
      return json({ error: permissionDenied ? 'submission_not_allowed' : 'create_failed' }, permissionDenied ? 403 : 400);
    }
    const observation = data as Observation;
    logAnalysis('observation_created', { observationId: observation.id });
    return json({ observation, mediaPath: `${observation.owner_id}/${observation.pet_id}/${observation.id}/analysis.jpg` });
  }

  if (action !== 'analyze' || typeof payload.observationId !== 'string') {
    return json({ error: 'invalid_action' }, 400);
  }

  const { data: begun, error: beginError } = await userClient.rpc('begin_stool_observation_analysis', {
    stool_observation_id: payload.observationId,
  });
  if (beginError) return json({ error: 'analysis_not_allowed', detail: beginError.message }, 400);
  const observation = begun as Observation;
  if (!observation.media_path) return json({ error: 'media_missing' }, 409);

  const startedAt = Date.now();
  logAnalysis('analysis_started', { observationId: observation.id });
  try {
    const { data: image, error: downloadError } = await serviceClient.storage.from('stool-media').download(observation.media_path);
    if (downloadError || !image) throw new Error('storage_download_failed');
    logAnalysis('media_downloaded', { observationId: observation.id, imageBytes: image.size });

    const inferenceUrl = Deno.env.get('STOOL_INFERENCE_URL');
    const inferenceToken = Deno.env.get('STOOL_INFERENCE_TOKEN');
    if (!inferenceUrl || !inferenceToken) throw new Error('inference_service_not_configured');

    const response = await fetch(`${inferenceUrl.replace(/\/$/, '')}/v1/stool-presence`, {
      method: 'POST',
      headers: {
        'X-Service-Token': inferenceToken,
        'X-Observation-Id': observation.id,
        'Content-Type': observation.media_path.endsWith('.png') ? 'image/png' : 'image/jpeg',
      },
      body: image,
    });
    if (!response.ok) throw new Error(`inference_http_${response.status}`);
    const inference = await response.json() as {
      stool_probability: number;
      model_version: string;
      review_required: boolean;
      candidate_code?: 'present' | 'absent' | 'uncertain';
      model_family?: string;
      input_roi_version?: string | null;
      preprocessing_version?: string;
      score_kind?: string;
      calibrated?: boolean;
      threshold_set_version?: string | null;
      score_diagnostics?: {
        max_activation?: number;
        max_logit?: number;
        activation_floor?: number;
        activation_count_above_floor?: number;
        confidence_map_shapes?: number[][];
        selected_output_names?: string[];
      };
    };
    if (!Number.isFinite(inference.stool_probability) || !inference.model_version) throw new Error('invalid_inference_contract');
    const candidateCode = inference.candidate_code ?? (
      (inference.score_diagnostics?.activation_count_above_floor ?? 0) > 0
        ? 'present' : 'absent'
    );
    const latencyMs = Date.now() - startedAt;
    logAnalysis('inference_completed', {
      observationId: observation.id,
      modelVersion: inference.model_version,
      scoreKind: inference.score_kind ?? null,
      calibrated: inference.calibrated ?? false,
      rawScore: inference.stool_probability,
      activationCountAboveFloor: inference.score_diagnostics?.activation_count_above_floor ?? null,
      latencyMs,
      reviewRequired: inference.review_required,
    });

    const { data: completed, error: recordError } = await serviceClient.rpc('record_stool_inference_result', {
      stool_observation_id: observation.id,
      stool_model_version: inference.model_version,
      stool_probability: inference.stool_probability,
      stool_raw_response: inference,
      stool_latency_ms: latencyMs,
    });
    if (recordError) throw new Error('result_record_failed');
    logAnalysis('result_recorded', { observationId: observation.id, latencyMs });
    return json({
      observation: completed as Observation,
      trace: {
        observationId: observation.id,
        modelVersion: inference.model_version,
        modelFamily: inference.model_family ?? null,
        inputRoiVersion: inference.input_roi_version ?? null,
        preprocessingVersion: inference.preprocessing_version ?? null,
        scoreKind: inference.score_kind ?? null,
        calibrated: inference.calibrated ?? false,
        candidateCode,
        rawScore: inference.stool_probability,
        maxLogit: inference.score_diagnostics?.max_logit ?? null,
        activationFloor: inference.score_diagnostics?.activation_floor ?? null,
        activationCountAboveFloor: inference.score_diagnostics?.activation_count_above_floor ?? null,
        confidenceMapShapes: inference.score_diagnostics?.confidence_map_shapes ?? null,
        selectedOutputNames: inference.score_diagnostics?.selected_output_names ?? null,
        thresholdSetVersion: inference.threshold_set_version ?? null,
        reviewRequired: inference.review_required,
        latencyMs,
        completedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    const failureCode = error instanceof Error ? error.message : 'inference_failed';
    await serviceClient.rpc('record_stool_inference_failure', {
      stool_observation_id: observation.id,
      stool_failure_code: failureCode,
    });
    console.error(JSON.stringify({
      event: 'stool_analysis',
      stage: 'analysis_failed',
      observationId: observation.id,
      failureCode,
      latencyMs: Date.now() - startedAt,
      executionId: Deno.env.get('SB_EXECUTION_ID') ?? null,
      deploymentId: Deno.env.get('DENO_DEPLOYMENT_ID') ?? null,
    }));
    return json({ error: failureCode }, 502);
  }
});

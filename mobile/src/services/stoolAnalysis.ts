import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';

import { requireSupabase } from '../lib/supabase';
import type { StoolObservationRow } from '../types/database';

const stoolMediaBucket = 'stool-media';

type CreateResponse = { observation: StoolObservationRow; mediaPath: string };

export type StoolAnalysisTrace = {
  observationId: string;
  modelVersion: string;
  modelFamily: string | null;
  inputRoiVersion: string | null;
  preprocessingVersion: string | null;
  scoreKind: string | null;
  calibrated: boolean;
  candidateCode: 'present' | 'absent' | 'uncertain';
  rawScore: number;
  maxLogit: number | null;
  activationFloor: number | null;
  activationCountAboveFloor: number | null;
  confidenceMapShapes: number[][] | null;
  selectedOutputNames: string[] | null;
  thresholdSetVersion: string | null;
  reviewRequired: boolean;
  latencyMs: number;
  completedAt: string;
};

export type StoolReviewItem = {
  queueId: string;
  observationId: string;
  signedImageUrl: string;
  capturedAt: string;
  captureMethod: StoolObservationRow['capture_method'];
};

type ReviewerStatusResponse = { isReviewer: boolean };
type ClaimReviewResponse = { review: StoolReviewItem | null };
type SubmitReviewResponse = { observation: StoolObservationRow };

type AnalyzeResponse = { observation: StoolObservationRow; trace?: StoolAnalysisTrace };

type FunctionErrorBody = {
  code?: string;
  error?: string;
  message?: string;
  detail?: string;
};

async function throwFriendlyFunctionError(error: unknown): Promise<never> {
  if (error instanceof FunctionsHttpError) {
    const response = error.context as Response;
    let body: FunctionErrorBody = {};
    try {
      body = await response.clone().json() as FunctionErrorBody;
    } catch {
      // A gateway can return a non-JSON error page. The status mapping below remains safe.
    }
    const code = body.error ?? body.code;
    console.warn('Stool analysis function error', { status: response.status, code });
    if (response.status === 404 || code === 'NOT_FOUND') {
      throw new Error('便便辨識服務尚未部署，請稍後再試。');
    }
    if (response.status === 401 || code === 'invalid_session' || code === 'authentication_required') {
      throw new Error('登入狀態已失效，請重新登入後再試。');
    }
    if (code === 'reviewer_access_required') {
      throw new Error('目前帳號沒有便便 AI 人工審核權限。');
    }
    if (code === 'review_submission_failed' || code === 'reviewer_status_failed') {
      throw new Error('人工審核服務暫時無法完成要求，請稍後再試。');
    }
    if (code === 'submission_not_allowed' || response.status === 403) {
      throw new Error('目前帳號只有查看權限；請改用飼主或可編輯的共同照護帳號送出照片。');
    }
    if (code === 'create_failed') {
      throw new Error('便便辨識資料庫尚未完成設定，請稍後再試。');
    }
    if (code === 'inference_service_not_configured') {
      throw new Error('模型服務尚未完成設定，目前無法辨識。');
    }
    if (code?.startsWith('inference_http_') || code === 'storage_download_failed') {
      throw new Error('模型服務暫時無法連線，照片未完成辨識。');
    }
    if (code === 'analysis_not_allowed') {
      throw new Error('這筆照片目前不能開始分析，請重新拍攝。');
    }
    throw new Error('便便辨識服務暫時無法完成要求，請稍後再試。');
  }
  if (error instanceof FunctionsRelayError || error instanceof FunctionsFetchError) {
    throw new Error('目前無法連線到便便辨識服務，請檢查網路後再試。');
  }
  throw error instanceof Error ? error : new Error('便便辨識發生未知錯誤。');
}

export function createStoolClientRequestKey() {
  return `stool-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export async function createStoolObservation(input: {
  petId: string;
  clientRequestKey: string;
  capturedAt: string;
  capturedTimezone: string;
  captureMethod: StoolObservationRow['capture_method'];
}) {
  const { data, error } = await requireSupabase().functions.invoke<CreateResponse>('analyze-stool-image', {
    body: { action: 'create', petId: input.petId, clientRequestKey: input.clientRequestKey,
      capturedAt: input.capturedAt, capturedTimezone: input.capturedTimezone, captureMethod: input.captureMethod },
  });
  if (error) await throwFriendlyFunctionError(error);
  if (!data?.observation || !data.mediaPath) throw new Error('後端沒有建立影像分析工作。');
  return data;
}

export async function uploadAndQueueStoolImage(input: {
  observationId: string;
  mediaPath: string;
  uri: string;
  inputRoiVersion: string;
  preprocessingVersion: string;
}) {
  const response = await fetch(input.uri);
  if (!response.ok) throw new Error('讀取拍攝照片失敗。');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 10 * 1024 * 1024) throw new Error('照片超過 10 MB，請重新拍攝。');

  const client = requireSupabase();
  const { error: uploadError } = await client.storage.from(stoolMediaBucket).upload(input.mediaPath, bytes, {
    contentType: 'image/jpeg',
    upsert: false,
    metadata: {
      input_roi_version: input.inputRoiVersion,
      preprocessing_version: input.preprocessingVersion,
      width: 768,
      height: 768,
    },
  });
  if (uploadError) {
    console.warn('Stool image upload failed', { statusCode: uploadError.statusCode, name: uploadError.name });
    if (uploadError.statusCode === '401' || uploadError.statusCode === '403') {
      throw new Error('目前帳號沒有上傳這隻寵物照片的權限。');
    }
    throw new Error('照片上傳失敗，請確認網路後重試。');
  }

  const { data, error } = await client.rpc('queue_stool_observation_analysis', {
    stool_observation_id: input.observationId,
    stool_media_path: input.mediaPath,
    stool_content_type: 'image/jpeg',
    stool_byte_size: bytes.byteLength,
  });
  if (error) {
    await client.storage.from(stoolMediaBucket).remove([input.mediaPath]);
    console.warn('Stool analysis queue failed', { code: error.code });
    if (error.code === '42501') {
      throw new Error('目前帳號只有查看權限，不能送出照片分析。');
    }
    throw new Error('照片已停止排程，請稍後重新拍攝並送出。');
  }
  return data;
}

export async function analyzeStoolObservation(observationId: string) {
  const { data, error } = await requireSupabase().functions.invoke<AnalyzeResponse>('analyze-stool-image', {
    body: { action: 'analyze', observationId },
  });
  if (error) await throwFriendlyFunctionError(error);
  if (!data?.observation) throw new Error('後端沒有回傳分析狀態。');
  return data;
}

export async function getStoolReviewerStatus() {
  const { data, error } = await requireSupabase().functions.invoke<ReviewerStatusResponse>('analyze-stool-image', {
    body: { action: 'reviewer-status' },
  });
  if (error) await throwFriendlyFunctionError(error);
  return data?.isReviewer === true;
}

export async function claimNextStoolReview() {
  const { data, error } = await requireSupabase().functions.invoke<ClaimReviewResponse>('analyze-stool-image', {
    body: { action: 'claim-review' },
  });
  if (error) await throwFriendlyFunctionError(error);
  return data?.review ?? null;
}

export async function submitStoolHumanReview(input: {
  observationId: string;
  label: 'present' | 'absent' | 'not_assessable';
  note?: string;
}) {
  const { data, error } = await requireSupabase().functions.invoke<SubmitReviewResponse>('analyze-stool-image', {
    body: {
      action: 'submit-review',
      observationId: input.observationId,
      label: input.label,
      note: input.note?.trim() || null,
    },
  });
  if (error) await throwFriendlyFunctionError(error);
  if (!data?.observation) throw new Error('後端沒有確認人工審核結果。');
  return data.observation;
}

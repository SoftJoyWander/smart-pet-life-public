import { requireSupabase } from '../lib/supabase';
import type { Database } from '../types/database';
import type { OfflineCareKind, OfflineCarePayload } from './offlineCareQueue';

type PetInsert = Database['public']['Tables']['pets']['Insert'];
type PetUpdate = Database['public']['Tables']['pets']['Update'];
type EditablePetFields = Omit<PetUpdate, 'id' | 'owner_id' | 'species' | 'birthday' | 'created_at' | 'updated_at'>;
type ProfileUpdate = Database['public']['Tables']['profiles']['Update'];
type CareRecordInsert = Database['public']['Tables']['care_records']['Insert'];
type CareRecordUpdate = Database['public']['Tables']['care_records']['Update'];
type MedicationPlanInsert = Database['public']['Tables']['medication_plans']['Insert'];
type MedicationPlanUpdate = Database['public']['Tables']['medication_plans']['Update'];
type PetMemberRole = Database['public']['Enums']['pet_member_role'];
type PreventiveCareScheduleInsert = Database['public']['Tables']['preventive_care_schedules']['Insert'];

const petMediaBucket = 'pet-media';

type NewCareRecord = Omit<CareRecordInsert, 'id' | 'occurred_at' | 'created_at' | 'updated_at'>;
type EditableCareRecordFields = Omit<
  CareRecordUpdate,
  'id' | 'owner_id' | 'pet_id' | 'occurred_at' | 'created_at' | 'updated_at'
>;

export async function getMyProfile(authUserId: string) {
  const { data, error } = await requireSupabase()
    .from('profiles')
    .select('*')
    .eq('auth_user_id', authUserId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function updateMyProfile(authUserId: string, changes: Pick<ProfileUpdate, 'display_name'>) {
  const { data, error } = await requireSupabase()
    .from('profiles')
    .update(changes)
    .eq('auth_user_id', authUserId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function listActivePets() {
  const { data, error } = await requireSupabase()
    .from('pets')
    .select('*')
    .is('archived_at', null)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data;
}

export async function listPetInvitations(petId: string) {
  const { data, error } = await requireSupabase()
    .from('pet_invitations')
    .select('*')
    .eq('pet_id', petId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data;
}

export async function createPetInvitation(input: {
  petId: string;
  ownerId: string;
  invitedBy: string;
  email: string;
  role: PetMemberRole;
}) {
  const normalizedEmail = input.email.trim().toLowerCase();
  const client = requireSupabase();
  const [{ data: existingMembership, error: membershipError }, { data: existingInvitation, error: invitationError }] = await Promise.all([
    client
      .from('pet_memberships')
      .select('id')
      .eq('pet_id', input.petId)
      .eq('owner_id', input.ownerId)
      .eq('member_email', normalizedEmail)
      .maybeSingle(),
    client
      .from('pet_invitations')
      .select('id')
      .eq('pet_id', input.petId)
      .eq('owner_id', input.ownerId)
      .eq('invited_email', normalizedEmail)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle(),
  ]);

  if (membershipError) throw membershipError;
  if (invitationError) throw invitationError;
  if (existingMembership) throw new Error('此 Email 已經是這隻狗狗的共同照護者，不需要再次邀請。');
  if (existingInvitation) throw new Error('此 Email 已經有一封待接受邀請，請使用原本的 QR code 或邀請碼。');

  const { data, error } = await client
    .from('pet_invitations')
    .insert({
      pet_id: input.petId,
      owner_id: input.ownerId,
      invited_by: input.invitedBy,
      invited_email: normalizedEmail,
      role: input.role,
    })
    .select()
    .single();

  if (error) {
    const databaseMessage = error.message ?? '';
    if (databaseMessage.includes('No registered account exists for this email')) {
      throw new Error('此 Email 尚未註冊 Smart Pet Life，邀請未送出。');
    }
    if (databaseMessage.includes('This email is already a caregiver for this pet')) {
      throw new Error('此 Email 已經是這隻狗狗的共同照護者，不需要再次邀請。');
    }
    if (databaseMessage.includes('A pending invitation already exists for this email')) {
      throw new Error('此 Email 已經有一封待接受邀請，請使用原本的 QR code 或邀請碼。');
    }
    if (databaseMessage.includes('Pet owners cannot invite themselves')) {
      throw new Error('飼主不能邀請自己成為共同照護者。');
    }
    throw error;
  }
  return data;
}

export async function revokePetInvitation(ownerId: string, invitationId: string) {
  const { error } = await requireSupabase()
    .from('pet_invitations')
    .update({ status: 'revoked' })
    .eq('id', invitationId)
    .eq('owner_id', ownerId)
    .eq('status', 'pending');

  if (error) throw error;
}

export async function listMyPendingInvitations(email: string) {
  const { data, error } = await requireSupabase()
    .from('pet_invitations')
    .select('*')
    .eq('invited_email', email.trim().toLowerCase())
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data;
}

export async function acceptPetInvitation(invitationId: string) {
  const { data, error } = await requireSupabase().rpc('accept_pet_invitation', {
    invitation_id: invitationId,
  });

  if (error) throw error;
  return data;
}

export async function acceptPetInvitationCode(joinCode: string) {
  const { data, error } = await requireSupabase().rpc('accept_pet_invitation_code', {
    join_code: joinCode.trim().toUpperCase(),
  });

  if (error) throw error;
  return data;
}

export async function listPetMemberships(ownerId: string, petId: string) {
  const { data, error } = await requireSupabase()
    .from('pet_memberships')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('pet_id', petId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data;
}

export async function removePetMembership(ownerId: string, membershipId: string) {
  const { error } = await requireSupabase()
    .from('pet_memberships')
    .delete()
    .eq('id', membershipId)
    .eq('owner_id', ownerId);

  if (error) throw error;
}

export async function createPet(pet: PetInsert) {
  const { data, error } = await requireSupabase()
    .from('pets')
    .insert(pet)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updatePet(ownerId: string, petId: string, changes: EditablePetFields) {
  const { data, error } = await requireSupabase()
    .from('pets')
    .update(changes)
    .eq('id', petId)
    .eq('owner_id', ownerId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function archivePet(ownerId: string, petId: string) {
  return updatePet(ownerId, petId, { archived_at: new Date().toISOString() });
}

function petAvatarExtension(uri: string) {
  const match = uri.match(/\.([a-zA-Z0-9]+)(?:[?#].*)?$/);
  const extension = match?.[1]?.toLowerCase();
  return extension === 'png' || extension === 'webp' || extension === 'heic' ? extension : 'jpg';
}

function petAvatarContentType(extension: string) {
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'heic') return 'image/heic';
  return 'image/jpeg';
}

export async function uploadPetAvatar(input: { ownerId: string; petId: string; uri: string }) {
  const response = await fetch(input.uri);
  if (!response.ok) throw new Error('讀取選取的照片失敗，請再試一次。');

  const extension = petAvatarExtension(input.uri);
  const path = `${input.ownerId}/${input.petId}/avatar-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${extension}`;
  const { error } = await requireSupabase()
    .storage
    .from(petMediaBucket)
    .upload(path, await response.arrayBuffer(), {
      contentType: petAvatarContentType(extension),
      upsert: false,
    });

  if (error) throw error;
  return path;
}

export async function createPetAvatarSignedUrl(path: string) {
  const { data, error } = await requireSupabase()
    .storage
    .from(petMediaBucket)
    .createSignedUrl(path, 60 * 60);

  if (error) throw error;
  return data.signedUrl;
}

export async function deletePetMedia(path: string) {
  const { error } = await requireSupabase().storage.from(petMediaBucket).remove([path]);
  if (error) throw error;
}

export async function listPreventiveCareSchedules(ownerId: string, petId: string) {
  const { data, error } = await requireSupabase()
    .from('preventive_care_schedules')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('pet_id', petId)
    .order('kind', { ascending: true });

  if (error) throw error;
  return data;
}

export async function savePreventiveCareSchedule(schedule: PreventiveCareScheduleInsert) {
  const { data, error } = await requireSupabase()
    .from('preventive_care_schedules')
    .upsert(schedule, { onConflict: 'pet_id,kind' })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function completePreventiveCare(scheduleId: string) {
  const { data, error } = await requireSupabase().rpc('complete_preventive_care', {
    schedule_id: scheduleId,
  });

  if (error) throw error;
  return data;
}

export async function listCareRecords(ownerId: string, petId: string, limit = 100) {
  const { data, error } = await requireSupabase()
    .from('care_records')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('pet_id', petId)
    .order('occurred_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}

export async function createCareRecord(record: NewCareRecord) {
  const { data, error } = await requireSupabase()
    .from('care_records')
    .insert(record)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function findCareRecordBySmartBinSession(ownerId: string, petId: string, sessionId: string) {
  const { data, error } = await requireSupabase()
    .from('care_records')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('pet_id', petId)
    .eq('kind', 'stool')
    .contains('metadata', { smart_bin_session_id: sessionId })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function updateCareRecord(
  ownerId: string,
  petId: string,
  recordId: string,
  changes: EditableCareRecordFields,
) {
  const { data, error } = await requireSupabase()
    .from('care_records')
    .update(changes)
    .eq('id', recordId)
    .eq('pet_id', petId)
    .eq('owner_id', ownerId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteCareRecord(ownerId: string, petId: string, recordId: string) {
  const { error } = await requireSupabase()
    .from('care_records')
    .delete()
    .eq('id', recordId)
    .eq('pet_id', petId)
    .eq('owner_id', ownerId);

  if (error) throw error;
}

export async function listMedicationPlans(ownerId: string, petId: string) {
  const { data, error } = await requireSupabase()
    .from('medication_plans')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('pet_id', petId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data;
}

export async function createMedicationPlan(plan: MedicationPlanInsert) {
  if (plan.dose_amount == null || !plan.dose_unit) {
    throw new Error('用藥劑量與單位不可為空。');
  }
  const { data, error } = await requireSupabase().rpc('create_medication_plan_with_reminders', {
    plan_owner_id: plan.owner_id,
    plan_pet_id: plan.pet_id,
    plan_title: plan.title,
    plan_dose: plan.dose,
    plan_dose_amount: plan.dose_amount,
    plan_dose_unit: plan.dose_unit,
    plan_times: plan.times,
    plan_start_date: plan.start_date,
    plan_end_date: plan.end_date,
    plan_instruction: plan.instruction,
    plan_note: plan.note,
    plan_timezone: plan.timezone ?? 'Asia/Taipei',
    plan_request_key: plan.client_request_key,
  });
  if (error) throw error;
  return data;
}

export async function syncOfflineCareRecord(input: {
  petId: string;
  clientRequestKey: string;
  occurredAt: string;
  timezone: string;
  kind: OfflineCareKind;
  payload: OfflineCarePayload;
}) {
  const { data, error } = await requireSupabase().rpc('sync_offline_care_record', {
    offline_pet_id: input.petId,
    offline_client_request_key: input.clientRequestKey,
    offline_occurred_at: input.occurredAt,
    offline_timezone: input.timezone,
    offline_kind: input.kind,
    offline_title: input.payload.title,
    offline_note: input.payload.note,
    offline_amount: input.payload.amount,
    offline_unit: input.payload.unit,
    offline_food_type: input.payload.food_type,
    offline_stool_texture: input.payload.stool_texture,
    offline_stool_color: input.payload.stool_color,
    offline_stool_status: input.payload.stool_status,
    offline_urine_color: input.payload.urine_color,
    offline_metadata: input.payload.metadata,
  });

  if (error) throw error;
  return data;
}

export async function listWalkSessions(petId: string, limit = 30) {
  const { data, error } = await requireSupabase()
    .from('walk_sessions')
    .select('*')
    .eq('pet_id', petId)
    .order('started_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}

export type BeginWalkSessionResult = {
  acquired: boolean;
  reason?: 'active_by_other' | 'already_completed';
  lease_token?: string;
  expires_at?: string;
  holder_name?: string;
  active_since?: string;
  walk_session_id?: string;
};

export type HeartbeatWalkSessionResult = {
  renewed: boolean;
  reason?: 'lease_lost';
  expires_at?: string;
};

export async function beginWalkSession(petId: string, clientRequestKey: string) {
  const { data, error } = await requireSupabase().rpc('begin_walk_session', {
    walk_pet_id: petId,
    walk_client_request_key: clientRequestKey,
  });

  if (error) throw error;
  return data as BeginWalkSessionResult;
}

export async function heartbeatWalkSession(petId: string, clientRequestKey: string, leaseToken: string) {
  const { data, error } = await requireSupabase().rpc('heartbeat_walk_session', {
    walk_pet_id: petId,
    walk_client_request_key: clientRequestKey,
    walk_lease_token: leaseToken,
  });

  if (error) throw error;
  return data as HeartbeatWalkSessionResult;
}

export async function abandonWalkSession(petId: string, clientRequestKey: string, leaseToken: string) {
  const { error } = await requireSupabase().rpc('abandon_walk_session', {
    walk_pet_id: petId,
    walk_client_request_key: clientRequestKey,
    walk_lease_token: leaseToken,
  });

  if (error) throw error;
}

export async function completeWalkSession(input: {
  petId: string;
  clientRequestKey: string;
  leaseToken: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  distanceM: number;
  weightKgSnapshot?: number | null;
  energyKcalLow?: number | null;
  energyKcalHigh?: number | null;
  energyModelVersion?: string | null;
  stoolTimes: string[];
  urineTimes: string[];
}) {
  const { data, error } = await requireSupabase().rpc('complete_walk_session', {
    walk_pet_id: input.petId,
    walk_client_request_key: input.clientRequestKey,
    walk_lease_token: input.leaseToken,
    walk_started_at: input.startedAt,
    walk_ended_at: input.endedAt,
    walk_duration_seconds: input.durationSeconds,
    walk_distance_m: input.distanceM,
    walk_weight_kg_snapshot: input.weightKgSnapshot ?? null,
    walk_energy_kcal_low: input.energyKcalLow ?? null,
    walk_energy_kcal_high: input.energyKcalHigh ?? null,
    walk_energy_model_version: input.energyModelVersion ?? null,
    walk_stool_times: input.stoolTimes,
    walk_urine_times: input.urineTimes,
  });

  if (error) throw error;
  return data;
}

export async function deleteWalkSession(walkSessionId: string) {
  const { error } = await requireSupabase()
    .from('walk_sessions')
    .delete()
    .eq('id', walkSessionId);

  if (error) throw error;
}

export async function updateMedicationPlan(
  ownerId: string,
  petId: string,
  planId: string,
  changes: MedicationPlanUpdate,
) {
  const { data, error } = await requireSupabase()
    .from('medication_plans')
    .update(changes)
    .eq('id', planId)
    .eq('pet_id', petId)
    .eq('owner_id', ownerId)
    .select()
    .single();

  if (error) throw error;
  const { error: reminderError } = await requireSupabase().rpc('sync_medication_plan_reminders', {
    target_plan_id: data.id,
  });
  if (reminderError) throw reminderError;
  return data;
}

export async function refreshMedicationReminders(petId: string) {
  const { data, error } = await requireSupabase().rpc('refresh_medication_reminders', {
    target_pet_id: petId,
  });
  if (!error) return data;

  // 僅查看的共同照護者不能更新逾時狀態，但仍應能載入提醒。
  const { data: readableRows, error: readError } = await requireSupabase()
    .from('medication_reminders')
    .select('*')
    .eq('pet_id', petId)
    // The pre-migration enum does not contain `overdue`; `pending` exists in both schemas.
    .eq('status', 'pending')
    .order('scheduled_at', { ascending: true });
  if (readError) throw readError;
  return readableRows;
}

export async function completeStoredMedicationReminder(reminderId: string, administeredAt?: string) {
  const { data, error } = await requireSupabase().rpc('complete_medication_reminder', {
    reminder_id: reminderId,
    ...(administeredAt ? { actual_administered_at: administeredAt } : {}),
  });
  if (error) throw error;
  return data;
}

export async function resolveMissedMedicationReminder(reminderId: string, wasAdministered: boolean, administeredAt?: string) {
  const { data, error } = await requireSupabase().rpc('resolve_missed_medication_reminder', {
    reminder_id: reminderId,
    was_administered: wasAdministered,
    ...(administeredAt ? { actual_administered_at: administeredAt } : {}),
  });
  if (error) throw error;
  return data;
}

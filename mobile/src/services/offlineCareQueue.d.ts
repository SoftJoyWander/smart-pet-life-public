import type { CareRecordKind, CareRecordRow, Json, PetRow } from '../types/database';

export type OfflineSyncMode = 'auto' | 'wifi' | 'manual';
export type OfflineCareStatus = 'pending' | 'syncing' | 'failed';
export type OfflineCareKind = Extract<CareRecordKind, 'meal' | 'water' | 'stool' | 'urine'>;

export type OfflineCarePayload = {
  title: string;
  note: string | null;
  amount: number | null;
  unit: string | null;
  food_type: CareRecordRow['food_type'];
  stool_texture: CareRecordRow['stool_texture'];
  stool_color: CareRecordRow['stool_color'];
  stool_status: CareRecordRow['stool_status'];
  urine_color: CareRecordRow['urine_color'];
  metadata: Json;
};

export type OfflineCareQueueRow = {
  local_id: string;
  auth_user_id: string;
  profile_id: string;
  owner_id: string;
  pet_id: string;
  pet_name: string;
  client_request_key: string;
  occurred_at: string;
  timezone: string;
  kind: OfflineCareKind;
  payload_json: string;
  status: OfflineCareStatus;
  retry_count: number;
  last_error_code: string | null;
  last_error_message: string | null;
  created_local_at: string;
  updated_local_at: string;
};

export type OfflineQueueSummary = { pending: number; syncing: number; failed: number };
export type OfflineAccountContext = { profileId: string; displayName: string; pets: PetRow[]; selectedPetId: string | null };

export function deviceTimezone(): string;
export function enqueueOfflineCareRecord(input: { authUserId: string; profileId: string; ownerId: string; petId: string; petName: string; kind: OfflineCareKind; payload: OfflineCarePayload; occurredAt?: string }): Promise<OfflineCareQueueRow>;
export function listOfflineCareRecords(authUserId: string): Promise<OfflineCareQueueRow[]>;
export function getOfflineQueueSummary(authUserId: string): Promise<OfflineQueueSummary>;
export function getOfflineSyncMode(authUserId: string): Promise<OfflineSyncMode>;
export function setOfflineSyncMode(authUserId: string, mode: OfflineSyncMode): Promise<void>;
export function hasSeenOfflineDisclosure(authUserId: string): Promise<boolean>;
export function acknowledgeOfflineDisclosure(authUserId: string): Promise<void>;
export function cacheOfflineAccountContext(authUserId: string, context: OfflineAccountContext): Promise<void>;
export function loadOfflineAccountContext(authUserId: string): Promise<OfflineAccountContext | null>;
export function syncOfflineCareQueue(authUserId: string, profileId: string): Promise<CareRecordRow[]>;

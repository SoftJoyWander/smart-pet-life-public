import AsyncStorage from '@react-native-async-storage/async-storage';

import type { CareRecordKind, CareRecordRow, Json, PetRow } from '../types/database';
import { syncOfflineCareRecord } from './petData';

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

const queueKey = '@smart-pet-life/offline-care-outbox:v1';
const settingsKey = '@smart-pet-life/offline-sync-settings:v1';
const accountCacheKey = '@smart-pet-life/offline-account-cache:v1';
let mutation = Promise.resolve();
let activeSync: { authUserId: string; promise: Promise<CareRecordRow[]> } | null = null;

async function readJson<T>(key: string, fallback: T): Promise<T> {
  const stored = await AsyncStorage.getItem(key);
  if (!stored) return fallback;
  try { return JSON.parse(stored) as T; } catch { return fallback; }
}

function mutate<T>(operation: () => Promise<T>) {
  const result = mutation.then(operation, operation);
  mutation = result.then(() => undefined, () => undefined);
  return result;
}

async function readQueue() {
  await mutation;
  return readJson<OfflineCareQueueRow[]>(queueKey, []);
}

function createLocalId() {
  const random = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return `offline-${Date.now().toString(36)}-${random()}${random()}`;
}

export function deviceTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC';
}

export async function enqueueOfflineCareRecord(input: {
  authUserId: string;
  profileId: string;
  ownerId: string;
  petId: string;
  petName: string;
  kind: OfflineCareKind;
  payload: OfflineCarePayload;
  occurredAt?: string;
}) {
  const localId = createLocalId();
  const now = new Date().toISOString();
  const row: OfflineCareQueueRow = {
    local_id: localId,
    auth_user_id: input.authUserId,
    profile_id: input.profileId,
    owner_id: input.ownerId,
    pet_id: input.petId,
    pet_name: input.petName,
    client_request_key: `${input.authUserId}:${localId}`,
    occurred_at: input.occurredAt ?? now,
    timezone: deviceTimezone(),
    kind: input.kind,
    payload_json: JSON.stringify(input.payload),
    status: 'pending',
    retry_count: 0,
    last_error_code: null,
    last_error_message: null,
    created_local_at: now,
    updated_local_at: now,
  };
  await mutate(async () => {
    const rows = await readJson<OfflineCareQueueRow[]>(queueKey, []);
    await AsyncStorage.setItem(queueKey, JSON.stringify([...rows, row]));
  });
  return row;
}

export async function listOfflineCareRecords(authUserId: string) {
  return (await readQueue())
    .filter((row) => row.auth_user_id === authUserId)
    .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));
}

export async function getOfflineQueueSummary(authUserId: string): Promise<OfflineQueueSummary> {
  const summary: OfflineQueueSummary = { pending: 0, syncing: 0, failed: 0 };
  (await listOfflineCareRecords(authUserId)).forEach((row) => { summary[row.status] += 1; });
  return summary;
}

type StoredSetting = { syncMode: OfflineSyncMode; disclosureSeen: boolean };
export async function getOfflineSyncMode(authUserId: string) {
  const settings = await readJson<Record<string, StoredSetting>>(settingsKey, {});
  return settings[authUserId]?.syncMode ?? 'auto';
}

export async function setOfflineSyncMode(authUserId: string, mode: OfflineSyncMode) {
  await mutate(async () => {
    const settings = await readJson<Record<string, StoredSetting>>(settingsKey, {});
    settings[authUserId] = { syncMode: mode, disclosureSeen: true };
    await AsyncStorage.setItem(settingsKey, JSON.stringify(settings));
  });
}

export async function hasSeenOfflineDisclosure(authUserId: string) {
  const settings = await readJson<Record<string, StoredSetting>>(settingsKey, {});
  return settings[authUserId]?.disclosureSeen === true;
}

export async function acknowledgeOfflineDisclosure(authUserId: string) {
  await setOfflineSyncMode(authUserId, await getOfflineSyncMode(authUserId));
}

export async function cacheOfflineAccountContext(authUserId: string, context: OfflineAccountContext) {
  await mutate(async () => {
    const cache = await readJson<Record<string, OfflineAccountContext>>(accountCacheKey, {});
    cache[authUserId] = context;
    await AsyncStorage.setItem(accountCacheKey, JSON.stringify(cache));
  });
}

export async function loadOfflineAccountContext(authUserId: string) {
  const cache = await readJson<Record<string, OfflineAccountContext>>(accountCacheKey, {});
  return cache[authUserId] ?? null;
}

function safeError(error: unknown) {
  const code = typeof error === 'object' && error && 'code' in error
    ? String((error as { code?: unknown }).code ?? 'sync_error')
    : 'sync_error';
  const message = typeof error === 'object' && error && 'message' in error
    ? String((error as { message?: unknown }).message ?? '同步失敗')
    : error instanceof Error ? error.message : '同步失敗';
  return { code: code.slice(0, 80), message: message.slice(0, 500) };
}

async function updateRow(localId: string, authUserId: string, update: (row: OfflineCareQueueRow) => OfflineCareQueueRow | null) {
  await mutate(async () => {
    const rows = await readJson<OfflineCareQueueRow[]>(queueKey, []);
    const nextRows = rows.flatMap((row) => {
      if (row.local_id !== localId || row.auth_user_id !== authUserId) return [row];
      const next = update(row);
      return next ? [next] : [];
    });
    await AsyncStorage.setItem(queueKey, JSON.stringify(nextRows));
  });
}

export async function syncOfflineCareQueue(authUserId: string, profileId: string) {
  if (activeSync?.authUserId === authUserId) return activeSync.promise;
  if (activeSync) return [];
  const promise = (async () => {
    const rows = (await listOfflineCareRecords(authUserId)).filter((row) => row.status !== 'syncing');
    const synced: CareRecordRow[] = [];
    for (const row of rows) {
      if (row.profile_id !== profileId) continue;
      await updateRow(row.local_id, authUserId, (current) => ({ ...current, status: 'syncing', updated_local_at: new Date().toISOString() }));
      try {
        const payload = JSON.parse(row.payload_json) as OfflineCarePayload;
        const record = await syncOfflineCareRecord({ petId: row.pet_id, clientRequestKey: row.client_request_key, occurredAt: row.occurred_at, timezone: row.timezone, kind: row.kind, payload });
        if (record.client_request_key !== row.client_request_key || record.recorded_by !== profileId) {
          throw new Error('伺服器回覆與本機待同步記錄不一致，已保留本機資料。');
        }
        await updateRow(row.local_id, authUserId, () => null);
        synced.push(record);
      } catch (error) {
        const failure = safeError(error);
        await updateRow(row.local_id, authUserId, (current) => ({
          ...current,
          status: 'failed',
          retry_count: current.retry_count + 1,
          last_error_code: failure.code,
          last_error_message: failure.message,
          updated_local_at: new Date().toISOString(),
        }));
      }
    }
    return synced;
  })().finally(() => { activeSync = null; });
  activeSync = { authUserId, promise };
  return promise;
}

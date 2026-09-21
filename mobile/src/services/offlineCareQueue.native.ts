import * as SQLite from 'expo-sqlite';

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

export type OfflineQueueSummary = {
  pending: number;
  syncing: number;
  failed: number;
};

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
let activeSync: { authUserId: string; promise: Promise<CareRecordRow[]> } | null = null;

function database() {
  if (!databasePromise) {
    databasePromise = SQLite.openDatabaseAsync('smart-pet-life-offline.db').then(async (db) => {
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS offline_care_outbox (
          local_id TEXT PRIMARY KEY NOT NULL,
          auth_user_id TEXT NOT NULL,
          profile_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          pet_id TEXT NOT NULL,
          pet_name TEXT NOT NULL,
          client_request_key TEXT NOT NULL UNIQUE,
          occurred_at TEXT NOT NULL,
          timezone TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('meal', 'water', 'stool', 'urine')),
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'syncing', 'failed')),
          retry_count INTEGER NOT NULL DEFAULT 0,
          last_error_code TEXT,
          last_error_message TEXT,
          created_local_at TEXT NOT NULL,
          updated_local_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS offline_care_outbox_user_status_idx
          ON offline_care_outbox(auth_user_id, status, created_local_at);
        CREATE TABLE IF NOT EXISTS offline_sync_settings (
          auth_user_id TEXT PRIMARY KEY NOT NULL,
          sync_mode TEXT NOT NULL DEFAULT 'auto' CHECK (sync_mode IN ('auto', 'wifi', 'manual')),
          disclosure_seen INTEGER NOT NULL DEFAULT 0 CHECK (disclosure_seen IN (0, 1)),
          updated_local_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS offline_account_cache (
          auth_user_id TEXT PRIMARY KEY NOT NULL,
          profile_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          pets_json TEXT NOT NULL,
          selected_pet_id TEXT,
          updated_local_at TEXT NOT NULL
        );
      `);
      await db.runAsync(
        `UPDATE offline_care_outbox
         SET status = 'pending', updated_local_at = ?
         WHERE status = 'syncing'`,
        new Date().toISOString(),
      );
      return db;
    });
  }
  return databasePromise;
}

export type OfflineAccountContext = {
  profileId: string;
  displayName: string;
  pets: PetRow[];
  selectedPetId: string | null;
};

export async function cacheOfflineAccountContext(authUserId: string, context: OfflineAccountContext) {
  const db = await database();
  await db.runAsync(
    `INSERT INTO offline_account_cache (
      auth_user_id, profile_id, display_name, pets_json, selected_pet_id, updated_local_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(auth_user_id) DO UPDATE SET
      profile_id = excluded.profile_id,
      display_name = excluded.display_name,
      pets_json = excluded.pets_json,
      selected_pet_id = excluded.selected_pet_id,
      updated_local_at = excluded.updated_local_at`,
    authUserId,
    context.profileId,
    context.displayName,
    JSON.stringify(context.pets),
    context.selectedPetId,
    new Date().toISOString(),
  );
}

export async function loadOfflineAccountContext(authUserId: string): Promise<OfflineAccountContext | null> {
  const db = await database();
  const row = await db.getFirstAsync<{
    profile_id: string;
    display_name: string;
    pets_json: string;
    selected_pet_id: string | null;
  }>('SELECT profile_id, display_name, pets_json, selected_pet_id FROM offline_account_cache WHERE auth_user_id = ?', authUserId);
  if (!row) return null;
  try {
    const pets = JSON.parse(row.pets_json) as PetRow[];
    if (!Array.isArray(pets)) return null;
    return {
      profileId: row.profile_id,
      displayName: row.display_name,
      pets,
      selectedPetId: row.selected_pet_id,
    };
  } catch {
    return null;
  }
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
  const db = await database();
  const localId = createLocalId();
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const now = new Date().toISOString();
  const clientRequestKey = `${input.authUserId}:${localId}`;
  await db.runAsync(
    `INSERT INTO offline_care_outbox (
      local_id, auth_user_id, profile_id, owner_id, pet_id, pet_name,
      client_request_key, occurred_at, timezone, kind, payload_json,
      status, retry_count, created_local_at, updated_local_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    localId,
    input.authUserId,
    input.profileId,
    input.ownerId,
    input.petId,
    input.petName,
    clientRequestKey,
    occurredAt,
    deviceTimezone(),
    input.kind,
    JSON.stringify(input.payload),
    now,
    now,
  );
  return (await db.getFirstAsync<OfflineCareQueueRow>(
    'SELECT * FROM offline_care_outbox WHERE local_id = ?',
    localId,
  ))!;
}

export async function listOfflineCareRecords(authUserId: string) {
  const db = await database();
  return db.getAllAsync<OfflineCareQueueRow>(
    `SELECT * FROM offline_care_outbox
     WHERE auth_user_id = ?
     ORDER BY occurred_at DESC`,
    authUserId,
  );
}

export async function getOfflineQueueSummary(authUserId: string): Promise<OfflineQueueSummary> {
  const db = await database();
  const rows = await db.getAllAsync<{ status: OfflineCareStatus; count: number }>(
    `SELECT status, COUNT(*) AS count
     FROM offline_care_outbox
     WHERE auth_user_id = ?
     GROUP BY status`,
    authUserId,
  );
  const summary: OfflineQueueSummary = { pending: 0, syncing: 0, failed: 0 };
  rows.forEach((row) => { summary[row.status] = Number(row.count); });
  return summary;
}

export async function getOfflineSyncMode(authUserId: string): Promise<OfflineSyncMode> {
  const db = await database();
  const row = await db.getFirstAsync<{ sync_mode: OfflineSyncMode }>(
    'SELECT sync_mode FROM offline_sync_settings WHERE auth_user_id = ?',
    authUserId,
  );
  return row?.sync_mode ?? 'auto';
}

export async function setOfflineSyncMode(authUserId: string, mode: OfflineSyncMode) {
  const db = await database();
  await db.runAsync(
    `INSERT INTO offline_sync_settings (auth_user_id, sync_mode, disclosure_seen, updated_local_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(auth_user_id) DO UPDATE SET
       sync_mode = excluded.sync_mode,
       disclosure_seen = 1,
       updated_local_at = excluded.updated_local_at`,
    authUserId,
    mode,
    new Date().toISOString(),
  );
}

export async function hasSeenOfflineDisclosure(authUserId: string) {
  const db = await database();
  const row = await db.getFirstAsync<{ disclosure_seen: number }>(
    'SELECT disclosure_seen FROM offline_sync_settings WHERE auth_user_id = ?',
    authUserId,
  );
  return row?.disclosure_seen === 1;
}

export async function acknowledgeOfflineDisclosure(authUserId: string) {
  const mode = await getOfflineSyncMode(authUserId);
  await setOfflineSyncMode(authUserId, mode);
}

function safeError(error: unknown) {
  if (typeof error === 'object' && error && 'code' in error) {
    return {
      code: String((error as { code?: unknown }).code ?? 'sync_error').slice(0, 80),
      message: String((error as { message?: unknown }).message ?? '同步失敗').slice(0, 500),
    };
  }
  return {
    code: 'sync_error',
    message: (error instanceof Error ? error.message : '同步失敗').slice(0, 500),
  };
}

export async function syncOfflineCareQueue(authUserId: string, profileId: string) {
  if (activeSync?.authUserId === authUserId) return activeSync.promise;
  if (activeSync) return [];
  const promise = (async () => {
    const db = await database();
    const rows = await db.getAllAsync<OfflineCareQueueRow>(
      `SELECT * FROM offline_care_outbox
       WHERE auth_user_id = ? AND status IN ('pending', 'failed')
       ORDER BY created_local_at ASC`,
      authUserId,
    );
    const synced: CareRecordRow[] = [];

    for (const row of rows) {
      if (row.profile_id !== profileId) continue;
      await db.runAsync(
        `UPDATE offline_care_outbox
         SET status = 'syncing', updated_local_at = ?
         WHERE local_id = ? AND auth_user_id = ?`,
        new Date().toISOString(),
        row.local_id,
        authUserId,
      );
      try {
        const payload = JSON.parse(row.payload_json) as OfflineCarePayload;
        const record = await syncOfflineCareRecord({
          petId: row.pet_id,
          clientRequestKey: row.client_request_key,
          occurredAt: row.occurred_at,
          timezone: row.timezone,
          kind: row.kind,
          payload,
        });
        if (record.client_request_key !== row.client_request_key || record.recorded_by !== profileId) {
          throw new Error('伺服器回覆與本機待同步記錄不一致，已保留本機資料。');
        }
        await db.runAsync(
          'DELETE FROM offline_care_outbox WHERE local_id = ? AND auth_user_id = ?',
          row.local_id,
          authUserId,
        );
        synced.push(record);
      } catch (error) {
        const failure = safeError(error);
        await db.runAsync(
          `UPDATE offline_care_outbox
           SET status = 'failed', retry_count = retry_count + 1,
               last_error_code = ?, last_error_message = ?, updated_local_at = ?
           WHERE local_id = ? AND auth_user_id = ?`,
          failure.code,
          failure.message,
          new Date().toISOString(),
          row.local_id,
          authUserId,
        );
      }
    }
    return synced;
  })().finally(() => { activeSync = null; });
  activeSync = { authUserId, promise };
  return promise;
}

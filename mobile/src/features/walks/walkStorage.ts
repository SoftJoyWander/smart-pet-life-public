import AsyncStorage from '@react-native-async-storage/async-storage';

import type { ActiveWalk, WalkCoordinate } from './types';
import { appendCoordinateToSegments } from './walkMath';

const activeWalkKey = 'smart-pet-life:active-walk:v1';

export async function loadActiveWalk() {
  const stored = await AsyncStorage.getItem(activeWalkKey);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as Omit<Partial<ActiveWalk>, 'schemaVersion'> & {
      schemaVersion?: number;
      coordinates?: WalkCoordinate[];
    };
    const coordinateSegments = Array.isArray(parsed.coordinateSegments)
      ? parsed.coordinateSegments.filter(Array.isArray)
      : Array.isArray(parsed.coordinates)
        ? [parsed.coordinates]
        : null;
    if ((parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3)
      || !parsed.petId
      || !parsed.petName
      || !Number.isFinite(parsed.startedAt)
      || !coordinateSegments) return null;
    const lastCoordinate = coordinateSegments.flat().at(-1);
    delete parsed.coordinates;
    return {
      ...parsed,
      schemaVersion: 3,
      clientRequestKey: parsed.clientRequestKey ?? `walk:${parsed.petId}:${parsed.startedAt}`,
      leaseToken: parsed.leaseToken ?? null,
      leaseExpiresAt: Number.isFinite(parsed.leaseExpiresAt) ? parsed.leaseExpiresAt as number : null,
      lastHeartbeatAt: Number.isFinite(parsed.lastHeartbeatAt)
        ? parsed.lastHeartbeatAt as number
        : lastCoordinate?.timestamp ?? parsed.startedAt as number,
      pausedAt: Number.isFinite(parsed.pausedAt) ? parsed.pausedAt as number : null,
      totalPausedMs: Number.isFinite(parsed.totalPausedMs) ? parsed.totalPausedMs as number : 0,
      coordinateSegments,
      events: Array.isArray(parsed.events) ? parsed.events : [],
    } as ActiveWalk;
  } catch {
    return null;
  }
}

export async function saveActiveWalk(walk: ActiveWalk) {
  await AsyncStorage.setItem(activeWalkKey, JSON.stringify(walk));
}

export async function appendStoredWalkCoordinates(points: WalkCoordinate[]) {
  const walk = await loadActiveWalk();
  if (!walk || walk.pausedAt != null) return;
  const coordinateSegments = points.reduce(appendCoordinateToSegments, walk.coordinateSegments);
  const lastHeartbeatAt = points.reduce((latest, point) => Math.max(latest, point.timestamp), walk.lastHeartbeatAt);
  if (coordinateSegments === walk.coordinateSegments && lastHeartbeatAt === walk.lastHeartbeatAt) return;
  await saveActiveWalk({ ...walk, coordinateSegments, lastHeartbeatAt });
}

export async function clearActiveWalk() {
  await AsyncStorage.removeItem(activeWalkKey);
}

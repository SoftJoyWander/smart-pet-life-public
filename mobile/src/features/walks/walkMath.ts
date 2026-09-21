import type { ActiveWalk, WalkCoordinate, WalkEnergyEstimate } from './types';

const earthRadiusM = 6_371_000;

function toRadians(value: number) {
  return value * Math.PI / 180;
}

export function coordinateDistanceM(left: WalkCoordinate, right: WalkCoordinate) {
  const latitudeDelta = toRadians(right.latitude - left.latitude);
  const longitudeDelta = toRadians(right.longitude - left.longitude);
  const leftLatitude = toRadians(left.latitude);
  const rightLatitude = toRadians(right.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusM * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function appendCoordinate(points: WalkCoordinate[], next: WalkCoordinate) {
  if (!Number.isFinite(next.latitude) || !Number.isFinite(next.longitude)) return points;
  if (next.accuracy != null && next.accuracy > 65) return points;
  const previous = points.at(-1);
  if (!previous) return [next];
  if (next.timestamp <= previous.timestamp) return points;

  const distanceM = coordinateDistanceM(previous, next);
  const seconds = (next.timestamp - previous.timestamp) / 1000;
  if (distanceM < 2) return points;
  if (distanceM > 30 && seconds > 0 && distanceM / seconds > 12) return points;
  return [...points, next];
}

export function appendCoordinateToSegments(segments: WalkCoordinate[][], next: WalkCoordinate) {
  const currentSegment = segments.at(-1) ?? [];
  const nextSegment = appendCoordinate(currentSegment, next);
  if (nextSegment === currentSegment) return segments;
  if (segments.length === 0) return [nextSegment];
  return [...segments.slice(0, -1), nextSegment];
}

export function startCoordinateSegment(segments: WalkCoordinate[][]) {
  if (segments.length === 0 || segments.at(-1)?.length === 0) return segments;
  return [...segments, []];
}

export function routeDistanceM(segments: WalkCoordinate[][]) {
  return segments.reduce((routeTotal, points) => (
    routeTotal + points.reduce((segmentTotal, point, index) => (
      index === 0 ? segmentTotal : segmentTotal + coordinateDistanceM(points[index - 1], point)
    ), 0)
  ), 0);
}

export function activeDurationMs(input: {
  startedAt: number;
  pausedAt: number | null;
  totalPausedMs: number;
}, now = Date.now()) {
  const currentPauseMs = input.pausedAt == null ? 0 : Math.max(0, now - input.pausedAt);
  return Math.max(0, now - input.startedAt - input.totalPausedMs - currentPauseMs);
}

export function recoverWalkAfterColdStart(walk: ActiveWalk, recoveryTime = Date.now()): ActiveWalk {
  if (walk.pausedAt != null) return walk;
  const trackedUntil = Math.min(
    recoveryTime,
    Math.max(walk.startedAt, walk.lastHeartbeatAt) + 5000,
  );
  return {
    ...walk,
    lastHeartbeatAt: trackedUntil,
    pausedAt: recoveryTime,
    totalPausedMs: walk.totalPausedMs + Math.max(0, recoveryTime - trackedUntil),
  };
}

export function estimateWalkEnergy(weightKg: number | null, distanceM: number): WalkEnergyEstimate | null {
  if (!weightKg || weightKg <= 0 || distanceM <= 0) return null;
  const distanceKm = distanceM / 1000;
  return {
    low: weightKg * distanceKm * 0.72,
    high: weightKg * distanceKm,
    modelVersion: 'distance_weight_v1',
  };
}

export function formatWalkDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

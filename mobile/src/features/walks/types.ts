export type WalkCoordinate = {
  latitude: number;
  longitude: number;
  timestamp: number;
  accuracy: number | null;
};

export type WalkEvent = {
  id: string;
  kind: 'stool' | 'urine';
  occurredAt: number;
  photoUri?: string;
};

export type ActiveWalk = {
  schemaVersion: 3;
  petId: string;
  petName: string;
  clientRequestKey: string;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  startedAt: number;
  lastHeartbeatAt: number;
  pausedAt: number | null;
  totalPausedMs: number;
  coordinateSegments: WalkCoordinate[][];
  events: WalkEvent[];
};

export type WalkEnergyEstimate = {
  low: number;
  high: number;
  modelVersion: 'distance_weight_v1';
};

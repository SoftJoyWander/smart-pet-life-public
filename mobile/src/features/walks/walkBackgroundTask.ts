import * as Location from 'expo-location';
import { Platform } from 'react-native';
import * as TaskManager from 'expo-task-manager';

import { appendStoredWalkCoordinates } from './walkStorage';

export const walkLocationTaskName = 'smart-pet-life-walk-location-v1';

if (Platform.OS !== 'web' && !TaskManager.isTaskDefined(walkLocationTaskName)) {
  TaskManager.defineTask<{ locations: Location.LocationObject[] }>(walkLocationTaskName, async ({ data, error }) => {
    if (error || !data?.locations?.length) return;
    await appendStoredWalkCoordinates(data.locations.map((location) => ({
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      timestamp: location.timestamp,
      accuracy: location.coords.accuracy,
    })));
  });
}

export async function startWalkBackgroundUpdates() {
  if (Platform.OS === 'web') return false;
  const taskManagerAvailable = await TaskManager.isAvailableAsync().catch(() => false);
  const backgroundLocationAvailable = await Location.isBackgroundLocationAvailableAsync().catch(() => false);
  if (!taskManagerAvailable || !backgroundLocationAvailable) return false;
  const backgroundPermission = await Location.requestBackgroundPermissionsAsync();
  if (backgroundPermission.status !== 'granted') return false;
  const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(walkLocationTaskName);
  if (!alreadyStarted) {
    await Location.startLocationUpdatesAsync(walkLocationTaskName, {
      accuracy: Location.Accuracy.High,
      activityType: Location.ActivityType.Fitness,
      distanceInterval: 5,
      timeInterval: 5000,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'Smart Pet Life 正在記錄遛狗',
        notificationBody: '定位只用於本次路線，完成後不會上傳原始座標。',
        killServiceOnDestroy: false,
      },
    });
  }
  return true;
}

export async function stopWalkBackgroundUpdates() {
  if (Platform.OS === 'web') return;
  try {
    if (!(await TaskManager.isAvailableAsync())) return;
    if (await Location.hasStartedLocationUpdatesAsync(walkLocationTaskName)) {
      await Location.stopLocationUpdatesAsync(walkLocationTaskName);
    }
  } catch {
    // Expo Go and an interrupted native background service can report an
    // unavailable task. Stopping tracking must remain safe and idempotent.
  }
}

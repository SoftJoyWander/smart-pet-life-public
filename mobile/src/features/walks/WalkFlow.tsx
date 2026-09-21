import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import ViewShot, { captureRef } from 'react-native-view-shot';

import {
  abandonWalkSession,
  beginWalkSession,
  completeWalkSession,
  heartbeatWalkSession,
  type BeginWalkSessionResult,
} from '../../services/petData';
import type { PetRow, WalkSessionRow } from '../../types/database';
import { layoutTokens } from '../../lib/layout';
import { WalkMap, type WalkMapHandle } from './WalkMap';
import { startWalkBackgroundUpdates, stopWalkBackgroundUpdates } from './walkBackgroundTask';
import { activeDurationMs, appendCoordinateToSegments, coordinateDistanceM, estimateWalkEnergy, formatWalkDuration, recoverWalkAfterColdStart, routeDistanceM, startCoordinateSegment } from './walkMath';
import { clearActiveWalk, loadActiveWalk, saveActiveWalk } from './walkStorage';
import type { ActiveWalk, WalkCoordinate, WalkEvent } from './types';

type WalkFlowProps = {
  pet: PetRow;
  isPreview: boolean;
  onClose: () => void;
  onSaved: () => void;
};

type TrackingPrompt = 'end' | 'close-with-events' | 'discard' | null;
type WalkStartStage = 'idle' | 'permission' | 'location' | 'server' | 'saving';

const walkStartStageLabel: Record<WalkStartStage, string> = {
  idle: '開始遛狗',
  permission: '檢查定位權限…',
  location: '正在取得位置…',
  server: '正在確認共養狀態…',
  saving: '正在開啟遛狗…',
};

class InitialLocationTimeoutError extends Error {}

function trimRouteStart(segments: WalkCoordinate[][], distanceM: number) {
  const trimmed: WalkCoordinate[][] = [];
  let remainingM = distanceM;
  for (const segment of segments) {
    if (segment.length === 0) continue;
    let startIndex = 0;
    while (remainingM > 0 && startIndex < segment.length - 1) {
      remainingM -= coordinateDistanceM(segment[startIndex], segment[startIndex + 1]);
      startIndex += 1;
    }
    if (remainingM > 0) continue;
    trimmed.push(segment.slice(startIndex));
  }
  return trimmed;
}

function privacySafeRoute(segments: WalkCoordinate[][]) {
  if (routeDistanceM(segments) < 200) return [];
  const withoutStart = trimRouteStart(segments, 100);
  const reversed = withoutStart.slice().reverse().map((segment) => segment.slice().reverse());
  return trimRouteStart(reversed, 100)
    .reverse()
    .map((segment) => segment.reverse())
    .filter((segment) => segment.length > 1);
}

function locationToCoordinate(location: Location.LocationObject): WalkCoordinate {
  return {
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    timestamp: location.timestamp,
    accuracy: location.coords.accuracy,
  };
}

async function getInitialWalkLocation() {
  const lastKnown = await Location.getLastKnownPositionAsync({
    maxAge: 30_000,
    requiredAccuracy: 100,
  }).catch(() => null);
  if (lastKnown) return lastKnown;

  return new Promise<Location.LocationObject>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new InitialLocationTimeoutError()), 12_000);
    void Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).then(
      (location) => {
        clearTimeout(timeout);
        resolve(location);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function activeWalkerMessage(petName: string, result: BeginWalkSessionResult) {
  const walker = result.holder_name?.trim() || '另一位共養者';
  const since = result.active_since
    ? new Date(result.active_since).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
    : null;
  return `${walker} ${since ? `從 ${since} 開始` : '目前正在'}遛 ${petName}，結束或連線逾時後才能開始。`;
}

export function WalkFlow({ pet, isPreview, onClose, onSaved }: WalkFlowProps) {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const [walk, setWalk] = useState<ActiveWalk | null>(null);
  const [phase, setPhase] = useState<'ready' | 'tracking' | 'completed'>('ready');
  const [now, setNow] = useState(Date.now());
  const [isStarting, setIsStarting] = useState(false);
  const [startStage, setStartStage] = useState<WalkStartStage>('idle');
  const [isSaving, setIsSaving] = useState(false);
  const [isTogglingPause, setIsTogglingPause] = useState(false);
  const [backgroundEnabled, setBackgroundEnabled] = useState(false);
  const [pendingEventKind, setPendingEventKind] = useState<WalkEvent['kind'] | null>(null);
  const [trackingPrompt, setTrackingPrompt] = useState<TrackingPrompt>(null);
  const [startError, setStartError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [showPoopCamera, setShowPoopCamera] = useState(false);
  const [savedSession, setSavedSession] = useState<WalkSessionRow | null>(null);
  const [shareMapUri, setShareMapUri] = useState<string | null>(null);
  const mapRef = useRef<WalkMapHandle>(null);
  const shareMapRef = useRef<WalkMapHandle>(null);
  const shareCardRef = useRef<ViewShot>(null);
  const backgroundOperationId = useRef(0);
  const leaseExpiryRef = useRef<number | null>(null);

  useEffect(() => {
    leaseExpiryRef.current = walk?.leaseExpiresAt ?? null;
  }, [walk?.leaseExpiresAt]);

  useEffect(() => {
    let mounted = true;
    void loadActiveWalk().then((stored) => {
      if (!mounted || !stored || stored.petId !== pet.id) return;
      if (Date.now() - stored.startedAt > 24 * 60 * 60 * 1000) {
        void clearActiveWalk();
        return;
      }
      if (stored.pausedAt == null) {
        const recoveryTime = Date.now();
        const recovered = recoverWalkAfterColdStart(stored, recoveryTime);
        setWalk(recovered);
        void saveActiveWalk(recovered);
        void stopWalkBackgroundUpdates();
        setSaveError('上次未完成的遛狗已自動暫停，時間不會繼續累加；確認狀態後可手動繼續。');
      } else {
        setWalk(stored);
      }
      setPhase('tracking');
    });
    return () => { mounted = false; };
  }, [pet.id]);

  useEffect(() => {
    if (phase !== 'tracking') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'tracking' || !walk || walk.pausedAt != null) return undefined;
    const heartbeat = setInterval(() => {
      setWalk((current) => {
        if (!current || current.pausedAt != null) return current;
        const next = { ...current, lastHeartbeatAt: Date.now() };
        void saveActiveWalk(next);
        return next;
      });
    }, 3000);
    return () => clearInterval(heartbeat);
  }, [phase, walk?.pausedAt]);

  useEffect(() => {
    if (phase !== 'tracking' || isPreview || !walk?.leaseToken) return undefined;
    let cancelled = false;
    let renewing = false;

    const loseLease = (message: string) => {
      if (cancelled) return;
      backgroundOperationId.current += 1;
      setBackgroundEnabled(false);
      void stopWalkBackgroundUpdates();
      setSaveError(message);
      setWalk((current) => {
        if (!current) return current;
        const lostAt = Date.now();
        const next = {
          ...current,
          pausedAt: current.pausedAt ?? lostAt,
          lastHeartbeatAt: lostAt,
          leaseToken: null,
          leaseExpiresAt: null,
        };
        void saveActiveWalk(next);
        return next;
      });
    };

    const renew = async () => {
      if (renewing || cancelled) return;
      renewing = true;
      try {
        const result = await heartbeatWalkSession(pet.id, walk.clientRequestKey, walk.leaseToken!);
        if (!result.renewed || !result.expires_at) {
          loseLease('這次遛狗的使用權已失效，為避免共養者同時遛同一隻寵物，系統已自動暫停。請按「繼續」重新取得使用權。');
          return;
        }
        const leaseExpiresAt = new Date(result.expires_at).getTime();
        leaseExpiryRef.current = leaseExpiresAt;
        setWalk((current) => {
          if (!current || current.leaseToken !== walk.leaseToken) return current;
          const next = { ...current, leaseExpiresAt };
          void saveActiveWalk(next);
          return next;
        });
      } catch {
        if ((leaseExpiryRef.current ?? 0) <= Date.now()) {
          loseLease('與伺服器連線中斷，為避免共養者同時遛同一隻寵物，系統已自動暫停。恢復連線後按「繼續」。');
        }
      } finally {
        renewing = false;
      }
    };

    void renew();
    const heartbeat = setInterval(() => void renew(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(heartbeat);
    };
  }, [isPreview, pet.id, phase, walk?.clientRequestKey, walk?.leaseToken]);

  useEffect(() => {
    if (phase !== 'tracking') return undefined;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void loadActiveWalk().then((stored) => {
        if (stored?.petId !== pet.id) return;
        setWalk((current) => {
          if (!current) return stored;
          if (current.pausedAt != null && stored.pausedAt == null) return current;
          return stored.lastHeartbeatAt >= current.lastHeartbeatAt ? stored : current;
        });
      });
    });
    return () => subscription.remove();
  }, [pet.id, phase]);

  useEffect(() => {
    if (phase !== 'tracking' || !walk) return undefined;
    if (backgroundEnabled) {
      const poller = setInterval(() => {
        void loadActiveWalk().then((stored) => {
          if (stored?.petId !== pet.id || stored.pausedAt != null) return;
          setWalk((current) => {
            if (!current || current.pausedAt != null) return current;
            return stored.lastHeartbeatAt >= current.lastHeartbeatAt ? stored : current;
          });
        });
      }, 2000);
      return () => clearInterval(poller);
    }
    let subscription: Location.LocationSubscription | null = null;
    let cancelled = false;
    const removeSubscription = (activeSubscription: Location.LocationSubscription | null) => {
      if (!activeSubscription) return;
      try {
        activeSubscription.remove();
      } catch {
        // Some Expo Go/native location implementations can invalidate the
        // subscription before React runs the cleanup. Cleanup must never take
        // down the walk screen.
      }
    };
    void Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.High,
        distanceInterval: 3,
        timeInterval: 3000,
      },
      (location) => {
        if (cancelled) return;
        setWalk((current) => {
          if (!current || current.pausedAt != null) return current;
          const coordinateSegments = appendCoordinateToSegments(current.coordinateSegments, locationToCoordinate(location));
          const next = { ...current, coordinateSegments, lastHeartbeatAt: location.timestamp };
          void saveActiveWalk(next);
          return next;
        });
      },
    ).then((created) => {
      if (cancelled) {
        removeSubscription(created);
        return;
      }
      subscription = created;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      removeSubscription(subscription);
      subscription = null;
    };
  }, [backgroundEnabled, pet.id, phase]);

  const durationSeconds = walk ? Math.max(0, Math.floor(activeDurationMs(walk, now) / 1000)) : 0;
  const distanceM = useMemo(() => routeDistanceM(walk?.coordinateSegments ?? []), [walk?.coordinateSegments]);
  const speedMps = durationSeconds > 0 ? distanceM / durationSeconds : 0;
  const weightKg = pet.weight_kg == null ? null : Number(pet.weight_kg);
  const energy = estimateWalkEnergy(weightKg, distanceM);
  const stoolEvents = walk?.events.filter((event) => event.kind === 'stool') ?? [];
  const urineEvents = walk?.events.filter((event) => event.kind === 'urine') ?? [];
  const safeShareSegments = useMemo(() => privacySafeRoute(walk?.coordinateSegments ?? []), [walk?.coordinateSegments]);

  const start = async () => {
    setIsStarting(true);
    setStartStage('permission');
    setStartError('');
    let acquiredLease: { clientRequestKey: string; leaseToken: string } | null = null;
    try {
      const foreground = await Location.requestForegroundPermissionsAsync();
      if (foreground.status !== 'granted') {
        setStartError('遛狗記錄需要定位才能計算路程與繪製路線。你可以稍後到系統設定開啟。');
        return;
      }

      setStartStage('location');
      const location = await getInitialWalkLocation();
      const startedAt = Date.now();
      const clientRequestKey = `walk:${pet.id}:${startedAt}:${Math.random().toString(36).slice(2, 10)}`;
      let leaseToken: string | null = null;
      let leaseExpiresAt: number | null = null;
      if (!isPreview) {
        setStartStage('server');
        const lease = await beginWalkSession(pet.id, clientRequestKey);
        if (!lease.acquired || !lease.lease_token || !lease.expires_at) {
          setStartError(
            lease.reason === 'active_by_other'
              ? activeWalkerMessage(pet.name, lease)
              : '目前無法開始這次遛狗，請稍後再試。',
          );
          return;
        }
        leaseToken = lease.lease_token;
        leaseExpiresAt = new Date(lease.expires_at).getTime();
        acquiredLease = { clientRequestKey, leaseToken };
      }

      setStartStage('saving');
      const nextWalk: ActiveWalk = {
        schemaVersion: 3,
        petId: pet.id,
        petName: pet.name,
        clientRequestKey,
        leaseToken,
        leaseExpiresAt,
        startedAt,
        lastHeartbeatAt: startedAt,
        pausedAt: null,
        totalPausedMs: 0,
        coordinateSegments: [[locationToCoordinate(location)]],
        events: [],
      };
      await saveActiveWalk(nextWalk);
      setWalk(nextWalk);
      setBackgroundEnabled(false);
      setPhase('tracking');
      acquiredLease = null;

      const operationId = ++backgroundOperationId.current;
      void startWalkBackgroundUpdates().then((enabled) => {
        if (backgroundOperationId.current !== operationId) {
          if (enabled) void stopWalkBackgroundUpdates();
          return;
        }
        setBackgroundEnabled(enabled);
        if (!enabled && Platform.OS !== 'web') {
          setSaveError('目前會在 App 開啟期間持續定位；鎖定螢幕或切換 App 後可能暫停。iPhone 完整背景定位需使用 Development Build 並允許「永遠」定位。');
        }
      }).catch(() => {
        if (backgroundOperationId.current === operationId) {
          setBackgroundEnabled(false);
          setSaveError('背景定位未開啟；請保持 App 在前景，路程仍會繼續記錄。');
        }
      });
    } catch (error) {
      if (acquiredLease) {
        void abandonWalkSession(pet.id, acquiredLease.clientRequestKey, acquiredLease.leaseToken).catch(() => undefined);
      }
      setStartError(
        error instanceof InitialLocationTimeoutError
          ? '尚未取得定位。請移到戶外或靠近窗邊後重試；這次沒有開始計時。'
          : '無法開始遛狗，請確認定位與網路狀態後再試一次。',
      );
    } finally {
      setIsStarting(false);
      setStartStage('idle');
    }
  };

  const pause = async () => {
    if (!walk || walk.pausedAt != null || isTogglingPause || isSaving) return;
    setIsTogglingPause(true);
    setSaveError('');
    const pausedAt = Date.now();
    const next = { ...walk, pausedAt, lastHeartbeatAt: pausedAt };
    setWalk(next);
    const operationId = ++backgroundOperationId.current;
    try {
      await saveActiveWalk(next);
    } catch {
      setSaveError('計時已暫停，但暫停狀態尚未寫入手機；請先不要關閉 App。');
    } finally {
      setIsTogglingPause(false);
    }
    void stopWalkBackgroundUpdates().catch(() => {
      if (backgroundOperationId.current === operationId) {
        setSaveError('計時已暫停，但背景定位未正常停止；可直接結束並儲存。');
      }
    });
  };

  const resume = async () => {
    if (!walk?.pausedAt || isTogglingPause || isSaving) return;
    setIsTogglingPause(true);
    setSaveError('');
    let leaseToken = walk.leaseToken;
    let leaseExpiresAt = walk.leaseExpiresAt;
    if (!isPreview) {
      try {
        const lease = await beginWalkSession(pet.id, walk.clientRequestKey);
        if (!lease.acquired || !lease.lease_token || !lease.expires_at) {
          setSaveError(
            lease.reason === 'active_by_other'
              ? activeWalkerMessage(pet.name, lease)
              : '目前無法繼續這次遛狗，請稍後再試。',
          );
          setIsTogglingPause(false);
          return;
        }
        leaseToken = lease.lease_token;
        leaseExpiresAt = new Date(lease.expires_at).getTime();
      } catch {
        setSaveError('連不上伺服器，為避免共養者同時遛同一隻寵物，目前維持暫停。');
        setIsTogglingPause(false);
        return;
      }
    }
    const resumedAt = Date.now();
    const next = {
      ...walk,
      leaseToken,
      leaseExpiresAt,
      totalPausedMs: walk.totalPausedMs + (resumedAt - walk.pausedAt),
      lastHeartbeatAt: resumedAt,
      pausedAt: null,
      coordinateSegments: startCoordinateSegment(walk.coordinateSegments),
    };
    setWalk(next);
    const operationId = ++backgroundOperationId.current;
    try {
      await saveActiveWalk(next);
    } catch {
      setSaveError('已繼續計時，但狀態尚未寫入手機；請先保持 App 開啟。');
    } finally {
      setIsTogglingPause(false);
    }
    void startWalkBackgroundUpdates().then((enabled) => {
      if (backgroundOperationId.current !== operationId) {
        if (enabled) void stopWalkBackgroundUpdates();
        return;
      }
      setBackgroundEnabled(enabled);
      if (!enabled && Platform.OS !== 'web') {
        setSaveError('已繼續計時；目前只能在 App 開啟時記錄定位。');
      }
    }).catch(() => {
      if (backgroundOperationId.current === operationId) {
        setBackgroundEnabled(false);
        setSaveError('已繼續計時；目前只能在 App 開啟時記錄定位。');
      }
    });
  };

  const addEvent = useCallback((kind: WalkEvent['kind'], photoUri?: string) => {
    setWalk((current) => {
      if (!current || current.pausedAt != null) return current;
      const event: WalkEvent = {
        id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        kind,
        occurredAt: Date.now(),
        ...(photoUri ? { photoUri } : {}),
      };
      const next = { ...current, events: [...current.events, event] };
      void saveActiveWalk(next);
      return next;
    });
  }, []);

  const finish = async () => {
    if (isSaving) return;
    if (isTogglingPause) {
      setSaveError('暫停狀態仍在寫入，請稍候一秒後再按「結束」。');
      return;
    }
    if (!walk || durationSeconds < 5) {
      setSaveError('至少記錄 5 秒後才能完成這次遛狗。');
      return;
    }
    setTrackingPrompt(null);
    setSaveError('');
    setIsSaving(true);
    setBackgroundEnabled(false);
    backgroundOperationId.current += 1;
    void stopWalkBackgroundUpdates();
    try {
      let walkForSave = walk;
      if (!isPreview && !walkForSave.leaseToken) {
        const lease = await beginWalkSession(pet.id, walkForSave.clientRequestKey);
        if (!lease.acquired || !lease.lease_token || !lease.expires_at) {
          throw new Error(
            lease.reason === 'active_by_other'
              ? activeWalkerMessage(pet.name, lease)
              : '無法重新取得這次遛狗的使用權。',
          );
        }
        walkForSave = {
          ...walkForSave,
          leaseToken: lease.lease_token,
          leaseExpiresAt: new Date(lease.expires_at).getTime(),
        };
        setWalk(walkForSave);
        await saveActiveWalk(walkForSave);
      }
      const endedAt = Date.now();
      const finalDurationSeconds = Math.max(1, Math.floor(activeDurationMs(walkForSave, endedAt) / 1000));
      const finalDistanceM = routeDistanceM(walkForSave.coordinateSegments);
      const finalEnergy = estimateWalkEnergy(weightKg, finalDistanceM);
      const fallbackSession: WalkSessionRow = {
        id: `preview-walk-${endedAt}`,
        owner_id: pet.owner_id,
        pet_id: pet.id,
        recorded_by: pet.owner_id,
        client_request_key: walkForSave.clientRequestKey,
        started_at: new Date(walkForSave.startedAt).toISOString(),
        ended_at: new Date(endedAt).toISOString(),
        duration_seconds: finalDurationSeconds,
        distance_m: finalDistanceM,
        average_speed_mps: finalDistanceM / finalDurationSeconds,
        weight_kg_snapshot: weightKg,
        energy_kcal_low: finalEnergy?.low ?? null,
        energy_kcal_high: finalEnergy?.high ?? null,
        energy_model_version: finalEnergy?.modelVersion ?? null,
        stool_count: stoolEvents.length,
        urine_count: urineEvents.length,
        created_at: new Date().toISOString(),
      };
      const stored = isPreview
        ? fallbackSession
        : await completeWalkSession({
            petId: pet.id,
            clientRequestKey: walkForSave.clientRequestKey,
            leaseToken: walkForSave.leaseToken!,
            startedAt: fallbackSession.started_at,
            endedAt: fallbackSession.ended_at,
            durationSeconds: finalDurationSeconds,
            distanceM: finalDistanceM,
            weightKgSnapshot: weightKg,
            energyKcalLow: finalEnergy?.low ?? null,
            energyKcalHigh: finalEnergy?.high ?? null,
            energyModelVersion: finalEnergy?.modelVersion ?? null,
            stoolTimes: stoolEvents.map((event) => new Date(event.occurredAt).toISOString()),
            urineTimes: urineEvents.map((event) => new Date(event.occurredAt).toISOString()),
          });
      setSavedSession(stored);
      setNow(endedAt);
      setPhase('completed');
      onSaved();
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
          ? error.message
          : '';
      const schemaUnavailable = /complete_walk_session|walk_sessions|schema cache|PGRST202|could not find the function/i.test(message);
      setSaveError(
        schemaUnavailable
          ? '尚未儲存：Supabase 尚未啟用遛狗資料表或完成 RPC。這次路線仍保留在手機，完成資料庫部署後可再試。'
          : `尚未儲存：${message || '目前無法連線。這次路線仍保留在手機，可以稍後再試一次。'}`,
      );
    } finally {
      setIsSaving(false);
    }
  };

  const requestClose = () => {
    if (phase === 'completed') {
      void clearActiveWalk();
      onClose();
      return;
    }
    if (phase === 'ready') {
      onClose();
      return;
    }
    if ((walk?.events.length ?? 0) > 0) {
      setTrackingPrompt('close-with-events');
      return;
    }
    setTrackingPrompt('discard');
  };

  const discardWalk = () => {
    setTrackingPrompt(null);
    backgroundOperationId.current += 1;
    void stopWalkBackgroundUpdates();
    if (!isPreview && walk?.leaseToken) {
      void abandonWalkSession(pet.id, walk.clientRequestKey, walk.leaseToken).catch(() => undefined);
    }
    void clearActiveWalk();
    onClose();
  };

  const share = async () => {
    try {
      const mapUri = await shareMapRef.current?.captureSnapshot();
      if (mapUri) setShareMapUri(mapUri);
      await new Promise((resolve) => setTimeout(resolve, mapUri ? 350 : 80));
      const imageUri = await captureRef(shareCardRef, { format: 'png', quality: 1, result: 'tmpfile' });
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('這台裝置不支援系統分享', '完成卡已顯示在畫面上，你仍可直接使用系統截圖。');
        return;
      }
      await Sharing.shareAsync(imageUri, { mimeType: 'image/png', dialogTitle: `分享 ${pet.name} 的遛狗記錄` });
    } catch {
      Alert.alert('無法產生分享圖片', '你仍可直接使用系統截圖保存這張完成卡。');
    }
  };

  if (phase === 'ready') {
    return (
      <SafeAreaView style={styles.page} edges={['top', 'bottom', 'left', 'right']}>
        <View style={styles.readyHeader}>
          <TouchableOpacity accessibilityLabel="關閉遛狗" style={styles.iconButton} onPress={onClose}><Text style={styles.iconButtonText}>‹</Text></TouchableOpacity>
          <Text style={styles.headerTitle}>遛狗</Text>
          <View style={styles.headerSpacer} />
        </View>
        <ScrollView contentContainerStyle={styles.readyContent} showsVerticalScrollIndicator={false}>
          <View style={styles.heroCard}>
            <Text style={styles.heroEyebrow}>和 {pet.name} 一起出發</Text>
            <Text style={styles.heroTitle}>記下真正有用的散步資料</Text>
            <Text style={styles.heroText}>路程、時間、平均速度與途中排泄會保留；原始 GPS 座標只暫存在手機，完成後不會上傳。</Text>
            <View style={styles.heroDog}><Text style={styles.heroDogText}>{pet.avatar_icon || '🐕'}</Text></View>
          </View>
          <View style={styles.readyInfoCard}>
            <ReadyRow icon="⌖" title="即時路線" text="走動時顯示地圖與路線，完成後可截圖或分享。" />
            <ReadyRow icon="◷" title="重要摘要" text="保存時間、路程、平均速度與約略熱量。" />
            <ReadyRow icon="💩" title="生活聯動" text="途中便便、尿尿會自動進入生活紀錄。" />
          </View>
          <View style={styles.estimateNotice}>
            <Text style={styles.estimateNoticeTitle}>熱量是約略值</Text>
            <Text style={styles.estimateNoticeText}>{weightKg ? `依 ${weightKg} kg 體重快照與路程估算，` : '目前沒有體重資料，因此不顯示熱量。'}不作為餵食或醫療建議。</Text>
          </View>
        </ScrollView>
        <View style={[styles.readyFooter, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          {startError ? (
            <View accessibilityRole="alert" style={styles.readyErrorCard}>
              <Text style={styles.saveErrorText}>{startError}</Text>
            </View>
          ) : null}
          <TouchableOpacity disabled={isStarting} style={[styles.startButton, isStarting && styles.disabledButton]} onPress={() => void start()}>
            <Text style={styles.startButtonText}>{walkStartStageLabel[startStage]}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (phase === 'completed' && walk && savedSession) {
    const displayedEnergy = savedSession.energy_kcal_low != null && savedSession.energy_kcal_high != null
      ? `${Math.round(savedSession.energy_kcal_low)}–${Math.round(savedSession.energy_kcal_high)}`
      : '--';
    return (
      <SafeAreaView style={styles.completedPage} edges={['top', 'bottom', 'left', 'right']}>
        <View style={styles.readyHeader}>
          <TouchableOpacity accessibilityLabel="返回首頁" style={styles.iconButton} onPress={requestClose}><Text style={styles.iconButtonText}>×</Text></TouchableOpacity>
          <Text style={styles.headerTitle}>完成遛狗</Text>
          <View style={styles.headerSpacer} />
        </View>
        <ScrollView contentContainerStyle={styles.completedScroll} showsVerticalScrollIndicator={false}>
          <ViewShot ref={shareCardRef} style={styles.shareCard} options={{ format: 'png', quality: 1 }}>
            <View style={styles.shareHeading}>
              <View>
                <Text style={styles.shareOverline}>SMART PET LIFE・遛狗完成</Text>
                <Text style={styles.shareTitle}>{pet.name} 今天走得很好</Text>
                <Text style={styles.shareDate}>{new Date(savedSession.started_at).toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric' })}</Text>
              </View>
              <Text style={styles.sharePet}>{pet.avatar_icon || '🐕'}</Text>
            </View>
            <View style={styles.shareMapWrap}>
              {shareMapUri ? <Image source={{ uri: shareMapUri }} style={styles.shareMap} /> : <WalkMap ref={shareMapRef} segments={safeShareSegments} style={styles.shareMap} />}
              <View style={styles.privacyPill}><Text style={styles.privacyPillText}>起終點約 100 m 已隱去</Text></View>
            </View>
            <View style={styles.primaryStats}>
              <ShareStat value={(Number(savedSession.distance_m) / 1000).toFixed(2)} unit="km" label="路程" />
              <View style={styles.shareDivider} />
              <ShareStat value={formatWalkDuration(savedSession.duration_seconds)} unit="" label="運動時間" />
              <View style={styles.shareDivider} />
              <ShareStat value={(Number(savedSession.average_speed_mps) * 3.6).toFixed(1)} unit="km/h" label="平均速度" />
            </View>
            <View style={styles.secondaryStats}>
              <Text style={styles.secondaryStat}>約 {displayedEnergy} kcal</Text>
              <Text style={styles.secondaryDot}>•</Text>
              <Text style={styles.secondaryStat}>便便 {savedSession.stool_count}</Text>
              <Text style={styles.secondaryDot}>•</Text>
              <Text style={styles.secondaryStat}>尿尿 {savedSession.urine_count}</Text>
            </View>
            <Text style={styles.shareFootnote}>熱量為系統約略估算，不作為餵食或醫療建議。原始路線未上傳。</Text>
          </ViewShot>
          <TouchableOpacity style={styles.shareButton} onPress={() => void share()}><Text style={styles.shareButtonText}>分享完成圖片</Text></TouchableOpacity>
          <TouchableOpacity style={styles.finishButton} onPress={requestClose}><Text style={styles.finishButtonText}>完成</Text></TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (!walk) return null;

  return (
    <SafeAreaView style={styles.trackingPage} edges={['top', 'bottom', 'left', 'right']}>
      <View style={[styles.trackingMapWrap, { minHeight: Math.max(180, window.height * 0.34) }]}>
        <WalkMap ref={mapRef} segments={walk.coordinateSegments} showUserLocation style={StyleSheet.absoluteFillObject} />
        <View style={styles.trackingHeader}>
          <TouchableOpacity accessibilityLabel="離開遛狗" style={styles.mapCloseButton} onPress={requestClose}><Text style={styles.mapCloseText}>×</Text></TouchableOpacity>
          <View style={styles.livePill}><Text style={styles.liveDot}>{walk.pausedAt ? 'Ⅱ' : '●'}</Text><Text style={styles.liveText}>{walk.pausedAt ? '已暫停' : '遛狗中'}</Text></View>
          <View style={styles.mapCloseButton}><Text style={styles.gpsText}>{backgroundEnabled ? 'GPS+' : 'GPS'}</Text></View>
        </View>
      </View>
      <View style={[styles.trackingSheet, { paddingBottom: Math.max(insets.bottom, 14) }]}>
        <Text style={styles.trackingPet}>{pet.name}・{formatWalkDuration(durationSeconds)}</Text>
        <View style={styles.trackingStats}>
          <TrackingStat value={(distanceM / 1000).toFixed(2)} label="公里" />
          <TrackingStat value={(speedMps * 3.6).toFixed(1)} label="平均 km/h" />
          <TrackingStat value={energy ? `${Math.round(energy.low)}–${Math.round(energy.high)}` : '--'} label="約 kcal" />
        </View>
        <View style={styles.eventRow}>
          <TouchableOpacity disabled={walk.pausedAt != null} style={[styles.eventButton, walk.pausedAt != null && styles.disabledButton]} onPress={() => setPendingEventKind('stool')}>
            <Text style={styles.eventEmoji}>💩</Text><Text style={styles.eventLabel}>便便</Text><Text style={styles.eventCount}>{stoolEvents.length}</Text>
          </TouchableOpacity>
          <TouchableOpacity disabled={walk.pausedAt != null} style={[styles.eventButton, walk.pausedAt != null && styles.disabledButton]} onPress={() => setPendingEventKind('urine')}>
            <Text style={styles.eventEmoji}>🟡</Text><Text style={styles.eventLabel}>尿尿</Text><Text style={styles.eventCount}>{urineEvents.length}</Text>
          </TouchableOpacity>
        </View>
        {saveError ? (
          <View accessibilityRole="alert" style={styles.saveErrorCard}>
            <Text style={styles.saveErrorText}>{saveError}</Text>
          </View>
        ) : null}
        <View style={styles.controlRow}>
          <TouchableOpacity disabled={isTogglingPause || isSaving} style={[styles.pauseButton, (isTogglingPause || isSaving) && styles.disabledButton]} onPress={() => void (walk.pausedAt ? resume() : pause())}><Text style={styles.pauseButtonText}>{isTogglingPause ? '處理中…' : walk.pausedAt ? '繼續' : '暫停'}</Text></TouchableOpacity>
          <TouchableOpacity disabled={isSaving} style={[styles.endButton, isSaving && styles.disabledButton]} onPress={() => setTrackingPrompt('end')}>
            <Text style={styles.endButtonText}>{isSaving ? '儲存中…' : '結束'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      <Modal transparent visible={trackingPrompt !== null} animationType="fade" onRequestClose={() => setTrackingPrompt(null)}>
        <View style={styles.modalBackdrop}>
          <View accessibilityViewIsModal style={[styles.confirmSheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={[styles.confirmIcon, trackingPrompt === 'discard' && styles.confirmDangerIcon]}>
              <Text style={styles.confirmIconText}>{trackingPrompt === 'discard' ? '×' : '✓'}</Text>
            </View>
            <Text style={styles.confirmTitle}>
              {trackingPrompt === 'discard'
                ? '放棄這次遛狗？'
                : trackingPrompt === 'close-with-events'
                  ? '途中已有生活紀錄'
                  : '結束並儲存這次遛狗？'}
            </Text>
            <Text style={styles.confirmText}>
              {trackingPrompt === 'discard'
                ? '未完成的時間與路線將從手機清除，且無法復原。'
                : trackingPrompt === 'close-with-events'
                  ? '便便／尿尿需要和本次遛狗一起儲存，避免生活紀錄遺失。'
                  : '完成後會顯示路程、時間、速度與路線分享圖。'}
            </Text>
            {trackingPrompt !== 'discard' ? (
              <View style={styles.confirmSummary}>
                <Text style={styles.confirmSummaryText}>{formatWalkDuration(durationSeconds)}</Text>
                <Text style={styles.confirmSummaryDot}>•</Text>
                <Text style={styles.confirmSummaryText}>{(distanceM / 1000).toFixed(2)} 公里</Text>
              </View>
            ) : null}
            <TouchableOpacity
              style={[styles.confirmPrimaryButton, trackingPrompt === 'discard' && styles.confirmDangerButton]}
              onPress={trackingPrompt === 'discard'
                ? discardWalk
                : () => {
                    setTrackingPrompt(null);
                    void finish();
                  }}
            >
              <Text style={styles.confirmPrimaryButtonText}>{trackingPrompt === 'discard' ? '放棄並離開' : '結束並儲存'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.confirmCancelButton} onPress={() => setTrackingPrompt(null)}>
              <Text style={styles.confirmCancelButtonText}>繼續遛狗</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal transparent visible={pendingEventKind !== null} animationType="fade" onRequestClose={() => setPendingEventKind(null)}>
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={() => setPendingEventKind(null)} />
          <View style={styles.actionSheet}>
            <Text style={styles.actionSheetTitle}>記錄途中{pendingEventKind === 'stool' ? '便便' : '尿尿'}</Text>
            <Text style={styles.actionSheetText}>需要再確認一次才會計入，避免走路時誤觸。</Text>
            <TouchableOpacity style={styles.sheetAction} onPress={() => { if (pendingEventKind) addEvent(pendingEventKind); setPendingEventKind(null); }}><Text style={styles.sheetActionIcon}>✓</Text><View><Text style={styles.sheetActionTitle}>確認記錄一次{pendingEventKind === 'stool' ? '便便' : '尿尿'}</Text><Text style={styles.sheetActionText}>{pendingEventKind === 'stool' ? '之後可在生活紀錄補充質地與顏色。' : '之後可在生活紀錄補充尿液顏色。'}</Text></View></TouchableOpacity>
            {pendingEventKind === 'stool' ? <TouchableOpacity style={styles.sheetAction} onPress={() => { setPendingEventKind(null); setShowPoopCamera(true); }}><Text style={styles.sheetActionIcon}>📷</Text><View><Text style={styles.sheetActionTitle}>拍攝後記錄</Text><Text style={styles.sheetActionText}>目前保留拍攝入口，不執行或寫入模擬 AI 結果。</Text></View></TouchableOpacity> : null}
            <TouchableOpacity style={styles.sheetCancel} onPress={() => setPendingEventKind(null)}><Text style={styles.sheetCancelText}>取消</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>
      <WalkPoopCameraModal
        visible={showPoopCamera}
        onClose={() => setShowPoopCamera(false)}
        onCaptured={(uri) => {
          addEvent('stool', uri);
          setShowPoopCamera(false);
          Alert.alert('已記錄途中便便', '照片目前只保留在本次手機流程，不上傳，也不產生模擬辨識結果。');
        }}
      />
    </SafeAreaView>
  );
}

function ReadyRow({ icon, title, text }: { icon: string; title: string; text: string }) {
  return <View style={styles.readyRow}><View style={styles.readyRowIcon}><Text style={styles.readyRowIconText}>{icon}</Text></View><View style={styles.readyRowBody}><Text style={styles.readyRowTitle}>{title}</Text><Text style={styles.readyRowText}>{text}</Text></View></View>;
}

function TrackingStat({ value, label }: { value: string; label: string }) {
  return <View style={styles.trackingStat}><Text style={styles.trackingStatValue}>{value}</Text><Text style={styles.trackingStatLabel}>{label}</Text></View>;
}

function ShareStat({ value, unit, label }: { value: string; unit: string; label: string }) {
  return <View style={styles.shareStat}><View style={styles.shareValueRow}><Text style={styles.shareValue}>{value}</Text>{unit ? <Text style={styles.shareUnit}>{unit}</Text> : null}</View><Text style={styles.shareLabel}>{label}</Text></View>;
}

function WalkPoopCameraModal({ visible, onClose, onCaptured }: { visible: boolean; onClose: () => void; onCaptured: (uri: string) => void }) {
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [taking, setTaking] = useState(false);
  const [torchEnabled, setTorchEnabled] = useState(false);

  const take = async () => {
    setTaking(true);
    try {
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.7, shutterSound: false });
      if (photo?.uri) {
        setTorchEnabled(false);
        onCaptured(photo.uri);
      }
    } catch {
      Alert.alert('無法拍攝', '請確認相機權限後再試一次。');
    } finally {
      setTaking(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.cameraPage} edges={['top', 'bottom', 'left', 'right']}>
        {!permission ? <ActivityIndicator color="#FFFFFF" style={styles.cameraLoading} /> : !permission.granted ? (
          <View style={styles.cameraPermission}>
            <Text style={styles.cameraPermissionIcon}>📷</Text><Text style={styles.cameraPermissionTitle}>需要相機權限</Text><Text style={styles.cameraPermissionText}>照片只用於這次途中記錄，目前不會上傳或進行 AI 分析。</Text>
            <TouchableOpacity style={styles.cameraPermissionButton} onPress={requestPermission}><Text style={styles.cameraPermissionButtonText}>開啟相機</Text></TouchableOpacity>
            <TouchableOpacity onPress={onClose}><Text style={styles.cameraCancelText}>返回遛狗</Text></TouchableOpacity>
          </View>
        ) : (
          <>
            <CameraView ref={cameraRef} style={StyleSheet.absoluteFillObject} facing="back" enableTorch={torchEnabled} />
            <View style={styles.cameraTop}><TouchableOpacity accessibilityLabel="關閉相機" style={styles.cameraClose} onPress={onClose}><Text style={styles.cameraCloseText}>×</Text></TouchableOpacity><View><Text style={styles.cameraTitle}>拍攝途中便便</Text><Text style={styles.cameraSubtitle}>定位會繼續記錄</Text></View><TouchableOpacity accessibilityLabel={torchEnabled ? '關閉閃光燈' : '開啟閃光燈'} accessibilityRole="switch" accessibilityState={{ checked: torchEnabled }} style={[styles.cameraClose, torchEnabled && styles.cameraTorchActive]} onPress={() => setTorchEnabled((current) => !current)}><Text style={[styles.cameraTorchText, torchEnabled && styles.cameraTorchTextActive]}>⚡</Text></TouchableOpacity></View>
            <View style={styles.cameraGuide} />
            <View style={styles.cameraBottom}><Text style={styles.cameraPrivacy}>請避開人物、車牌與門牌</Text><TouchableOpacity disabled={taking} accessibilityLabel="拍攝便便" style={styles.shutter} onPress={() => void take()}><View style={styles.shutterInner}>{taking ? <ActivityIndicator color="#1E5C45" /> : null}</View></TouchableOpacity></View>
          </>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#F7F6F0' },
  readyHeader: { minHeight: 58, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#F7F6F0' },
  iconButton: { minWidth: layoutTokens.minimumTouchSize, minHeight: layoutTokens.minimumTouchSize, borderRadius: 24, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#E2E5E1' },
  iconButtonText: { color: '#183D31', fontSize: 28, lineHeight: 30 },
  headerTitle: { color: '#183D31', fontSize: 17, fontWeight: '800' },
  headerSpacer: { width: layoutTokens.minimumTouchSize },
  readyContent: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 120, gap: 14 },
  heroCard: { minHeight: 235, padding: 22, borderRadius: 28, overflow: 'hidden', backgroundColor: '#1E5C45' },
  heroEyebrow: { color: '#BDD7CB', fontSize: 13, fontWeight: '700', marginBottom: 9 },
  heroTitle: { color: '#FFFFFF', fontSize: 29, lineHeight: 36, fontWeight: '900', maxWidth: '75%' },
  heroText: { color: '#D8E8E0', fontSize: 14, lineHeight: 21, maxWidth: '78%', marginTop: 12 },
  heroDog: { position: 'absolute', right: -5, bottom: -10, width: 112, height: 112, borderRadius: 56, backgroundColor: '#F2C977', alignItems: 'center', justifyContent: 'center' },
  heroDogText: { fontSize: 55 },
  readyInfoCard: { borderRadius: 22, backgroundColor: '#FFFFFF', paddingHorizontal: 17, paddingVertical: 7, borderWidth: 1, borderColor: '#E3E6E2' },
  readyRow: { flexDirection: 'row', gap: 13, paddingVertical: 14, alignItems: 'center' },
  readyRowIcon: { width: 40, height: 40, borderRadius: 14, backgroundColor: '#E8F2ED', alignItems: 'center', justifyContent: 'center' },
  readyRowIconText: { fontSize: 19 },
  readyRowBody: { flex: 1 },
  readyRowTitle: { color: '#183D31', fontSize: 15, fontWeight: '800' },
  readyRowText: { color: '#718078', fontSize: 12.5, lineHeight: 18, marginTop: 3 },
  estimateNotice: { padding: 16, borderRadius: 18, backgroundColor: '#FFF4D8' },
  estimateNoticeTitle: { color: '#7A5820', fontSize: 13, fontWeight: '800' },
  estimateNoticeText: { color: '#806A45', fontSize: 12, lineHeight: 18, marginTop: 4 },
  readyFooter: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 16, backgroundColor: 'rgba(247,246,240,0.97)', borderTopWidth: 1, borderTopColor: '#E4E5E0' },
  readyErrorCard: { marginBottom: 10, borderRadius: 14, paddingHorizontal: 13, paddingVertical: 10, backgroundColor: '#FFF2DF', borderWidth: 1, borderColor: '#F2D2A7' },
  startButton: { minHeight: 56, borderRadius: 18, backgroundColor: '#1E5C45', alignItems: 'center', justifyContent: 'center' },
  startButtonText: { color: '#FFFFFF', fontSize: 17, fontWeight: '900' },
  disabledButton: { opacity: 0.48 },
  trackingPage: { flex: 1, backgroundColor: '#E8EFEA' },
  trackingMapWrap: { flex: 1, minHeight: 280 },
  trackingHeader: { position: 'absolute', top: 12, left: 14, right: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  mapCloseButton: { minWidth: layoutTokens.minimumTouchSize, minHeight: layoutTokens.minimumTouchSize, paddingHorizontal: 8, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.94)', alignItems: 'center', justifyContent: 'center' },
  mapCloseText: { color: '#183D31', fontSize: 26 },
  gpsText: { color: '#1E5C45', fontSize: 11, fontWeight: '900' },
  livePill: { height: 40, paddingHorizontal: 14, borderRadius: 20, backgroundColor: 'rgba(24,61,49,0.94)', flexDirection: 'row', alignItems: 'center', gap: 7 },
  liveDot: { color: '#91DFB9', fontSize: 11 },
  liveText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  trackingSheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingTop: 16, backgroundColor: '#F9F8F3' },
  trackingPet: { textAlign: 'center', color: '#183D31', fontSize: 17, fontWeight: '900' },
  trackingStats: { flexDirection: 'row', marginTop: 15, marginBottom: 14 },
  trackingStat: { flex: 1, alignItems: 'center' },
  trackingStatValue: { color: '#183D31', fontSize: 24, fontWeight: '900', fontVariant: ['tabular-nums'] },
  trackingStatLabel: { color: '#7A8781', fontSize: 11, marginTop: 3 },
  eventRow: { flexDirection: 'row', gap: 10 },
  eventButton: { flex: 1, minHeight: 52, borderRadius: 16, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E0E4E0', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 8 },
  eventEmoji: { fontSize: 20 },
  eventLabel: { flex: 1, color: '#29483D', fontSize: 14, fontWeight: '800' },
  eventCount: { minWidth: 25, height: 25, borderRadius: 13, backgroundColor: '#E7F1EC', textAlign: 'center', lineHeight: 25, color: '#1E5C45', fontSize: 12, fontWeight: '900' },
  saveErrorCard: { marginTop: 10, borderRadius: 14, paddingHorizontal: 13, paddingVertical: 10, backgroundColor: '#FFF2DF', borderWidth: 1, borderColor: '#F2D2A7' },
  saveErrorText: { color: '#80551F', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  controlRow: { flexDirection: 'row', gap: 11, marginTop: 12 },
  pauseButton: { flex: 1, minHeight: 54, borderRadius: 18, backgroundColor: '#E3EBE6', borderWidth: 1, borderColor: '#D2DED7', alignItems: 'center', justifyContent: 'center' },
  pauseButtonText: { color: '#1E5C45', fontSize: 16, fontWeight: '900' },
  endButton: { flex: 1, minHeight: 54, borderRadius: 18, backgroundColor: '#1E5C45', borderWidth: 1, borderColor: '#1E5C45', alignItems: 'center', justifyContent: 'center' },
  endButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '900' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(16,34,28,0.45)', justifyContent: 'flex-end', padding: 14 },
  confirmSheet: { width: '100%', maxWidth: layoutTokens.contentMaxWidth, alignSelf: 'center', borderRadius: 25, backgroundColor: '#FFFFFF', paddingHorizontal: 20, paddingTop: 22, paddingBottom: 16, alignItems: 'center' },
  confirmIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#E6F2EC', alignItems: 'center', justifyContent: 'center' },
  confirmDangerIcon: { backgroundColor: '#FBE9E5' },
  confirmIconText: { color: '#1E5C45', fontSize: 25, lineHeight: 28, fontWeight: '800' },
  confirmTitle: { color: '#183D31', fontSize: 20, lineHeight: 27, fontWeight: '900', textAlign: 'center', marginTop: 13 },
  confirmText: { color: '#6F7D77', fontSize: 13, lineHeight: 20, textAlign: 'center', marginTop: 7 },
  confirmSummary: { minHeight: 38, borderRadius: 14, backgroundColor: '#EEF4F0', paddingHorizontal: 16, marginTop: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  confirmSummaryText: { color: '#31584A', fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  confirmSummaryDot: { color: '#9AA9A1', fontSize: 10 },
  confirmPrimaryButton: { alignSelf: 'stretch', minHeight: 52, borderRadius: 17, backgroundColor: '#1E5C45', alignItems: 'center', justifyContent: 'center', marginTop: 18 },
  confirmDangerButton: { backgroundColor: '#B34B3E' },
  confirmPrimaryButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '900' },
  confirmCancelButton: { alignSelf: 'stretch', minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 5 },
  confirmCancelButtonText: { color: '#53645D', fontSize: 14, fontWeight: '800' },
  actionSheet: { width: '100%', maxWidth: layoutTokens.contentMaxWidth, alignSelf: 'center', borderRadius: 25, backgroundColor: '#FFFFFF', padding: 19 },
  actionSheetTitle: { color: '#183D31', fontSize: 20, fontWeight: '900' },
  actionSheetText: { color: '#77837D', fontSize: 13, marginTop: 5, marginBottom: 12 },
  sheetAction: { flexDirection: 'row', gap: 13, alignItems: 'center', paddingVertical: 13, borderTopWidth: 1, borderTopColor: '#EDF0ED' },
  sheetActionIcon: { width: 40, height: 40, borderRadius: 14, backgroundColor: '#E8F2ED', textAlign: 'center', lineHeight: 40, fontSize: 18 },
  sheetActionTitle: { color: '#24463A', fontSize: 15, fontWeight: '800' },
  sheetActionText: { color: '#7B8882', fontSize: 11.5, marginTop: 3 },
  sheetCancel: { height: 48, borderRadius: 15, backgroundColor: '#F1F2EF', alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  sheetCancelText: { color: '#53645D', fontSize: 14, fontWeight: '800' },
  completedPage: { flex: 1, backgroundColor: '#F7F6F0' },
  completedScroll: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 36 },
  shareCard: { borderRadius: 26, overflow: 'hidden', backgroundColor: '#FFFFFF', padding: 17, borderWidth: 1, borderColor: '#E2E5E1' },
  shareHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  shareOverline: { color: '#6B7E75', fontSize: 10, fontWeight: '900', letterSpacing: 0.8 },
  shareTitle: { color: '#183D31', fontSize: 22, lineHeight: 29, fontWeight: '900', marginTop: 5 },
  shareDate: { color: '#87928C', fontSize: 11.5, marginTop: 5 },
  sharePet: { fontSize: 38 },
  shareMapWrap: { width: '100%', aspectRatio: 1.45, minHeight: 180, maxHeight: 260, borderRadius: 20, overflow: 'hidden', marginTop: 12, backgroundColor: '#E8EFEA' },
  shareMap: { width: '100%', height: '100%' },
  privacyPill: { position: 'absolute', right: 9, bottom: 9, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 11, backgroundColor: 'rgba(24,61,49,0.88)' },
  privacyPillText: { color: '#FFFFFF', fontSize: 9.5, fontWeight: '800' },
  primaryStats: { flexDirection: 'row', alignItems: 'center', paddingVertical: 17 },
  shareStat: { flex: 1, alignItems: 'center' },
  shareValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 2 },
  shareValue: { color: '#183D31', fontSize: 20, fontWeight: '900', fontVariant: ['tabular-nums'] },
  shareUnit: { color: '#50655C', fontSize: 9, fontWeight: '700' },
  shareLabel: { color: '#85908B', fontSize: 10, marginTop: 3 },
  shareDivider: { width: 1, height: 30, backgroundColor: '#E2E6E3' },
  secondaryStats: { borderRadius: 14, backgroundColor: '#EEF4F0', paddingVertical: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  secondaryStat: { color: '#35564A', fontSize: 11.5, fontWeight: '800' },
  secondaryDot: { color: '#A4B2AB', fontSize: 9 },
  shareFootnote: { color: '#909A95', fontSize: 9.5, lineHeight: 14, textAlign: 'center', marginTop: 12 },
  shareButton: { height: 54, borderRadius: 17, backgroundColor: '#1E5C45', alignItems: 'center', justifyContent: 'center', marginTop: 14 },
  shareButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '900' },
  finishButton: { height: 50, alignItems: 'center', justifyContent: 'center' },
  finishButtonText: { color: '#31584A', fontSize: 14, fontWeight: '800' },
  cameraPage: { flex: 1, backgroundColor: '#101A16' },
  cameraLoading: { flex: 1 },
  cameraPermission: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  cameraPermissionIcon: { fontSize: 44 },
  cameraPermissionTitle: { color: '#FFFFFF', fontSize: 22, fontWeight: '900', marginTop: 15 },
  cameraPermissionText: { color: '#C1CDC7', fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 9 },
  cameraPermissionButton: { width: '100%', minHeight: 52, borderRadius: 17, backgroundColor: '#E9F4EE', alignItems: 'center', justifyContent: 'center', marginTop: 22 },
  cameraPermissionButtonText: { color: '#1E5C45', fontSize: 15, fontWeight: '900' },
  cameraCancelText: { color: '#D1DBD6', fontSize: 14, fontWeight: '700', marginTop: 20 },
  cameraTop: { position: 'absolute', top: 12, left: 14, right: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cameraClose: { width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(0,0,0,0.42)', alignItems: 'center', justifyContent: 'center' },
  cameraCloseText: { color: '#FFFFFF', fontSize: 27 },
  cameraTorchActive: { backgroundColor: '#FFE8A3' },
  cameraTorchText: { color: '#FFFFFF', fontSize: 20 },
  cameraTorchTextActive: { color: '#6B4D00' },
  cameraTitle: { color: '#FFFFFF', fontSize: 17, fontWeight: '900', textAlign: 'center' },
  cameraSubtitle: { color: '#D5E3DC', fontSize: 11, textAlign: 'center', marginTop: 3 },
  cameraGuide: { position: 'absolute', left: '12%', right: '12%', top: '25%', bottom: '31%', borderRadius: 24, borderWidth: 2, borderColor: 'rgba(255,255,255,0.82)' },
  cameraBottom: { position: 'absolute', left: 0, right: 0, bottom: 26, alignItems: 'center' },
  cameraPrivacy: { color: '#FFFFFF', fontSize: 12, fontWeight: '700', marginBottom: 18, backgroundColor: 'rgba(0,0,0,0.38)', paddingHorizontal: 11, paddingVertical: 6, borderRadius: 12 },
  shutter: { width: 76, height: 76, borderRadius: 38, borderWidth: 4, borderColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  shutterInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
});

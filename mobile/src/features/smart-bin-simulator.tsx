import 'expo-sqlite/localStorage/install';

import { useEffect, useState } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

export type SmartBinStage =
  | 'scan_bin'
  | 'collecting'
  | 'device_cycle'
  | 'completed';

type DeviceCyclePhase = 'idle' | 'checking_nearby' | 'unlocked' | 'hatch_open' | 'hatch_closed' | 'locked' | 'saving' | 'save_failed';

export type SmartBinSession = {
  id: string;
  actorId: string;
  petId: string;
  petName: string;
  observationId: string;
  binId: string | null;
  binName: string | null;
  stage: SmartBinStage;
  createdAt: number;
  expiresAt: number;
  depositExpiresAt: number | null;
};

type DeviceScenario = 'available' | 'invalid_qr' | 'full' | 'no_bags' | 'maintenance' | 'busy' | 'network_offline' | 'bag_jam' | 'unlock_timeout' | 'hatch_stuck' | 'lock_failed';

const SESSION_PREFIX = 'smart-pet-life:simulated-smart-bin:v1';
const TASK_WINDOW_MS = 15 * 60 * 1000;
const DEPOSIT_WINDOW_MS = 10 * 60 * 1000;

function storageKey(actorId: string, petId: string) {
  return `${SESSION_PREFIX}:${actorId}:${petId}`;
}

export function loadSmartBinSession(actorId: string, petId: string): SmartBinSession | null {
  try {
    const raw = localStorage.getItem(storageKey(actorId, petId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SmartBinSession & { stage: string };
    if (!parsed?.id || parsed.actorId !== actorId || parsed.petId !== petId || parsed.stage === 'completed') return null;
    const migratedStage: SmartBinStage = parsed.stage === 'scan_bin' ? 'scan_bin' : 'collecting';
    return { ...parsed, stage: migratedStage };
  } catch {
    return null;
  }
}

function saveSmartBinSession(session: SmartBinSession | null, actorId: string, petId: string) {
  const key = storageKey(actorId, petId);
  if (session) localStorage.setItem(key, JSON.stringify(session));
  else localStorage.removeItem(key);
}

type SmartBinSimulatorProps = {
  actorId: string;
  petId: string;
  petName: string;
  observationId: string;
  onExit: (session: SmartBinSession | null) => void;
  onFinished: (session: SmartBinSession) => Promise<void>;
  onCompleted: () => void;
};

function createSession(input: SmartBinSimulatorProps): SmartBinSession {
  const now = Date.now();
  return {
    id: `sim-deposit-${now}`,
    actorId: input.actorId,
    petId: input.petId,
    petName: input.petName,
    observationId: input.observationId,
    binId: null,
    binName: null,
    stage: 'scan_bin',
    createdAt: now,
    expiresAt: now + TASK_WINDOW_MS,
    depositExpiresAt: null,
  };
}

function formatRemaining(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

const stageCopy: Record<SmartBinStage, { title: string; detail: string; step: number }> = {
  scan_bin: { title: '前往智能垃圾桶', detail: '到設備旁掃描 QR Code；設備確認可用後會自動發出撿屎袋。', step: 1 },
  collecting: { title: '撿屎袋已發出', detail: '請撿起便便後回到同一台垃圾桶旁。', step: 2 },
  device_cycle: { title: '設備正在完成投放', detail: '請依綠燈提示投入便便；解鎖與重新上鎖會由設備自動完成。', step: 3 },
  completed: { title: '恭喜你，投遞完成！', detail: '謝謝你完成撿拾與投放，一起讓生活環境更乾淨。', step: 4 },
};

const devicePhaseCopy: Record<DeviceCyclePhase, { title: string; detail: string; light: 'off' | 'green' }> = {
  idle: { title: '等待近距離確認', detail: '回到設備旁後再繼續。', light: 'off' },
  checking_nearby: { title: '正在確認你位於設備旁', detail: 'App 正在模擬 BLE 近距離驗證。', light: 'off' },
  unlocked: { title: '投入口已解鎖・綠燈亮起', detail: '請投入已裝袋的便便，設備會自動偵測後續狀態。', light: 'green' },
  hatch_open: { title: '已偵測投入口打開', detail: '完成投放並合上投入口即可。', light: 'green' },
  hatch_closed: { title: '已偵測投入口合上', detail: '設備正在自動重新上鎖。', light: 'off' },
  locked: { title: '投入口已重新上鎖', detail: '正在準備保存本次便便紀錄。', light: 'off' },
  saving: { title: '正在保存便便紀錄', detail: '資料成功寫入後會自動顯示完成。', light: 'off' },
  save_failed: { title: '便便紀錄尚未保存', detail: '設備流程已完成，請重新保存紀錄。', light: 'off' },
};

const scenarioOptions: { value: DeviceScenario; label: string }[] = [
  { value: 'available', label: '設備正常' },
  { value: 'invalid_qr', label: '無效 QR' },
  { value: 'full', label: '垃圾桶已滿' },
  { value: 'no_bags', label: '袋子用完' },
  { value: 'maintenance', label: '維修中' },
  { value: 'busy', label: '設備使用中' },
  { value: 'network_offline', label: '網路中斷' },
  { value: 'bag_jam', label: '出袋卡住' },
  { value: 'unlock_timeout', label: '未開門逾時' },
  { value: 'hatch_stuck', label: '投入口未關閉' },
  { value: 'lock_failed', label: '未重新上鎖' },
];

const scenarioErrors: Record<DeviceScenario, string> = {
  available: '',
  invalid_qr: '無法識別這台設備。請確認 QR Code 屬於 Smart Pet Life 智能垃圾桶。',
  full: '垃圾桶已滿，這次不會發袋或解鎖。請改用附近其他設備。',
  no_bags: '設備暫時沒有撿屎袋，這次不會建立領袋狀態。',
  maintenance: '設備維修中，目前不能發袋或解鎖。',
  busy: '設備正由其他使用者操作，請稍候再試。',
  network_offline: '目前無法取得新的模擬設備授權。任務會保留，請恢復網路後重試。',
  bag_jam: '出袋感測器沒有確認袋子送出；本次不計為已領袋，請重試一次。',
  unlock_timeout: '投入口解鎖後 30 秒內沒有開門，設備已模擬重新上鎖。你可以重試一次。',
  hatch_stuck: '投入口尚未關閉。請先確認周圍安全並關門；目前不會顯示完成。',
  lock_failed: '鎖舌沒有確認重新鎖定。設備需要維護，目前不會顯示投遞完成。',
};

function scenariosForStage(stage: SmartBinStage) {
  const allowed: Partial<Record<SmartBinStage, DeviceScenario[]>> = {
    scan_bin: ['available', 'invalid_qr', 'full', 'no_bags', 'maintenance', 'busy', 'network_offline', 'bag_jam'],
    collecting: ['available', 'network_offline', 'busy', 'unlock_timeout', 'hatch_stuck', 'lock_failed'],
  };
  const values = allowed[stage] ?? ['available'];
  return scenarioOptions.filter((option) => values.includes(option.value));
}

export function SmartBinSimulator(props: SmartBinSimulatorProps) {
  const [session, setSession] = useState<SmartBinSession>(() => loadSmartBinSession(props.actorId, props.petId) ?? createSession(props));
  const [scenario, setScenario] = useState<DeviceScenario>('available');
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [isAdvancing, setIsAdvancing] = useState(false);
  const [devicePhase, setDevicePhase] = useState<DeviceCyclePhase>('idle');
  const [showDeveloperTools, setShowDeveloperTools] = useState(false);

  useEffect(() => {
    saveSmartBinSession(session.stage === 'completed' ? null : session, props.actorId, props.petId);
  }, [props.actorId, props.petId, session]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (isAdvancing) return true;
      props.onExit(session.stage === 'completed' ? null : session);
      return true;
    });
    return () => subscription.remove();
  }, [isAdvancing, props, session]);

  const deadline = session.depositExpiresAt ?? session.expiresAt;
  const expired = now >= deadline && session.stage !== 'completed';
  const copy = stageCopy[session.stage];
  const progress = Math.min(100, (copy.step / 4) * 100);
  const deviceAttached = session.binId != null;

  const actionLabel = session.stage === 'scan_bin'
    ? '掃描模擬 QR Code'
    : session.stage === 'collecting'
      ? '我已回到垃圾桶旁'
      : devicePhase === 'save_failed'
        ? '重新保存便便紀錄'
        : '返回首頁';

  const completeAndReturn = async (completedSession: SmartBinSession) => {
    setDevicePhase('saving');
    try {
      await props.onFinished(completedSession);
      setSession(completedSession);
      saveSmartBinSession(null, props.actorId, props.petId);
      setIsAdvancing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '無法保存便便紀錄，任務已保留，請稍後重試。');
      setDevicePhase('save_failed');
      setIsAdvancing(false);
    }
  };

  const runDeviceCycle = async () => {
    const cycleSession: SmartBinSession = { ...session, stage: 'device_cycle' };
    setSession(cycleSession);
    setError('');
    setIsAdvancing(true);
    setDevicePhase('checking_nearby');
    await wait(550);

    if (scenario === 'network_offline' || scenario === 'busy') {
      setError(scenarioErrors[scenario]);
      setSession({ ...cycleSession, stage: 'collecting' });
      setDevicePhase('idle');
      setIsAdvancing(false);
      return;
    }

    setDevicePhase('unlocked');
    await wait(800);
    if (scenario === 'unlock_timeout') {
      setError(scenarioErrors.unlock_timeout);
      setSession({ ...cycleSession, stage: 'collecting' });
      setDevicePhase('idle');
      setIsAdvancing(false);
      return;
    }

    setDevicePhase('hatch_open');
    await wait(750);
    if (scenario === 'hatch_stuck') {
      setError(scenarioErrors.hatch_stuck);
      setSession({ ...cycleSession, stage: 'collecting' });
      setDevicePhase('idle');
      setIsAdvancing(false);
      return;
    }

    setDevicePhase('hatch_closed');
    await wait(550);
    if (scenario === 'lock_failed') {
      setError(scenarioErrors.lock_failed);
      setSession({ ...cycleSession, stage: 'collecting' });
      setDevicePhase('idle');
      setIsAdvancing(false);
      return;
    }

    setDevicePhase('locked');
    await wait(450);
    await completeAndReturn({ ...cycleSession, stage: 'completed' });
  };

  const advance = () => {
    if (session.stage === 'completed') {
      props.onCompleted();
      return;
    }
    if (expired) {
      setError('這次模擬任務已逾時。請返回首頁並重新拍攝建立新任務。');
      return;
    }
    if (session.stage === 'device_cycle' && devicePhase === 'save_failed') {
      setError('');
      setIsAdvancing(true);
      void completeAndReturn({ ...session, stage: 'completed' });
      return;
    }
    if (session.stage === 'collecting') {
      void runDeviceCycle();
      return;
    }
    if (session.stage === 'scan_bin' && scenario !== 'available') {
      setError(scenarioErrors[scenario]);
      return;
    }
    setError('');
    setIsAdvancing(true);
    setTimeout(() => {
      const nextSession: SmartBinSession = {
        ...session,
        stage: 'collecting',
        binId: session.binId ?? 'sim-bin-park-03',
        binName: session.binName ?? '幸福公園 03 號垃圾桶',
        depositExpiresAt: Date.now() + DEPOSIT_WINDOW_MS,
      };
      setSession(nextSession);
      setScenario('available');
      setIsAdvancing(false);
    }, 450);
  };

  const restart = () => {
    setSession(createSession(props));
    setScenario('available');
    setError('');
    setDevicePhase('idle');
  };

  return (
    <View testID="smart-bin-simulator" style={styles.screen}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="暫時離開模擬投放" accessibilityRole="button" accessibilityState={{ disabled: isAdvancing }} disabled={isAdvancing} hitSlop={8} onPress={() => props.onExit(session)} style={({ pressed }) => [styles.backButton, isAdvancing && styles.backButtonDisabled, pressed && styles.pressed]}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>目前寵物：{props.petName}</Text>
          <Text style={styles.headerTitle}>智能便便垃圾桶</Text>
        </View>
        <View style={styles.simBadge}><Text style={styles.simBadgeText}>模擬設備</Text></View>
      </View>

      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View accessibilityLabel={`流程進度 ${copy.step}／4`} style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progress}%` }]} />
        </View>

        <View style={styles.heroCard}>
          <View style={styles.heroIcon}><Text style={styles.heroIconText}>{session.stage === 'completed' ? '✓' : '♻'}</Text></View>
          <Text selectable style={styles.stepLabel}>步驟 {copy.step}／4</Text>
          <Text selectable style={styles.title}>{session.stage === 'device_cycle' ? devicePhaseCopy[devicePhase].title : copy.title}</Text>
          <Text selectable style={styles.detail}>{session.stage === 'device_cycle' ? devicePhaseCopy[devicePhase].detail : copy.detail}</Text>
          {session.stage !== 'completed' ? (
            <View style={styles.timerPill}>
              <Text style={styles.timerLabel}>{session.depositExpiresAt ? '完成投放剩餘' : '前往設備剩餘'}</Text>
              <Text selectable style={styles.timerValue}>{formatRemaining(deadline - now)}</Text>
            </View>
          ) : null}
        </View>

        {session.stage === 'completed' ? (
          <View style={styles.celebrationCard}>
            <Text style={styles.celebrationEmoji}>🎉</Text>
            <View style={styles.celebrationCopy}>
              <Text selectable style={styles.celebrationTitle}>今天也完成了一件好事</Text>
              <Text selectable style={styles.celebrationText}>本次模擬投放已完成，便便紀錄也已安全保存。正式積分功能尚未開放。</Text>
            </View>
          </View>
        ) : null}

        {deviceAttached && session.stage !== 'completed' ? (
          <View style={styles.deviceCard}>
            <View style={styles.deviceHeader}>
              <View><Text style={styles.cardEyebrow}>已選設備</Text><Text selectable style={styles.deviceName}>{session.binName}</Text></View>
              <View style={styles.onlineBadge}><Text style={styles.onlineText}>● 模擬在線</Text></View>
            </View>
            {session.stage === 'device_cycle' ? (
              <View style={styles.deviceSignalRow}>
                <View style={[styles.deviceLight, devicePhaseCopy[devicePhase].light === 'green' && styles.deviceLightGreen]} />
                <Text selectable style={styles.deviceSignalText}>{devicePhaseCopy[devicePhase].title}</Text>
              </View>
            ) : (
              <Text selectable style={styles.deviceReadyText}>撿屎袋已發出・等待你回到設備旁</Text>
            )}
          </View>
        ) : null}

        {error || expired ? (
          <View accessibilityRole="alert" style={styles.errorCard}>
            <Text selectable style={styles.errorTitle}>目前無法繼續</Text>
            <Text selectable style={styles.errorText}>{error || '這次模擬任務已逾時，不會發袋、解鎖或產生積分。'}</Text>
          </View>
        ) : null}

        {session.stage !== 'completed' ? (
          <View style={styles.trustCard}>
            <Text style={styles.trustTitle}>這個畫面正在模擬什麼？</Text>
            <Text selectable style={styles.trustText}>QR、出袋、近距離連線、電子鎖及門鎖感測器目前都是 App 狀態模擬。模型結果只是「疑似有便便」，不是人工確認或健康診斷。</Text>
          </View>
        ) : null}

        {session.stage === 'scan_bin' || session.stage === 'collecting' || session.stage === 'completed' || devicePhase === 'save_failed' ? (
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: isAdvancing || expired }} disabled={isAdvancing || expired} onPress={advance} style={({ pressed }) => [styles.primaryButton, (pressed || isAdvancing) && styles.primaryPressed, expired && styles.disabledButton]}>
            <Text style={styles.primaryText}>{isAdvancing ? '模擬設備處理中…' : actionLabel}</Text>
          </Pressable>
        ) : null}

        {session.stage !== 'completed' ? (
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: showDeveloperTools }} onPress={() => setShowDeveloperTools((current) => !current)} style={({ pressed }) => [styles.developerToggle, pressed && styles.pressed]}>
            <Text style={styles.developerToggleText}>{showDeveloperTools ? '收合開發測試' : '開發測試'}</Text>
          </Pressable>
        ) : null}
        {showDeveloperTools && session.stage !== 'completed' ? (
          <View style={styles.scenarioCard}>
            <Text style={styles.cardTitle}>模擬故障情境</Text>
            <Text style={styles.cardText}>僅供開發驗證；正常使用不需要操作這裡。</Text>
            <View style={styles.chips}>
              {scenariosForStage(session.stage === 'device_cycle' ? 'collecting' : session.stage).map((option) => (
                <Pressable key={option.value} accessibilityRole="radio" accessibilityState={{ checked: scenario === option.value }} onPress={() => { setScenario(option.value); setError(''); }} style={({ pressed }) => [styles.chip, scenario === option.value && styles.chipSelected, pressed && styles.pressed]}>
                  <Text style={[styles.chipText, scenario === option.value && styles.chipTextSelected]}>{option.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}

        {expired ? (
          <Pressable accessibilityRole="button" onPress={restart} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}>
            <Text style={styles.secondaryText}>重新開始模擬任務</Text>
          </Pressable>
        ) : !isAdvancing && session.stage !== 'completed' ? (
          <Pressable accessibilityRole="button" onPress={() => props.onExit(session)} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}>
            <Text style={styles.secondaryText}>暫時離開，稍後繼續</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

const colors = { background: '#F7F4EC', surface: '#FFFFFF', text: '#18362A', muted: '#60736A', border: '#DDE5DF', brand: '#276749', brandSoft: '#E2F1E8', warningSoft: '#FFF3D6', warning: '#805B18', dangerSoft: '#FDE8E5', danger: '#9B3B32' };

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { minHeight: 76, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  backButton: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.brandSoft },
  backButtonDisabled: { opacity: 0.45 },
  backText: { color: colors.brand, fontSize: 32, lineHeight: 34 },
  headerCopy: { flex: 1, minWidth: 0 },
  eyebrow: { color: colors.brand, fontSize: 11, fontWeight: '800' },
  headerTitle: { color: colors.text, fontSize: 19, fontWeight: '900', marginTop: 2 },
  simBadge: { paddingHorizontal: 9, paddingVertical: 7, borderRadius: 12, backgroundColor: colors.warningSoft },
  simBadgeText: { color: colors.warning, fontSize: 9, fontWeight: '900' },
  content: { padding: 16, paddingBottom: 32, gap: 14 },
  progressTrack: { height: 7, borderRadius: 5, backgroundColor: '#DCE5DF', overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 5, backgroundColor: colors.brand },
  heroCard: { alignItems: 'center', padding: 22, borderRadius: 24, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  heroIcon: { width: 58, height: 58, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.brandSoft },
  heroIconText: { color: colors.brand, fontSize: 28, fontWeight: '900' },
  stepLabel: { color: colors.brand, fontSize: 10, fontWeight: '900', marginTop: 12 },
  title: { color: colors.text, fontSize: 23, lineHeight: 30, fontWeight: '900', textAlign: 'center', marginTop: 5 },
  detail: { color: colors.muted, fontSize: 13, lineHeight: 20, textAlign: 'center', marginTop: 7 },
  timerPill: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 13, paddingVertical: 9, borderRadius: 15, backgroundColor: '#F1F5F2', marginTop: 16 },
  timerLabel: { color: colors.muted, fontSize: 10, fontWeight: '700' },
  timerValue: { color: colors.text, fontSize: 15, fontWeight: '900', fontVariant: ['tabular-nums'] },
  deviceCard: { padding: 17, borderRadius: 20, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  deviceHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  cardEyebrow: { color: colors.muted, fontSize: 9, fontWeight: '800' },
  deviceName: { color: colors.text, fontSize: 15, fontWeight: '900', marginTop: 3 },
  onlineBadge: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 10, backgroundColor: colors.brandSoft },
  onlineText: { color: colors.brand, fontSize: 9, fontWeight: '800' },
  deviceReadyText: { color: colors.muted, fontSize: 11, lineHeight: 17, marginTop: 14 },
  deviceSignalRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 15, paddingHorizontal: 13, backgroundColor: '#F4F7F5', marginTop: 14 },
  deviceLight: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#AAB5AF', borderWidth: 3, borderColor: '#DDE4E0' },
  deviceLightGreen: { backgroundColor: '#4CC37A', borderColor: '#C9F1D7' },
  deviceSignalText: { flex: 1, color: colors.text, fontSize: 11, lineHeight: 17, fontWeight: '800' },
  celebrationCard: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18, borderRadius: 22, backgroundColor: '#E2F1E8', borderWidth: 1, borderColor: '#C6E2D1' },
  celebrationEmoji: { fontSize: 34 },
  celebrationCopy: { flex: 1, minWidth: 0 },
  celebrationTitle: { color: colors.brand, fontSize: 15, fontWeight: '900' },
  celebrationText: { color: '#476558', fontSize: 11, lineHeight: 17, marginTop: 4 },
  statusGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 15 },
  statusCell: { width: '48%', flexGrow: 1, padding: 11, borderRadius: 13, backgroundColor: '#F4F7F5' },
  statusLabel: { color: colors.muted, fontSize: 9 },
  statusValue: { color: colors.text, fontSize: 12, fontWeight: '800', marginTop: 3 },
  scenarioCard: { padding: 17, borderRadius: 20, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '900' },
  cardText: { color: colors.muted, fontSize: 11, lineHeight: 17, marginTop: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 13 },
  chip: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 13, borderWidth: 1, borderColor: colors.border, backgroundColor: '#F7F9F7' },
  chipSelected: { borderColor: colors.brand, backgroundColor: colors.brandSoft },
  chipText: { color: colors.muted, fontSize: 10, fontWeight: '700' },
  chipTextSelected: { color: colors.brand, fontWeight: '900' },
  errorCard: { padding: 15, borderRadius: 17, backgroundColor: colors.dangerSoft, borderWidth: 1, borderColor: '#F2C8C2' },
  errorTitle: { color: colors.danger, fontSize: 13, fontWeight: '900' },
  errorText: { color: '#76423D', fontSize: 11, lineHeight: 17, marginTop: 4 },
  trustCard: { padding: 15, borderRadius: 17, backgroundColor: colors.warningSoft },
  trustTitle: { color: colors.warning, fontSize: 12, fontWeight: '900' },
  trustText: { color: '#765C2D', fontSize: 10, lineHeight: 16, marginTop: 4 },
  primaryButton: { minHeight: 52, alignItems: 'center', justifyContent: 'center', borderRadius: 17, paddingHorizontal: 16, backgroundColor: colors.brand },
  primaryPressed: { opacity: 0.82 },
  primaryText: { color: '#FFFFFF', fontSize: 14, fontWeight: '900' },
  disabledButton: { backgroundColor: '#9AA9A1' },
  developerToggle: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
  developerToggleText: { color: '#7D8D84', fontSize: 10, fontWeight: '700' },
  secondaryButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 16 },
  secondaryText: { color: colors.brand, fontSize: 13, fontWeight: '800' },
  pressed: { opacity: 0.72 },
});

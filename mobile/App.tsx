import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { StatusBar } from 'expo-status-bar';
import type { Session } from '@supabase/supabase-js';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  Dimensions,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Line, Polyline, Rect, Text as SvgText } from 'react-native-svg';

import { AuthLoadingScreen, AuthScreen } from './src/features/auth/AuthScreen';
import { AppConfirmDialog } from './src/features/AppConfirmDialog';
import { MedicalCenterScreen } from './src/features/medical/MedicalCenterScreen';
import { PetOnboardingScreen, type PetOnboardingValue } from './src/features/pets/PetOnboardingScreen';
import { CollaborationModal } from './src/features/pets/CollaborationModal';
import { WalkFlow } from './src/features/walks/WalkFlow';
import { WalkTrendCard } from './src/features/walks/WalkTrendCard';
import { formatWalkDuration } from './src/features/walks/walkMath';
import { StoolReviewScreen } from './src/features/stool-review/StoolReviewScreen';
import {
  calculateCenteredSquareCrop,
  calculateStoolGuideFrame,
  mapGuideFrameToPhotoCrop,
  prepareStoolRoiImage,
  STOOL_CAPTURE_ROI_VERSION,
  STOOL_MODEL_PREPROCESSING_VERSION,
  type ImageSize,
} from './src/features/stool-capture/roi';
import { loadSmartBinSession, SmartBinSimulator, type SmartBinSession } from './src/features/smart-bin-simulator';
import { supabase } from './src/lib/supabase';
import { isCompactPhone, layoutTokens } from './src/lib/layout';
import {
  acknowledgeOfflineDisclosure,
  cacheOfflineAccountContext,
  enqueueOfflineCareRecord,
  getOfflineQueueSummary,
  getOfflineSyncMode,
  hasSeenOfflineDisclosure,
  listOfflineCareRecords,
  loadOfflineAccountContext,
  setOfflineSyncMode as persistOfflineSyncMode,
  syncOfflineCareQueue,
  type OfflineCareQueueRow,
  type OfflineQueueSummary,
  type OfflineSyncMode,
} from './src/services/offlineCareQueue';
import {
  createCareRecord,
  findCareRecordBySmartBinSession,
  createMedicationPlan,
  createPet,
  createPetAvatarSignedUrl,
  completePreventiveCare,
  acceptPetInvitation,
  acceptPetInvitationCode,
  deleteCareRecord,
  deletePetMedia,
  getMyProfile,
  listActivePets,
  listCareRecords,
  listWalkSessions,
  listMedicationPlans,
  listMyPendingInvitations,
  listPreventiveCareSchedules,
  refreshMedicationReminders,
  completeStoredMedicationReminder,
  resolveMissedMedicationReminder,
  savePreventiveCareSchedule,
  updateCareRecord,
  updateMyProfile,
  updateMedicationPlan,
  updatePet,
  uploadPetAvatar,
} from './src/services/petData';
import { analyzeStoolObservation, createStoolClientRequestKey, createStoolObservation, getStoolReviewerStatus, type StoolAnalysisTrace, uploadAndQueueStoolImage } from './src/services/stoolAnalysis';
import { featureFlags } from './src/config/featureFlags';
import type { CareRecordRow, MedicationDoseUnit, MedicationPlanRow, MedicationReminderRow, PetInvitationRow, PetRow, PreventiveCareKind, PreventiveCareScheduleRow, StoolObservationRow, WalkSessionRow } from './src/types/database';

type TabKey = 'home' | 'records' | 'medical' | 'profile';
type CameraStep = 'idle' | 'captured' | 'uploading' | 'analysing' | 'awaiting_review' | 'success' | 'error';
type PetEntryStep = 'choice' | 'join' | 'create';

type ActivityRecord = {
  id: string;
  kind: ActivityKind;
  icon: string;
  title: string;
  detail: string;
  time: string;
  occurredAt: number;
  tone: string;
  amount?: number;
  unit?: string;
  note?: string;
  foodType?: CareRecordRow['food_type'];
  medicationName?: string;
  medicationDose?: string;
  stoolTexture?: CareRecordRow['stool_texture'];
  stoolColor?: CareRecordRow['stool_color'];
  stoolStatus?: CareRecordRow['stool_status'];
  urineColor?: CareRecordRow['urine_color'];
  metadata?: CareRecordRow['metadata'];
  source?: CareRecordRow['source'];
  walkSessionId?: string;
  petId?: string;
  ownerId?: string;
  petName?: string;
  syncStatus?: 'pending' | 'syncing' | 'failed';
};

type ActivityKind = 'meal' | 'water' | 'medication' | 'stool' | 'urine' | 'vaccine' | 'medical';

type WalkSessionRecord = WalkSessionRow & { petName?: string };

type SelectOption = {
  label: string;
  value: string;
  color?: string;
};

type MedicationReminder = {
  id: string;
  planId: string;
  when: string;
  time: string;
  scheduledAt: number;
  title: string;
  dose: string;
  instruction: string;
  remainingDays: number;
  status: MedicationReminderRow['status'];
};

type MedicationPlan = {
  id: string;
  title: string;
  dose: string;
  doseAmount: number;
  doseUnit: MedicationDoseUnit;
  times: string[];
  startDate: string;
  endDate: string;
  instruction: string;
  note: string;
  active: boolean;
};

type QuickAction = {
  kind: ActivityKind;
  icon: string;
  label: string;
  detail: string;
  tone: string;
};

type PetProfile = {
  name: string;
  breed: string;
  avatarIcon: string;
  avatarUri: string;
  avatarPath: string;
  sex: string;
  sterilizationStatus: string;
  birthday: string;
  weightKg: string;
  mealsPerDay: number;
  waterGoalMl: number;
};

type ActivityInput = Omit<ActivityRecord, 'id' | 'time' | 'occurredAt'>;

type PreventiveCareStatus = {
  kind: PreventiveCareKind;
  icon: string;
  label: string;
  intervalLabel: string;
  statusLabel: string;
  detailLabel: string;
  isOverdue: boolean;
  isUnconfigured: boolean;
};

type PreventiveCareScheduleInput = Omit<
  PreventiveCareScheduleRow,
  'id' | 'created_at' | 'updated_at'
>;

const dogBreedOptions: SelectOption[] = [
  '米克斯（非管制犬種）',
  '台灣犬',
  '柴犬',
  '貴賓犬',
  '馬爾濟斯',
  '吉娃娃',
  '博美犬',
  '約克夏梗',
  '西施犬',
  '比熊犬',
  '雪納瑞',
  '臘腸犬',
  '巴哥犬',
  '法國鬥牛犬',
  '柯基犬',
  '米格魯',
  '拉布拉多',
  '黃金獵犬',
  '邊境牧羊犬',
  '喜樂蒂牧羊犬',
  '澳洲牧羊犬',
  '德國牧羊犬',
  '哈士奇',
  '薩摩耶',
  '秋田犬',
  '大白熊犬',
  '伯恩山犬',
].map((breed) => ({ label: breed, value: breed }));

const dogAvatarOptions = [
  { label: '柴犬', icon: '🐕', background: '#FFF0D9' },
  { label: '幼犬', icon: '🐶', background: '#F8E4D7' },
  { label: '貴賓', icon: '🐩', background: '#F3E5F5' },
  { label: '拉布拉多', icon: '🦮', background: '#FFF0C9' },
  { label: '工作犬', icon: '🐕‍🦺', background: '#E4EDF7' },
  { label: '米克斯', icon: '🐾', background: '#E6F1E8' },
];

const sterilizationOptions: SelectOption[] = ['已絕育', '未絕育', '未知'].map((value) => ({ label: value, value }));
const foodTypeOptions: SelectOption[] = ['乾糧', '濕糧', '罐頭'].map((value) => ({ label: value, value }));
const stoolTextureOptions: SelectOption[] = ['過硬', '正常', '軟便', '水樣'].map((value) => ({ label: value, value }));
const stoolStatusOptions: SelectOption[] = ['正常', '軟便', '腹瀉', '便秘'].map((value) => ({ label: value, value }));
const stoolColorOptions: SelectOption[] = [
  { label: '巧克力棕', value: '巧克力棕', color: '#6F4E37' },
  { label: '黑色柏油狀', value: '黑色柏油狀', color: '#161616' },
  { label: '鮮紅血絲', value: '鮮紅血絲', color: '#C62828' },
  { label: '黃橘色', value: '黃橘色', color: '#F5A623' },
  { label: '灰白色', value: '灰白色', color: '#D9D5CC' },
  { label: '綠色', value: '綠色', color: '#4F8A4C' },
];
const urineColorOptions: SelectOption[] = [
  { label: '未知', value: '未知', color: '#E4E8E5' },
  { label: '透明', value: '透明', color: '#F4FBFF' },
  { label: '淺黃', value: '淺黃', color: '#F5E58C' },
  { label: '深黃', value: '深黃', color: '#D7A71E' },
  { label: '棕色', value: '棕色', color: '#7A4B2A' },
  { label: '紅', value: '紅', color: '#C53A32' },
];
const medicationDoseUnitOptions: SelectOption[] = [
  { label: '微克（mcg）', value: 'mcg' },
  { label: '毫克（mg）', value: 'mg' },
  { label: '克（g）', value: 'g' },
  { label: '毫升（mL）', value: 'ml' },
  { label: '錠', value: 'tablet' },
  { label: '膠囊', value: 'capsule' },
  { label: '包', value: 'packet' },
  { label: '滴', value: 'drop' },
  { label: '噴', value: 'spray' },
  { label: '國際單位（IU）', value: 'iu' },
  { label: '其他', value: 'other' },
];
const medicationInstructionOptions: SelectOption[] = [
  '依獸醫或藥袋指示',
  '空腹服用（飯前 1 小時或飯後 2 小時）',
  '飯前 30 分鐘',
  '飯前 1 小時',
  '隨餐服用',
  '飯後立即（30 分鐘內）',
  '飯後 1 小時',
  '飯後 2 小時',
  '睡前服用',
].map((value) => ({ label: value, value }));
const medicationHourOptions: SelectOption[] = Array.from({ length: 24 }, (_, hour) => {
  const value = String(hour).padStart(2, '0');
  return { label: value, value };
});
const medicationMinuteOptions: SelectOption[] = Array.from({ length: 12 }, (_, index) => {
  const value = String(index * 5).padStart(2, '0');
  return { label: value, value };
});

function isPositiveDoseInput(value: string) {
  return /^(?:0\.(?:\d{1,3})|[1-9]\d*(?:\.\d{1,3})?)$/.test(value.trim());
}

function timeToMinutes(value: string) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function minutesToTime(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return fallback;
}

const foodTypeToDatabase = { '乾糧': 'dry', '濕糧': 'wet', '罐頭': 'canned' } as const;
const foodTypeFromDatabase = { dry: '乾糧', wet: '濕糧', canned: '罐頭' } as const;
const stoolTextureToDatabase = { '過硬': 'hard', '正常': 'normal', '軟便': 'soft', '水樣': 'watery' } as const;
const stoolTextureFromDatabase = { hard: '過硬', normal: '正常', soft: '軟便', watery: '水樣' } as const;
const stoolStatusToDatabase = { '正常': 'normal', '軟便': 'soft_stool', '腹瀉': 'diarrhea', '便秘': 'constipation' } as const;
const stoolStatusFromDatabase = { normal: '正常', soft_stool: '軟便', diarrhea: '腹瀉', constipation: '便秘' } as const;
const stoolColorToDatabase = { '巧克力棕': 'chocolate_brown', '黑色柏油狀': 'black_tarry', '鮮紅血絲': 'fresh_red', '黃橘色': 'yellow_orange', '灰白色': 'gray_white', '綠色': 'green' } as const;
const stoolColorFromDatabase = { chocolate_brown: '巧克力棕', black_tarry: '黑色柏油狀', fresh_red: '鮮紅血絲', yellow_orange: '黃橘色', gray_white: '灰白色', green: '綠色' } as const;
const urineColorToDatabase = { '未知': 'unknown', '透明': 'clear', '淺黃': 'light_yellow', '深黃': 'dark_yellow', '棕色': 'brown', '紅': 'red' } as const;
const urineColorFromDatabase = { unknown: '未知', clear: '透明', light_yellow: '淺黃', dark_yellow: '深黃', brown: '棕色', red: '紅' } as const;

function isPositiveIntegerInput(value: string) {
  return /^[1-9]\d*$/.test(value.trim());
}

function dateValueWithOffset(dayOffset: number) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  return formatDateValue(date);
}

function getRelativeDayLabel(date: Date) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  const difference = Math.round((target.getTime() - start.getTime()) / 86_400_000);
  if (difference === 0) return '今天';
  if (difference === 1) return '明天';
  return `${target.getMonth() + 1}/${target.getDate()}`;
}

function buildMedicationReminders(plan: MedicationPlan) {
  const start = parseDateValue(plan.startDate);
  const end = parseDateValue(plan.endDate);
  if (!start || !end || end < start || !plan.active) return [];

  const reminders: MedicationReminder[] = [];
  const cursor = new Date(start);
  const now = Date.now();
  while (cursor <= end) {
    plan.times.forEach((time) => {
      const [hours, minutes] = time.split(':').map(Number);
      const scheduledDate = new Date(cursor);
      scheduledDate.setHours(hours, minutes, 0, 0);
      if (scheduledDate.getTime() < now - 30 * 60 * 1000) return;

      const occurrenceDate = formatDateValue(scheduledDate);
      const remainingDays = Math.max(1, Math.round((end.getTime() - cursor.getTime()) / 86_400_000) + 1);
      reminders.push({
        id: `${plan.id}-${occurrenceDate}-${time}`,
        planId: plan.id,
        when: getRelativeDayLabel(scheduledDate),
        time,
        scheduledAt: scheduledDate.getTime(),
        title: plan.title,
        dose: plan.dose,
        instruction: plan.instruction,
        remainingDays,
        status: 'pending',
      });
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  return reminders.sort((left, right) => left.scheduledAt - right.scheduledAt);
}

const initialMedicationPlans: MedicationPlan[] = [];

const initialMedicationReminders = initialMedicationPlans.flatMap(buildMedicationReminders)
  .sort((left, right) => left.scheduledAt - right.scheduledAt);

const quickActions: QuickAction[] = [
  { kind: 'meal', icon: '🍚', label: '飲食', detail: '食物與份量', tone: '#F4A261' },
  { kind: 'water', icon: '💧', label: '喝水', detail: '飲水量 ml', tone: '#4AA8D8' },
  { kind: 'stool', icon: '💩', label: '便便', detail: '質地、顏色與狀態', tone: '#9C704F' },
  { kind: 'urine', icon: '🟡', label: '尿尿', detail: '尿液顏色', tone: '#D29D3E' },
  { kind: 'vaccine', icon: '💉', label: '疫苗', detail: '疫苗名稱', tone: '#E76F77' },
  { kind: 'medical', icon: '🪱', label: '驅蟲', detail: '驅蟲藥與日期', tone: '#4F9D85' },
];

function formatUncalibratedDetectionScore(score: number | null | undefined) {
  if (score == null || !Number.isFinite(score)) return '未提供';
  if (score > 0 && score < 0.000001) return '<0.000001';
  return score.toFixed(6);
}

function formatActivityTime(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (formatDateValue(date) === formatDateValue(today)) return `今天 ${clock}`;
  if (formatDateValue(date) === formatDateValue(yesterday)) return `昨天 ${clock}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${clock}`;
}

function getPreventiveCareStatus(schedule: PreventiveCareScheduleRow | undefined, kind: PreventiveCareKind): PreventiveCareStatus {
  const isVaccine = kind === 'vaccine';
  if (!schedule) {
    return {
      kind,
      icon: isVaccine ? '💉' : '🪱',
      label: isVaccine ? '疫苗' : '驅蟲',
      intervalLabel: '',
      statusLabel: '尚未設定',
      detailLabel: '點擊設定提醒週期與到期日',
      isOverdue: false,
      isUnconfigured: true,
    };
  }

  const dueAt = parseDateValue(schedule.next_due_on) ?? new Date();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const remainingDays = Math.round((dueAt.getTime() - today.getTime()) / 86_400_000);

  return {
    kind,
    icon: isVaccine ? '💉' : '🪱',
    label: schedule.title,
    intervalLabel: schedule.kind === 'vaccine' ? '每年一次' : `每 ${schedule.interval_months} 個月`,
    statusLabel: remainingDays > 0 ? `剩 ${remainingDays} 天` : remainingDays === 0 ? '今天到期' : `已逾期 ${Math.abs(remainingDays)} 天`,
    detailLabel: `${schedule.next_due_on} 到期`,
    isOverdue: remainingDays <= 0,
    isUnconfigured: false,
  };
}

const activityPresentation: Record<ActivityKind, { icon: string; tone: string; title: string }> = {
  meal: { icon: '🍚', tone: '#F4A261', title: '飲食' },
  water: { icon: '💧', tone: '#4AA8D8', title: '飲水' },
  medication: { icon: '💊', tone: '#8B7BCF', title: '用藥' },
  stool: { icon: '💩', tone: '#9C704F', title: '排便' },
  urine: { icon: '🟡', tone: '#D29D3E', title: '尿尿' },
  vaccine: { icon: '💉', tone: '#E76F77', title: '疫苗' },
  medical: { icon: '🪱', tone: '#4F9D85', title: '驅蟲' },
};

function petRowToProfile(pet: PetRow): PetProfile {
  return {
    name: pet.name,
    breed: pet.breed,
    avatarIcon: pet.avatar_icon || '🐕',
    avatarUri: '',
    avatarPath: pet.avatar_path || '',
    sex: pet.sex === 'male' ? '公' : pet.sex === 'female' ? '母' : '未知',
    sterilizationStatus: pet.sterilization_status === 'sterilized' ? '已絕育' : pet.sterilization_status === 'not_sterilized' ? '未絕育' : '未知',
    birthday: pet.birthday || '',
    weightKg: pet.weight_kg == null ? '' : String(pet.weight_kg),
    mealsPerDay: pet.meals_per_day,
    waterGoalMl: pet.water_goal_ml,
  };
}

function onboardingValueToProfile(value: PetOnboardingValue): PetProfile {
  return { ...value, avatarUri: '', avatarPath: '' };
}

function careRecordToActivity(record: CareRecordRow, petName?: string): ActivityRecord {
  const presentation = activityPresentation[record.kind];
  const occurredAt = new Date(record.occurred_at).getTime();
  const foodLabels = { dry: '乾糧', wet: '濕糧', canned: '罐頭' } as const;
  const stoolTextureLabels = { hard: '過硬', normal: '正常', soft: '軟便', watery: '水樣' } as const;
  const stoolColorLabels = { chocolate_brown: '巧克力棕', black_tarry: '黑色柏油狀', fresh_red: '鮮紅血絲', yellow_orange: '黃橘色', gray_white: '灰白色', green: '綠色' } as const;
  const stoolStatusLabels = { normal: '正常', soft_stool: '軟便', diarrhea: '腹瀉', constipation: '便秘' } as const;
  const urineColorLabels = { unknown: '未知', clear: '透明', light_yellow: '淺黃', dark_yellow: '深黃', brown: '棕色', red: '紅色' } as const;

  const usesStructuredForm = Boolean(
    record.metadata
      && typeof record.metadata === 'object'
      && !Array.isArray(record.metadata)
      && record.metadata.structured_form_version === 1,
  );
  let detail = usesStructuredForm ? '' : (record.note || '');
  if ((usesStructuredForm || !detail) && record.kind === 'meal') {
    detail = `${record.food_type ? foodLabels[record.food_type] : '食物'}${record.amount != null ? `・${record.amount} ${record.unit || 'g'}` : ''}`;
  }
  if ((usesStructuredForm || !detail) && record.kind === 'water') detail = `${record.amount ?? 0} ${record.unit || 'ml'}`;
  if ((usesStructuredForm || !detail) && record.kind === 'medication') detail = [record.medication_name, record.medication_dose].filter(Boolean).join('・');
  if ((usesStructuredForm || !detail) && record.kind === 'stool') {
    detail = [
      record.stool_texture ? `質地：${stoolTextureLabels[record.stool_texture]}` : '',
      record.stool_color ? `顏色：${stoolColorLabels[record.stool_color]}` : '',
      record.stool_status ? `排便狀態：${stoolStatusLabels[record.stool_status]}` : '',
    ].filter(Boolean).join('・');
  }
  if ((usesStructuredForm || !detail) && record.kind === 'urine') detail = `顏色：${record.urine_color ? urineColorLabels[record.urine_color] : '未知'}`;
  if ((usesStructuredForm || !detail) && (record.kind === 'vaccine' || record.kind === 'medical')) detail = record.title || presentation.title;
  if (usesStructuredForm && record.note) detail = detail ? `${detail}・${record.note}` : record.note;
  if (record.source === 'walk_tracking') detail = detail ? `${detail}・遛狗途中` : '遛狗途中';

  return {
    id: record.id,
    kind: record.kind,
    icon: presentation.icon,
    title: record.title || presentation.title,
    detail: detail || '沒有補充內容',
    time: formatActivityTime(occurredAt),
    occurredAt,
    tone: presentation.tone,
    amount: record.amount == null ? undefined : Number(record.amount),
    unit: record.unit ?? undefined,
    note: record.note ?? undefined,
    foodType: record.food_type,
    medicationName: record.medication_name ?? undefined,
    medicationDose: record.medication_dose ?? undefined,
    stoolTexture: record.stool_texture,
    stoolColor: record.stool_color,
    stoolStatus: record.stool_status,
    urineColor: record.urine_color,
    metadata: record.metadata,
    source: record.source,
    walkSessionId: record.walk_session_id ?? undefined,
    petId: record.pet_id,
    ownerId: record.owner_id,
    petName,
  };
}

function medicationPlanRowToPlan(plan: MedicationPlanRow): MedicationPlan {
  return {
    id: plan.id,
    title: plan.title,
    dose: plan.dose,
    doseAmount: plan.dose_amount == null ? Number.parseFloat(plan.dose) || 1 : Number(plan.dose_amount),
    doseUnit: plan.dose_unit ?? 'mg',
    times: plan.times.map((time) => time.slice(0, 5)),
    startDate: plan.start_date,
    endDate: plan.end_date,
    instruction: plan.instruction || '',
    note: plan.note || '',
    active: plan.is_active,
  };
}

function sortPetsForProfile(pets: PetRow[], profileId: string) {
  return [...pets].sort((left, right) => {
    const leftOwnershipRank = left.owner_id === profileId ? 0 : 1;
    const rightOwnershipRank = right.owner_id === profileId ? 0 : 1;
    if (leftOwnershipRank !== rightOwnershipRank) {
      return leftOwnershipRank - rightOwnershipRank;
    }

    const createdAtDifference = Date.parse(left.created_at) - Date.parse(right.created_at);
    if (createdAtDifference !== 0) return createdAtDifference;
    return left.id.localeCompare(right.id);
  });
}

function medicationReminderRowToReminder(row: MedicationReminderRow, plans: MedicationPlan[]): MedicationReminder {
  const plan = plans.find((item) => item.id === row.medication_plan_id);
  const scheduledDate = new Date(row.scheduled_at);
  const endDate = plan ? parseDateValue(plan.endDate) : null;
  return {
    id: row.id,
    planId: row.medication_plan_id,
    when: getRelativeDayLabel(scheduledDate),
    time: `${String(scheduledDate.getHours()).padStart(2, '0')}:${String(scheduledDate.getMinutes()).padStart(2, '0')}`,
    scheduledAt: scheduledDate.getTime(),
    title: plan?.title ?? '用藥',
    dose: plan?.dose ?? '',
    instruction: plan?.instruction ?? '依獸醫或藥袋指示',
    remainingDays: endDate ? Math.max(0, Math.ceil((endDate.getTime() - Date.now()) / 86_400_000) + 1) : 0,
    status: row.status,
  };
}

const initialActivities: ActivityRecord[] = [];

const tabAvailability: Record<TabKey, boolean> = {
  home: true,
  records: featureFlags.recordsTab,
  medical: featureFlags.medicalTab,
  profile: true,
};

const tabs: { key: TabKey; icon: string; label: string; enabled: boolean }[] = [
  { key: 'home', icon: '⌂', label: '首頁', enabled: tabAvailability.home },
  { key: 'records', icon: '▤', label: '紀錄', enabled: tabAvailability.records },
  { key: 'medical', icon: '✚', label: '醫療', enabled: tabAvailability.medical },
  { key: 'profile', icon: '♙', label: '我的', enabled: tabAvailability.profile },
];

const enabledTabs = tabs.filter((tab) => tab.enabled);

const tabBarContentHeight = 52;

function getMedicationReminderDate(reminder: MedicationReminder) {
  return new Date(reminder.scheduledAt);
}

function getMedicationCompletionOpensAt(reminder: MedicationReminder) {
  return new Date(getMedicationReminderDate(reminder).getTime() - 30 * 60 * 1000);
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const safeAreaInsets = useSafeAreaInsets();
  const [authSession, setAuthSession] = useState<Session | null | undefined>(undefined);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('home');
  useEffect(() => {
    if (!tabAvailability[activeTab]) setActiveTab('home');
  }, [activeTab]);
  const [activities, setActivities] = useState(initialActivities);
  const [allPetActivities, setAllPetActivities] = useState<ActivityRecord[]>([]);
  const [offlineActivities, setOfflineActivities] = useState<ActivityRecord[]>([]);
  const [offlineSummary, setOfflineSummary] = useState<OfflineQueueSummary>({ pending: 0, syncing: 0, failed: 0 });
  const [offlineSyncMode, setOfflineSyncMode] = useState<OfflineSyncMode>('auto');
  const [offlineSettingsReady, setOfflineSettingsReady] = useState(false);
  const [networkState, setNetworkState] = useState<NetInfoState | null>(null);
  const [isSyncingOffline, setIsSyncingOffline] = useState(false);
  const [showOfflineDisclosure, setShowOfflineDisclosure] = useState(false);
  const [walkSessions, setWalkSessions] = useState<WalkSessionRecord[]>([]);
  const [petProfile, setPetProfile] = useState<PetProfile | null>(null);
  const [petId, setPetId] = useState<string | null>(null);
  const [pets, setPets] = useState<PetRow[]>([]);
  const [petAvatarUris, setPetAvatarUris] = useState<Record<string, string>>({});
  const [selectedPetId, setSelectedPetId] = useState<string | null>(null);
  const [pendingInvitations, setPendingInvitations] = useState<PetInvitationRow[]>([]);
  const [petDataStatus, setPetDataStatus] = useState<'idle' | 'loading' | 'needsPet' | 'ready' | 'error'>('idle');
  const [petDataError, setPetDataError] = useState('');
  const [petDataReloadKey, setPetDataReloadKey] = useState(0);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [showPetSettings, setShowPetSettings] = useState(false);
  const [showMedicationManager, setShowMedicationManager] = useState(false);
  const [showPetSwitcher, setShowPetSwitcher] = useState(false);
  const [showAddPet, setShowAddPet] = useState(false);
  const [showCollaboration, setShowCollaboration] = useState(false);
  const [showMessages, setShowMessages] = useState(false);
  const [showAccountSettings, setShowAccountSettings] = useState(false);
  const [showWalkFlow, setShowWalkFlow] = useState(false);
  const [showStoolRecordMethod, setShowStoolRecordMethod] = useState(false);
  const [showStoolCamera, setShowStoolCamera] = useState(false);
  const [showSmartBinSimulator, setShowSmartBinSimulator] = useState(false);
  const [pendingSmartBinSession, setPendingSmartBinSession] = useState<SmartBinSession | null>(null);
  const [smartBinObservationId, setSmartBinObservationId] = useState<string | null>(null);
  const [showStoolReviewer, setShowStoolReviewer] = useState(false);
  const [isStoolReviewer, setIsStoolReviewer] = useState(false);
  const [pendingStoolGalleryImage, setPendingStoolGalleryImage] = useState<{ uri: string; selectedAt: string } | null>(null);
  const [accountDisplayName, setAccountDisplayName] = useState('');
  const [currentProfileId, setCurrentProfileId] = useState('');
  const [petEntryStep, setPetEntryStep] = useState<PetEntryStep>('choice');
  const [isRefreshingRecords, setIsRefreshingRecords] = useState(false);
  const [initialQuickAction, setInitialQuickAction] = useState<QuickAction | null>(null);
  const [medicationPlans, setMedicationPlans] = useState(initialMedicationPlans);
  const [medicationReminders, setMedicationReminders] = useState(initialMedicationReminders);
  const [completedMedicationReminderIds, setCompletedMedicationReminderIds] = useState<string[]>([]);
  const [preventiveCareSchedules, setPreventiveCareSchedules] = useState<PreventiveCareScheduleRow[]>([]);
  const [editingPreventiveCareKind, setEditingPreventiveCareKind] = useState<PreventiveCareKind | null>(null);
  const promptedOverdueReminderIds = useRef<Set<string>>(new Set());
  const offlineSyncInFlight = useRef(false);
  const activeAuthUserIdRef = useRef<string | null>(null);
  activeAuthUserIdRef.current = authSession?.user.id ?? null;

  useEffect(() => NetInfo.addEventListener(setNetworkState), []);

  const refreshPendingInvitations = useCallback(async () => {
    const email = authSession?.user.email;
    if (!email || isPreviewMode) {
      setPendingInvitations([]);
      return;
    }
    const invitations = await listMyPendingInvitations(email);
    setPendingInvitations(invitations);
  }, [authSession?.user.email, isPreviewMode]);

  useEffect(() => {
    if (!supabase) {
      setAuthSession(null);
      return undefined;
    }

    let isMounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (isMounted) setAuthSession(data.session);
    }).catch(() => {
      if (isMounted) setAuthSession(null);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!isMounted) return;
      setAuthSession(session);
      if (session) setIsPreviewMode(false);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!featureFlags.stoolReviewer || !authSession || isPreviewMode) {
      setIsStoolReviewer(false);
      return undefined;
    }
    let isActive = true;
    void getStoolReviewerStatus()
      .then((isReviewer) => {
        if (isActive) setIsStoolReviewer(isReviewer);
      })
      .catch(() => {
        if (isActive) setIsStoolReviewer(false);
      });
    return () => {
      isActive = false;
    };
  }, [authSession, isPreviewMode]);

  useEffect(() => {
    if (isPreviewMode) {
      setAccountDisplayName('毛爸');
      setCurrentProfileId('preview-user');
      return undefined;
    }
    if (!authSession) {
      setAccountDisplayName('');
      setCurrentProfileId('');
      return undefined;
    }

    const metadataName = typeof authSession.user.user_metadata?.display_name === 'string'
      ? authSession.user.user_metadata.display_name.trim()
      : '';
    const fallbackName = metadataName || authSession.user.email?.split('@')[0] || '飼主';
    setAccountDisplayName(fallbackName);

    return undefined;
  }, [authSession, isPreviewMode]);

  useEffect(() => {
    const email = authSession?.user.email?.trim().toLowerCase();
    const realtimeClient = supabase;
    if (!realtimeClient || !authSession || !email || isPreviewMode) return undefined;

    let isActive = true;
    const syncInvitations = async () => {
      try {
        const invitations = await listMyPendingInvitations(email);
        if (isActive) setPendingInvitations(invitations);
      } catch {
        // A temporary Realtime or network interruption is retried when the App
        // returns to the foreground or the user opens the message center.
      }
    };

    void syncInvitations();
    const channel = realtimeClient
      .channel(`pet-invitations:${authSession.user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'pet_invitations',
          filter: `invited_email=eq.${email}`,
        },
        () => void syncInvitations(),
      )
      .subscribe();

    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void syncInvitations();
    });

    return () => {
      isActive = false;
      appStateSubscription.remove();
      void realtimeClient.removeChannel(channel);
    };
  }, [authSession?.user.id, authSession?.user.email, isPreviewMode]);

  useEffect(() => {
    if (authSession === undefined) return undefined;

    if (!authSession && isPreviewMode) {
      setActivities([]);
      setOfflineActivities([]);
      setOfflineSummary({ pending: 0, syncing: 0, failed: 0 });
      setWalkSessions([]);
      setPetProfile(null);
      setPetId(null);
      setPets([]);
      setMedicationPlans([]);
      setMedicationReminders([]);
      setPreventiveCareSchedules([]);
      setPetDataStatus('needsPet');
      return undefined;
    }

    if (!authSession) {
      setPetDataStatus('idle');
      setPetEntryStep('choice');
      return undefined;
    }

    let isMounted = true;
    const loadPetData = async () => {
      setPetDataStatus('loading');
      setPetDataError('');
      try {
        const [profile, accessiblePets] = await Promise.all([
          getMyProfile(authSession.user.id),
          listActivePets(),
        ]);
        if (!isMounted) return;
        if (!profile) throw new Error('找不到目前帳號的個人資料，請重新登入。');
        const metadataName = typeof authSession.user.user_metadata?.display_name === 'string'
          ? authSession.user.user_metadata.display_name.trim()
          : '';
        const fallbackName = metadataName || authSession.user.email?.split('@')[0] || '飼主';
        const pets = sortPetsForProfile(accessiblePets, profile.id);
        setCurrentProfileId(profile.id);
        setAccountDisplayName(profile.display_name?.trim() || fallbackName);
        const accountInvitations = authSession.user.email
          ? await listMyPendingInvitations(authSession.user.email)
          : [];
        if (!isMounted) return;
        setPendingInvitations(accountInvitations);

        const activePet = pets.find((pet) => pet.id === selectedPetId) ?? pets[0];
        setPets(pets);
        if (!activePet) {
          setActivities([]);
          setWalkSessions([]);
          setPetProfile(null);
          setPetId(null);
          setMedicationPlans([]);
          setMedicationReminders([]);
          setPreventiveCareSchedules([]);
          setPetDataStatus('needsPet');
          return;
        }

        const [careRecords, storedPlans, recordsByPet, avatarUris, storedPreventiveCare, walksByPet] = await Promise.all([
          listCareRecords(activePet.owner_id, activePet.id, 500),
          listMedicationPlans(activePet.owner_id, activePet.id),
          Promise.all(pets.map(async (pet) => {
            const records = await listCareRecords(pet.owner_id, pet.id, 500);
            return records.map((record) => careRecordToActivity(record, pet.name));
          })),
          Promise.all(pets.map(async (pet) => [
            pet.id,
            pet.avatar_path ? await createPetAvatarSignedUrl(pet.avatar_path) : '',
          ] as const)),
          listPreventiveCareSchedules(activePet.owner_id, activePet.id),
          Promise.all(pets.map(async (pet) => {
            try {
              const walks = await listWalkSessions(pet.id, 30);
              return walks.map((walk) => ({ ...walk, petName: pet.name }));
            } catch (walkError) {
              console.warn('Unable to load walk sessions during schema rollout.', walkError);
              return [];
            }
          })),
        ]);
        if (!isMounted) return;

        const mappedPlans = storedPlans.map(medicationPlanRowToPlan);
        let storedReminders: Awaited<ReturnType<typeof refreshMedicationReminders>> = [];
        try {
          storedReminders = await refreshMedicationReminders(activePet.id);
        } catch (reminderError) {
          // Reminder data is optional and must not block the pet profile during schema rollout.
          console.warn('Unable to load medication reminders.', reminderError);
        }
        if (!isMounted) return;
        const nextPetAvatarUris = Object.fromEntries(avatarUris);
        const avatarUri = nextPetAvatarUris[activePet.id] ?? '';
        setPetAvatarUris(nextPetAvatarUris);
        setSelectedPetId(activePet.id);
        setPetId(activePet.id);
        setPetProfile({ ...petRowToProfile(activePet), avatarUri });
        setActivities(careRecords.map((record) => careRecordToActivity(record, activePet.name)));
        setAllPetActivities(recordsByPet.flat().sort((left, right) => right.occurredAt - left.occurredAt));
        setWalkSessions(walksByPet.flat().sort((left, right) => new Date(right.started_at).getTime() - new Date(left.started_at).getTime()));
        setMedicationPlans(mappedPlans);
        setPreventiveCareSchedules(storedPreventiveCare);
        setMedicationReminders(storedReminders.map((row) => medicationReminderRowToReminder(row, mappedPlans)));
        setPetDataStatus('ready');
        void cacheOfflineAccountContext(authSession.user.id, {
          profileId: profile.id,
          displayName: profile.display_name?.trim() || fallbackName,
          pets,
          selectedPetId: activePet.id,
        });
      } catch (error) {
        if (!isMounted) return;
        const cachedContext = await loadOfflineAccountContext(authSession.user.id).catch(() => null);
        if (!isMounted) return;
        const cachedPet = cachedContext?.pets.find((pet) => pet.id === cachedContext.selectedPetId)
          ?? cachedContext?.pets[0];
        if (cachedContext && cachedPet) {
          setCurrentProfileId(cachedContext.profileId);
          setAccountDisplayName(cachedContext.displayName);
          setPets(cachedContext.pets);
          setSelectedPetId(cachedPet.id);
          setPetId(cachedPet.id);
          setPetProfile(petRowToProfile(cachedPet));
          setActivities([]);
          setAllPetActivities([]);
          setWalkSessions([]);
          setMedicationPlans([]);
          setMedicationReminders([]);
          setPreventiveCareSchedules([]);
          setPetDataStatus('ready');
          return;
        }
        setPetDataError(error instanceof Error ? error.message : '無法載入寵物資料。');
        setPetDataStatus('error');
      }
    };

    void loadPetData();
    return () => {
      isMounted = false;
    };
  }, [authSession, isPreviewMode, petDataReloadKey, selectedPetId]);

  const selectedPet = pets.find((pet) => pet.id === petId) ?? null;

  useEffect(() => {
    if (!petId) {
      setPendingSmartBinSession(null);
      return;
    }
    const actorId = authSession?.user.id ?? (isPreviewMode ? 'preview-user' : null);
    setPendingSmartBinSession(actorId ? loadSmartBinSession(actorId, petId) : null);
  }, [authSession?.user.id, isPreviewMode, petId, showSmartBinSimulator]);
  const selectedOwnerId = selectedPet?.owner_id ?? currentProfileId;

  useEffect(() => {
    if (!authSession || isPreviewMode || !petId || medicationPlans.length === 0) return undefined;
    let isActive = true;
    const sync = async () => {
      try {
        const rows = await refreshMedicationReminders(petId);
        if (isActive) setMedicationReminders(rows.map((row) => medicationReminderRowToReminder(row, medicationPlans)));
      } catch {
        // 下次定時刷新或 App 回到前景時重試。
      }
    };
    void sync();
    const timer = setInterval(() => void sync(), 60_000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void sync();
    });
    return () => {
      isActive = false;
      clearInterval(timer);
      subscription.remove();
    };
  }, [authSession, isPreviewMode, petId, medicationPlans]);

  useEffect(() => {
    const missed = medicationReminders.find((item) => item.status === 'overdue' && !promptedOverdueReminderIds.current.has(item.id));
    if (!missed || !authSession || isPreviewMode) return;
    promptedOverdueReminderIds.current.add(missed.id);
    Alert.alert(
      '有一筆用藥尚未確認',
      `${missed.when} ${missed.time} 的「${missed.title} ${missed.dose}」有服用嗎？\n\n是否需要補服請依獸醫或藥袋指示，App 僅協助記錄。`,
      [
        {
          text: '稍後確認',
          style: 'cancel',
          onPress: () => setTimeout(() => promptedOverdueReminderIds.current.delete(missed.id), 30 * 60 * 1000),
        },
        {
          text: '沒有服用',
          style: 'destructive',
          onPress: () => void resolveMissedMedicationReminder(missed.id, false)
            .then(() => refreshMedicationReminders(petId!))
            .then((rows) => setMedicationReminders(rows.map((row) => medicationReminderRowToReminder(row, medicationPlans))))
            .catch((error) => Alert.alert('更新失敗', error instanceof Error ? error.message : '無法記錄未服用狀態。')),
        },
        {
          text: '有服用',
          onPress: () => void resolveMissedMedicationReminder(missed.id, true, new Date(missed.scheduledAt).toISOString())
            .then(() => Promise.all([refreshMedicationReminders(petId!), listCareRecords(selectedOwnerId, petId!, 500)]))
            .then(([rows, records]) => {
              setMedicationReminders(rows.map((row) => medicationReminderRowToReminder(row, medicationPlans)));
              const mappedRecords = records.map((record) => careRecordToActivity(record, petProfile?.name));
              setActivities(mappedRecords);
              setAllPetActivities((current) => [
                ...current.filter((item) => item.petId !== petId),
                ...mappedRecords,
              ].sort((left, right) => right.occurredAt - left.occurredAt));
            })
            .catch((error) => Alert.alert('更新失敗', error instanceof Error ? error.message : '無法補登服藥紀錄。')),
        },
      ],
    );
  }, [medicationReminders, authSession, isPreviewMode, petId, medicationPlans, selectedOwnerId, petProfile?.name]);

  const completePreventiveCareToday = async (schedule: PreventiveCareScheduleRow) => {
    if (isPreviewMode) {
      const today = formatDateValue(new Date());
      setPreventiveCareSchedules((current) => current.map((item) => item.id === schedule.id ? {
        ...item,
        last_completed_on: today,
        next_due_on: addMonthsToDateValue(today, schedule.interval_months),
        updated_at: new Date().toISOString(),
      } : item));
      const occurredAt = Date.now();
      const completedActivity: ActivityRecord = {
        id: `preview-preventive-${occurredAt}`,
        kind: schedule.kind === 'vaccine' ? 'vaccine' : 'medical',
        icon: schedule.kind === 'vaccine' ? '💉' : '🪱',
        title: schedule.title,
        detail: schedule.note || '已完成預防照護。',
        time: formatActivityTime(occurredAt),
        occurredAt,
        tone: schedule.kind === 'vaccine' ? '#E76F77' : '#4F9D85',
        petId: petId ?? undefined,
        ownerId: selectedOwnerId,
        petName: petProfile?.name,
      };
      setActivities((current) => [completedActivity, ...current]);
      setAllPetActivities((current) => [completedActivity, ...current]);
      return;
    }

    const completedSchedule = await completePreventiveCare(schedule.id);
    setPreventiveCareSchedules((current) => current.map((item) => item.id === completedSchedule.id ? completedSchedule : item));
    setPetDataReloadKey((current) => current + 1);
  };

  const refreshAllPetRecords = async () => {
    if (!authSession || isPreviewMode) {
      setAllPetActivities(activities);
      return;
    }
    setIsRefreshingRecords(true);
    try {
      const [recordsByPet, walksByPet] = await Promise.all([
        Promise.all(pets.map(async (pet) => {
          const records = await listCareRecords(pet.owner_id, pet.id, 500);
          return records.map((record) => careRecordToActivity(record, pet.name));
        })),
        Promise.all(pets.map(async (pet) => {
          try {
            const walks = await listWalkSessions(pet.id, 30);
            return walks.map((walk) => ({ ...walk, petName: pet.name }));
          } catch (walkError) {
            console.warn('Unable to refresh walk sessions during schema rollout.', walkError);
            return [];
          }
        })),
      ]);
      const combined = recordsByPet.flat().sort((left, right) => right.occurredAt - left.occurredAt);
      setAllPetActivities(combined);
      setWalkSessions(walksByPet.flat().sort((left, right) => new Date(right.started_at).getTime() - new Date(left.started_at).getTime()));
      if (selectedPet) setActivities(combined.filter((item) => item.petId === selectedPet.id));
    } catch (error) {
      Alert.alert('刷新失敗', error instanceof Error ? error.message : '無法重新載入雲端記錄。');
    } finally {
      setIsRefreshingRecords(false);
    }
  };

  const refreshOfflineState = useCallback(async () => {
    const authUserId = authSession?.user.id;
    if (!authUserId || isPreviewMode) {
      setOfflineActivities([]);
      setOfflineSummary({ pending: 0, syncing: 0, failed: 0 });
      return;
    }
    const [rows, summary] = await Promise.all([
      listOfflineCareRecords(authUserId),
      getOfflineQueueSummary(authUserId),
    ]);
    setOfflineActivities(rows.map(offlineQueueRowToActivity).filter((item): item is ActivityRecord => item !== null));
    setOfflineSummary(summary);
  }, [authSession?.user.id, isPreviewMode]);

  const runOfflineSync = useCallback(async (force = false) => {
    const authUserId = authSession?.user.id;
    if (!authUserId || !currentProfileId || isPreviewMode || !offlineSettingsReady || offlineSyncInFlight.current) return;
    const connected = networkState?.isConnected === true && networkState.isInternetReachable !== false;
    if (!connected) return;
    if (!force && offlineSyncMode === 'manual') return;
    if (!force && offlineSyncMode === 'wifi' && networkState?.type !== 'wifi') return;

    offlineSyncInFlight.current = true;
    setIsSyncingOffline(true);
    try {
      const syncedRecords = await syncOfflineCareQueue(authUserId, currentProfileId);
      if (activeAuthUserIdRef.current !== authUserId) return;
      if (syncedRecords.length > 0) {
        const mapped = syncedRecords.map((record) => careRecordToActivity(
          record,
          pets.find((pet) => pet.id === record.pet_id)?.name,
        ));
        setAllPetActivities((current) => [
          ...mapped,
          ...current.filter((item) => !mapped.some((synced) => synced.id === item.id)),
        ].sort((left, right) => right.occurredAt - left.occurredAt));
        setActivities((current) => [
          ...mapped.filter((item) => item.petId === petId),
          ...current.filter((item) => !mapped.some((synced) => synced.id === item.id)),
        ].sort((left, right) => right.occurredAt - left.occurredAt));
      }
    } finally {
      if (activeAuthUserIdRef.current === authUserId) await refreshOfflineState();
      offlineSyncInFlight.current = false;
      setIsSyncingOffline(false);
    }
  }, [authSession?.user.id, currentProfileId, isPreviewMode, networkState, offlineSettingsReady, offlineSyncMode, petId, pets, refreshOfflineState]);

  useEffect(() => {
    const authUserId = authSession?.user.id;
    if (!authUserId || !currentProfileId || isPreviewMode) return;
    void Promise.all([
      getOfflineSyncMode(authUserId),
      hasSeenOfflineDisclosure(authUserId),
      refreshOfflineState(),
    ]).then(([mode, seen]) => {
      setOfflineSyncMode(mode);
      setShowOfflineDisclosure(!seen);
      setOfflineSettingsReady(seen);
    });
  }, [authSession?.user.id, currentProfileId, isPreviewMode, refreshOfflineState]);

  useEffect(() => {
    if (!authSession || !currentProfileId || isPreviewMode) return undefined;
    void runOfflineSync();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void runOfflineSync();
    });
    return () => subscription.remove();
  }, [authSession?.user.id, currentProfileId, isPreviewMode, networkState?.isConnected, networkState?.isInternetReachable, networkState?.type, offlineSyncMode, runOfflineSync]);

  const visibleActivities = useMemo(() => [
    ...offlineActivities.filter((item) => item.petId === petId),
    ...activities,
  ].sort((left, right) => right.occurredAt - left.occurredAt), [activities, offlineActivities, petId]);

  const visibleAllPetActivities = useMemo(() => [
    ...offlineActivities,
    ...(allPetActivities.length > 0 ? allPetActivities : activities),
  ].sort((left, right) => right.occurredAt - left.occurredAt), [activities, allPetActivities, offlineActivities]);

  const dailyStats = useMemo(() => {
    const todayValue = formatDateValue(new Date());
    return visibleActivities.reduce(
      (stats, activity) => {
        if (formatDateValue(new Date(activity.occurredAt)) !== todayValue) return stats;
        if (activity.kind === 'meal') stats.meals += 1;
        if (activity.kind === 'water') stats.waterMl += activity.amount ?? 0;
        if (activity.kind === 'stool') stats.stools += 1;
        if (activity.kind === 'urine') stats.urines += 1;
        return stats;
      },
      { meals: 0, waterMl: 0, stools: 0, urines: 0 },
    );
  }, [visibleActivities]);

  const openQuickAdd = (action?: QuickAction) => {
    if (action?.kind === 'stool') {
      setShowStoolRecordMethod(true);
      return;
    }
    setInitialQuickAction(action ?? null);
    setShowQuickAdd(true);
  };

  const openManualStoolRecord = () => {
    const stoolAction = quickActions.find((action) => action.kind === 'stool') ?? null;
    setShowStoolRecordMethod(false);
    setInitialQuickAction(stoolAction);
    setShowQuickAdd(true);
  };

  const openStoolGallery = async () => {
    if (!featureFlags.stoolGalleryUpload) return;
    if (isPreviewMode) {
      Alert.alert('預覽模式不會上傳', '請登入測試帳號後再從相簿選擇照片進行真正辨識。');
      return;
    }
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('需要相簿權限', '請允許讀取你選擇的照片，才能送出便便辨識。');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 1,
      });
      const asset = result.canceled ? null : result.assets[0];
      if (!asset?.uri) return;
      if (!asset.width || !asset.height) throw new Error('gallery_image_size_unavailable');
      const prepared = await prepareStoolRoiImage(
        asset.uri,
        calculateCenteredSquareCrop({ width: asset.width, height: asset.height }),
      );
      setPendingStoolGalleryImage({ uri: prepared.uri, selectedAt: new Date().toISOString() });
      setShowStoolRecordMethod(false);
      setShowStoolCamera(true);
    } catch {
      Alert.alert('無法取得照片', '目前無法開啟相簿，請確認權限後再試一次。');
    }
  };

  const addActivity = async (input: ActivityInput) => {
    const occurredAt = Date.now();
    const newRecord: ActivityRecord = {
      ...input,
      id: Date.now().toString(),
      time: formatActivityTime(occurredAt),
      occurredAt,
      petId: petId ?? undefined,
      ownerId: selectedOwnerId || undefined,
      petName: petProfile?.name,
    };

    if (!authSession || isPreviewMode) {
      setActivities((current) => [newRecord, ...current]);
      setAllPetActivities((current) => [newRecord, ...current]);
      setShowQuickAdd(false);
      return;
    }

    if (input.kind === 'meal' || input.kind === 'water' || input.kind === 'stool' || input.kind === 'urine') {
      try {
        await enqueueOfflineCareRecord({
          authUserId: authSession.user.id,
          profileId: currentProfileId,
          ownerId: selectedOwnerId,
          petId: petId!,
          petName: petProfile?.name ?? '',
          kind: input.kind,
          occurredAt: new Date(occurredAt).toISOString(),
          payload: {
            title: input.title,
            note: input.note ?? null,
            amount: input.amount ?? null,
            unit: input.unit ?? null,
            food_type: input.foodType ?? null,
            stool_texture: input.stoolTexture ?? null,
            stool_color: input.stoolColor ?? null,
            stool_status: input.stoolStatus ?? null,
            urine_color: input.urineColor ?? null,
            metadata: { structured_form_version: 1 },
          },
        });
        setShowQuickAdd(false);
        await refreshOfflineState();
        void runOfflineSync();
      } catch (error) {
        Alert.alert('無法儲存記錄', error instanceof Error ? error.message : '本機儲存失敗，尚未建立這筆記錄。');
      }
      return;
    }

    try {
      const storedRecord = await createCareRecord({
        owner_id: selectedOwnerId,
        pet_id: petId!,
        kind: input.kind,
        title: input.title,
        note: input.note ?? null,
        amount: input.amount,
        unit: input.unit ?? null,
        food_type: input.foodType ?? null,
        medication_name: input.medicationName ?? null,
        medication_dose: input.medicationDose ?? null,
        stool_texture: input.stoolTexture ?? null,
        stool_color: input.stoolColor ?? null,
        stool_status: input.stoolStatus ?? null,
        urine_color: input.urineColor ?? null,
        metadata: { structured_form_version: 1 },
      });
      const mappedRecord = careRecordToActivity(storedRecord, petProfile?.name);
      setActivities((current) => [mappedRecord, ...current]);
      setAllPetActivities((current) => [mappedRecord, ...current]);
      setShowQuickAdd(false);
    } catch (error) {
      Alert.alert('記錄失敗', error instanceof Error ? error.message : '無法將資料上傳到雲端。');
    }
  };

  const completeMedicationReminder = async () => {
    const completedReminder = medicationReminders.find((item) => item.status === 'pending') ?? medicationReminders[0];
    if (!completedReminder) return;

    const completionOpensAt = getMedicationCompletionOpensAt(completedReminder);
    if (Date.now() < completionOpensAt.getTime()) {
      Alert.alert(
        '尚未開放完成',
        `請於用藥時間前 30 分鐘（${String(completionOpensAt.getHours()).padStart(2, '0')}:${String(completionOpensAt.getMinutes()).padStart(2, '0')}）後再標記完成。`,
      );
      return;
    }

    if (authSession && !isPreviewMode) {
      try {
        await completeStoredMedicationReminder(completedReminder.id);
        const [storedReminders, storedRecords] = await Promise.all([
          refreshMedicationReminders(petId!),
          listCareRecords(selectedOwnerId, petId!, 500),
        ]);
        setMedicationReminders(storedReminders.map((row) => medicationReminderRowToReminder(row, medicationPlans)));
        const mappedRecords = storedRecords.map((record) => careRecordToActivity(record, petProfile?.name));
        setActivities(mappedRecords);
        setAllPetActivities((current) => [
          ...current.filter((item) => item.petId !== petId),
          ...mappedRecords,
        ].sort((left, right) => right.occurredAt - left.occurredAt));
        Alert.alert('已記錄服藥', `實際完成時間：${formatActivityTime(Date.now())}`);
      } catch (error) {
        Alert.alert('完成失敗', error instanceof Error ? error.message : '無法更新用藥提醒。');
      }
      return;
    }

    const remainingReminders = medicationReminders.slice(1);
    setMedicationReminders(remainingReminders);
    setCompletedMedicationReminderIds((current) => [...current, completedReminder.id]);
    const occurredAt = Date.now();
    setActivities((current) => [
      {
        id: `reminder-${completedReminder.id}-${Date.now()}`,
        kind: 'medication',
        icon: '💊',
        title: completedReminder.title,
        detail: `${completedReminder.dose}・由藥物提醒完成`,
        time: formatActivityTime(occurredAt),
        occurredAt,
        tone: '#8B7BCF',
      },
      ...current,
    ]);

    const nextReminder = remainingReminders[0];
    Alert.alert(
      '已完成並建立用藥紀錄',
      nextReminder
        ? `下一個提醒：${nextReminder.when} ${nextReminder.time}・${nextReminder.title} ${nextReminder.dose}`
        : '目前沒有其他待完成的用藥提醒。',
    );
  };

  const addMedicationPlan = async (plan: MedicationPlan) => {
    if (authSession && !isPreviewMode) {
      const storedPlan = await createMedicationPlan({
        owner_id: selectedOwnerId,
        pet_id: petId!,
        title: plan.title,
        dose: plan.dose,
        dose_amount: plan.doseAmount,
        dose_unit: plan.doseUnit,
        times: plan.times,
        start_date: plan.startDate,
        end_date: plan.endDate,
        instruction: plan.instruction,
        note: plan.note || null,
        timezone: 'Asia/Taipei',
        client_request_key: plan.id,
      });
      const nextPlans = [...medicationPlans, medicationPlanRowToPlan(storedPlan)];
      setMedicationPlans(nextPlans);
      const reminders = await refreshMedicationReminders(petId!);
      setMedicationReminders(reminders.map((row) => medicationReminderRowToReminder(row, nextPlans)));
      return;
    }
    setMedicationPlans((current) => [...current, plan]);
    setMedicationReminders((current) => [...current, ...buildMedicationReminders(plan)].sort((a, b) => a.scheduledAt - b.scheduledAt));
  };

  const toggleMedicationPlan = async (planId: string) => {
    const plan = medicationPlans.find((item) => item.id === planId);
    if (!plan) return;

    const nextPlan = { ...plan, active: !plan.active };
    if (authSession && !isPreviewMode) {
      const storedPlan = await updateMedicationPlan(selectedOwnerId, petId!, planId, { is_active: nextPlan.active });
      const nextPlans = medicationPlans.map((item) => item.id === planId ? medicationPlanRowToPlan(storedPlan) : item);
      setMedicationPlans(nextPlans);
      const reminders = await refreshMedicationReminders(petId!);
      setMedicationReminders(reminders.map((row) => medicationReminderRowToReminder(row, nextPlans)));
      return;
    }
    setMedicationPlans((current) => current.map((item) => item.id === planId ? nextPlan : item));
    if (!nextPlan.active) {
      setMedicationReminders((current) => current.filter((reminder) => reminder.planId !== planId));
      return;
    }

    setMedicationReminders((current) => (
      [...current, ...buildMedicationReminders(nextPlan)]
        .filter((reminder) => !completedMedicationReminderIds.includes(reminder.id))
        .filter((reminder, index, all) => all.findIndex((item) => item.id === reminder.id) === index)
        .sort((left, right) => left.scheduledAt - right.scheduledAt)
    ));
  };

  const createFirstPet = async (value: PetOnboardingValue) => {
    if (isPreviewMode && !authSession) {
      const previewTimestamp = new Date().toISOString();
      const previewPet: PetRow = {
        id: 'preview-pet',
        owner_id: 'preview-user',
        name: value.name,
        species: 'dog',
        breed: value.breed,
        sex: value.sex === '公' ? 'male' : value.sex === '母' ? 'female' : 'unknown',
        sterilization_status: value.sterilizationStatus === '已絕育' ? 'sterilized' : value.sterilizationStatus === '未絕育' ? 'not_sterilized' : 'unknown',
        birthday: value.birthday,
        weight_kg: Number(value.weightKg),
        meals_per_day: value.mealsPerDay,
        water_goal_ml: value.waterGoalMl,
        avatar_icon: value.avatarIcon,
        avatar_path: null,
        archived_at: null,
        created_at: previewTimestamp,
        updated_at: previewTimestamp,
      };
      setPetProfile(onboardingValueToProfile(value));
      setPetId(previewPet.id);
      setSelectedPetId(previewPet.id);
      setPets([previewPet]);
      setActivities([]);
      setWalkSessions([]);
      setMedicationPlans([]);
      setMedicationReminders([]);
      setPreventiveCareSchedules([]);
      setPetDataStatus('ready');
      return;
    }

    if (!authSession) throw new Error('登入狀態已失效，請重新登入。');
    if (!currentProfileId) throw new Error('尚未載入帳號 ID，請稍後再試。');
    const pet = await createPet({
      owner_id: currentProfileId,
      name: value.name,
      breed: value.breed,
      sex: value.sex === '公' ? 'male' : value.sex === '母' ? 'female' : 'unknown',
      sterilization_status: value.sterilizationStatus === '已絕育' ? 'sterilized' : value.sterilizationStatus === '未絕育' ? 'not_sterilized' : 'unknown',
      birthday: value.birthday,
      weight_kg: Number(value.weightKg),
      meals_per_day: value.mealsPerDay,
      water_goal_ml: value.waterGoalMl,
      avatar_icon: value.avatarIcon,
    });
    setPetProfile(petRowToProfile(pet));
    setPetId(pet.id);
    setSelectedPetId(pet.id);
    setPets((current) => sortPetsForProfile([...current, pet], currentProfileId));
    setShowAddPet(false);
    setActivities([]);
    setMedicationPlans([]);
    setMedicationReminders([]);
    setPreventiveCareSchedules([]);
    setPetDataStatus('ready');
  };

  const signOut = async () => {
    try {
      if (authSession && supabase) await supabase.auth.signOut();
    } finally {
      setIsPreviewMode(false);
      setAuthSession(null);
      setCurrentProfileId('');
      setActiveTab('home');
      setShowStoolRecordMethod(false);
      setShowStoolCamera(false);
      setActivities([]);
      setOfflineActivities([]);
      setOfflineSummary({ pending: 0, syncing: 0, failed: 0 });
      setOfflineSettingsReady(false);
      setShowOfflineDisclosure(false);
      setPetProfile(null);
      setPetId(null);
      setPets([]);
      setPetAvatarUris({});
      setSelectedPetId(null);
      setPendingInvitations([]);
      setMedicationPlans([]);
      setMedicationReminders([]);
      setPreventiveCareSchedules([]);
      setCompletedMedicationReminderIds([]);
      setPetDataStatus('idle');
    }
  };

  if (authSession === undefined) {
    return <AuthLoadingScreen />;
  }

  if (!authSession && !isPreviewMode) {
    return (
      <AuthScreen
        onAuthenticated={setAuthSession}
        onPreview={__DEV__ ? () => setIsPreviewMode(true) : undefined}
      />
    );
  }

  if (petDataStatus === 'idle' || petDataStatus === 'loading') {
    return <AuthLoadingScreen />;
  }

  if (petDataStatus === 'error') {
    return (
      <PetDataErrorScreen
        message={petDataError}
        onRetry={() => setPetDataReloadKey((current) => current + 1)}
        onSignOut={signOut}
      />
    );
  }

  if (showAddPet) {
    return <PetOnboardingScreen isPreview={isPreviewMode} progressLabel="新增犬隻" onCreate={createFirstPet} onBack={() => setShowAddPet(false)} />;
  }

  if (petDataStatus === 'needsPet' || !petProfile || !petId) {
    if (petEntryStep === 'join') {
      return (
        <JoinExistingPetScreen
          invitations={pendingInvitations}
          isPreview={isPreviewMode}
          onBack={() => setPetEntryStep('choice')}
          onAcceptInvitation={async (invitationId) => {
            await acceptPetInvitation(invitationId);
            setPendingInvitations((current) => current.filter((item) => item.id !== invitationId));
            setPetEntryStep('choice');
            setPetDataReloadKey((current) => current + 1);
          }}
          onAcceptCode={async (joinCode) => {
            await acceptPetInvitationCode(joinCode);
            setPendingInvitations([]);
            setPetEntryStep('choice');
            setPetDataReloadKey((current) => current + 1);
          }}
        />
      );
    }
    if (petEntryStep === 'create') {
      return <PetOnboardingScreen isPreview={isPreviewMode} progressLabel="步驟 2/2" onCreate={createFirstPet} onBack={() => setPetEntryStep('choice')} />;
    }
    return <PetEntryChoiceScreen onBack={signOut} onJoin={() => setPetEntryStep('join')} onCreate={() => setPetEntryStep('create')} />;
  }

  if (showStoolReviewer) {
    return (
      <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.safeArea}>
        <StatusBar style="dark" />
        <View style={styles.appShell}>
          <StoolReviewScreen onClose={() => setShowStoolReviewer(false)} />
        </View>
      </SafeAreaView>
    );
  }

  if (showWalkFlow && selectedPet) {
    return (
      <View style={styles.safeArea}>
        <StatusBar style="dark" />
        <View style={styles.appShell}>
          <WalkFlow
            pet={selectedPet}
            isPreview={isPreviewMode}
            onClose={() => setShowWalkFlow(false)}
            onSaved={() => void refreshAllPetRecords()}
          />
        </View>
      </View>
    );
  }

  if (showSmartBinSimulator && selectedPet) {
    const actorId = authSession?.user.id ?? 'preview-user';
    return (
      <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.safeArea}>
        <StatusBar style="dark" />
        <View style={styles.appShell}>
          <SmartBinSimulator
            actorId={actorId}
            petId={selectedPet.id}
            petName={selectedPet.name}
            observationId={pendingSmartBinSession?.observationId ?? smartBinObservationId ?? 'simulated-observation'}
            onExit={(session) => {
              setPendingSmartBinSession(session?.stage === 'completed' ? null : session);
              setShowSmartBinSimulator(false);
              setActiveTab('home');
            }}
            onFinished={async (session) => {
              if (!authSession || isPreviewMode) {
                throw new Error('請使用已登入的測試帳號完成模擬投放紀錄。');
              }
              try {
                const existing = await findCareRecordBySmartBinSession(selectedPet.owner_id, selectedPet.id, session.id);
                const stored = existing ?? await createCareRecord({
                  owner_id: selectedPet.owner_id,
                  pet_id: selectedPet.id,
                  kind: 'stool',
                  source: 'manual',
                  title: '便便投放（模擬流程）',
                  note: '由測試帳號完成模擬智能便便垃圾桶流程後自動建立；不代表設備量測、人工確認或 AI 健康判斷。',
                  metadata: {
                    schema_version: 1,
                    record_origin: 'simulated_smart_bin_flow',
                    simulation: true,
                    training_eligible: false,
                    smart_bin_session_id: session.id,
                    stool_observation_id: session.observationId,
                    smart_bin_id: session.binId,
                    smart_bin_name: session.binName,
                    device_event_sequence: ['unlock_confirmed', 'hatch_opened', 'hatch_closed', 'latch_locked'],
                  },
                });
                const activity = careRecordToActivity(stored, selectedPet.name);
                setActivities((current) => [activity, ...current.filter((item) => item.id !== activity.id)]);
                setAllPetActivities((current) => [activity, ...current.filter((item) => item.id !== activity.id)]);
              } catch (cause) {
                throw new Error(cause instanceof Error ? `便便紀錄保存失敗：${cause.message}` : '便便紀錄保存失敗，請檢查網路後重試。');
              }
            }}
            onCompleted={() => {
              setPendingSmartBinSession(null);
              setShowSmartBinSimulator(false);
              setActiveTab('home');
            }}
          />
        </View>
      </SafeAreaView>
    );
  }

  if (showStoolCamera && selectedPet) {
    return (
      <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.safeArea}>
        <StatusBar style="dark" />
        <View style={styles.appShell}>
          <CameraScreen
            pet={selectedPet}
            isPreview={isPreviewMode}
            initialPhotoUri={pendingStoolGalleryImage?.uri ?? null}
            initialCapturedAt={pendingStoolGalleryImage?.selectedAt ?? null}
            initialCaptureMethod={pendingStoolGalleryImage ? 'gallery_upload' : 'live_camera'}
            onClose={() => {
              setPendingStoolGalleryImage(null);
              setShowStoolCamera(false);
              setShowStoolRecordMethod(true);
            }}
            onReturnHome={() => {
              setPendingStoolGalleryImage(null);
              setShowStoolCamera(false);
              setShowStoolRecordMethod(false);
              setActiveTab('home');
            }}
            onStartSmartBin={(observationId) => {
              setPendingSmartBinSession(null);
              setSmartBinObservationId(observationId);
              setPendingStoolGalleryImage(null);
              setShowStoolCamera(false);
              setShowStoolRecordMethod(false);
              setShowSmartBinSimulator(true);
            }}
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.appShell}>
        <View style={styles.content}>
          {activeTab === 'home' && (
            <HomeScreen
              activities={visibleActivities}
              preventiveCareSchedules={preventiveCareSchedules}
              petProfile={petProfile}
              displayName={accountDisplayName || '飼主'}
              dailyStats={dailyStats}
              medicationReminder={medicationReminders.find((item) => item.status === 'pending') ?? medicationReminders[0] ?? null}
              onCompleteMedication={completeMedicationReminder}
              onManageMedication={() => setShowMedicationManager(true)}
              onAdd={openQuickAdd}
              onEditPet={() => setShowPetSettings(true)}
              onSelectPet={() => setShowPetSwitcher(true)}
              petCount={pets.length}
              onWalk={() => setShowWalkFlow(true)}
              onAllRecords={tabAvailability.records ? () => setActiveTab('records') : undefined}
              onMessages={() => {
                setShowMessages(true);
                void refreshPendingInvitations();
              }}
              messageCount={pendingInvitations.length}
              isRefreshing={isRefreshingRecords}
              onRefresh={() => void refreshAllPetRecords()}
              onManagePreventiveCare={(kind) => {
                setEditingPreventiveCareKind(kind);
              }}
              onCompletePreventiveCare={completePreventiveCareToday}
              pendingSmartBinSession={pendingSmartBinSession}
              onResumeSmartBin={() => setShowSmartBinSimulator(true)}
            />
          )}
          {activeTab === 'records' && tabAvailability.records && (
            <RecordsScreen
              activities={visibleAllPetActivities}
              walks={walkSessions}
              pets={pets}
              selectedPetId={petId}
              isRefreshing={isRefreshingRecords}
              offlineSummary={offlineSummary}
              offlineSyncMode={offlineSyncMode}
              isOnline={networkState?.isConnected === true && networkState.isInternetReachable !== false}
              isSyncingOffline={isSyncingOffline}
              onSyncOffline={() => void runOfflineSync(true)}
              onChangeOfflineSyncMode={(mode) => {
                if (!authSession) return;
                setOfflineSyncMode(mode);
                setOfflineSettingsReady(true);
                void persistOfflineSyncMode(authSession.user.id, mode);
              }}
              onRefresh={() => void refreshAllPetRecords()}
              onAdd={() => openQuickAdd()}
              onUpdate={async (activityId, changes) => {
                try {
                  const target = (allPetActivities.length > 0 ? allPetActivities : activities).find((item) => item.id === activityId);
                  if (!target) throw new Error('找不到要修改的記錄，請先刷新後再試。');
                  let updatedActivity: ActivityRecord;
                  if (authSession && !isPreviewMode) {
                    const storedRecord = await updateCareRecord(target.ownerId ?? selectedOwnerId, target.petId ?? petId, activityId, {
                      title: changes.title,
                      note: changes.note ?? null,
                      amount: changes.amount ?? null,
                      unit: changes.unit ?? null,
                      food_type: changes.foodType ?? null,
                      medication_name: changes.medicationName ?? null,
                      medication_dose: changes.medicationDose ?? null,
                      stool_texture: changes.stoolTexture ?? null,
                      stool_color: changes.stoolColor ?? null,
                      stool_status: changes.stoolStatus ?? null,
                      urine_color: changes.urineColor ?? null,
                      metadata: {
                        ...(target.metadata && typeof target.metadata === 'object' && !Array.isArray(target.metadata) ? target.metadata : {}),
                        structured_form_version: 1,
                      },
                    });
                    updatedActivity = careRecordToActivity(storedRecord, target.petName);
                  } else {
                    updatedActivity = { ...target, ...changes };
                  }
                  setActivities((current) => current.map((activity) => activity.id === activityId ? updatedActivity : activity));
                  setAllPetActivities((current) => current.map((activity) => activity.id === activityId ? updatedActivity : activity));
                } catch (error) {
                  Alert.alert('修改失敗', error instanceof Error ? error.message : '無法更新雲端記錄。');
                  throw error;
                }
              }}
              onDelete={(activityId) => {
                void (async () => {
                  try {
                    const target = (allPetActivities.length > 0 ? allPetActivities : activities).find((item) => item.id === activityId);
                    if (authSession && !isPreviewMode) {
                      await deleteCareRecord(target?.ownerId ?? selectedOwnerId, target?.petId ?? petId, activityId);
                    }
                    setActivities((current) => current.filter((activity) => activity.id !== activityId));
                    setAllPetActivities((current) => current.filter((activity) => activity.id !== activityId));
                  } catch (error) {
                    Alert.alert('刪除失敗', error instanceof Error ? error.message : '無法刪除雲端記錄。');
                  }
                })();
              }}
            />
          )}
          {activeTab === 'medical' && tabAvailability.medical && (
            <MedicalCenterScreen
              embeddedInTab
              pet={{
                id: petId,
                ownerId: selectedOwnerId,
                name: petProfile.name,
                avatarIcon: petProfile.avatarIcon,
              }}
              avatarUri={petAvatarUris[petId] ?? petProfile.avatarUri}
              currentProfileId={currentProfileId}
              isPreview={isPreviewMode}
              canSwitchPet={pets.length > 1}
              onSwitchPet={() => setShowPetSwitcher(true)}
            />
          )}
          {activeTab === 'profile' && (
            <ProfileScreen
              accountEmail={isPreviewMode ? '開發預覽模式' : authSession?.user.email ?? ''}
              displayName={accountDisplayName || '飼主'}
              petProfile={petProfile}
              onEditAccount={() => setShowAccountSettings(true)}
              onEditPet={() => setShowPetSettings(true)}
              onReviewStool={isStoolReviewer ? () => setShowStoolReviewer(true) : undefined}
              onManageMedication={() => setShowMedicationManager(true)}
              onManageCollaboration={() => setShowCollaboration(true)}
              onAddPet={() => setShowAddPet(true)}
              onSignOut={signOut}
            />
          )}
        </View>

        <View
          style={[
            styles.tabBar,
            {
              minHeight: tabBarContentHeight + safeAreaInsets.bottom,
              paddingBottom: safeAreaInsets.bottom,
            },
          ]}
        >
          {enabledTabs.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={tab.label}
                key={tab.key}
                onPress={() => setActiveTab(tab.key)}
                style={styles.tabItem}
              >
                <View style={[styles.tabIconWrap, isActive && styles.tabIconWrapActive]}>
                  <Text style={[styles.tabIcon, isActive && styles.tabIconActive]}>{tab.icon}</Text>
                </View>
                <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>{tab.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      <QuickAddModal
        visible={showQuickAdd}
        initialAction={initialQuickAction}
        onClose={() => setShowQuickAdd(false)}
        onSave={addActivity}
        onRequestStoolMethod={() => {
          setShowQuickAdd(false);
          setShowStoolRecordMethod(true);
        }}
      />
      <StoolRecordMethodModal
        visible={showStoolRecordMethod}
        petProfile={petProfile}
        onClose={() => setShowStoolRecordMethod(false)}
        onCamera={() => {
          setPendingStoolGalleryImage(null);
          setShowStoolRecordMethod(false);
          setShowStoolCamera(true);
        }}
        onGallery={() => void openStoolGallery()}
        onManual={openManualStoolRecord}
      />
      <PetSettingsModal
        visible={showPetSettings}
        profile={petProfile}
        onClose={() => setShowPetSettings(false)}
        onSave={(profile) => {
          void (async () => {
            try {
              if (authSession && !isPreviewMode) {
                const oldAvatarPath = selectedPet?.avatar_path ?? null;
                let avatarPath = oldAvatarPath;
                let avatarUri = profile.avatarUri;

                if (profile.avatarUri && profile.avatarPath !== oldAvatarPath) {
                  avatarPath = await uploadPetAvatar({
                    ownerId: selectedOwnerId,
                    petId,
                    uri: profile.avatarUri,
                  });
                  avatarUri = await createPetAvatarSignedUrl(avatarPath);
                } else if (!profile.avatarUri && !profile.avatarPath) {
                  avatarPath = null;
                }

                const updatedPet = await updatePet(selectedOwnerId, petId, {
                  name: profile.name,
                  breed: profile.breed,
                  sex: profile.sex === '公' ? 'male' : profile.sex === '母' ? 'female' : 'unknown',
                  sterilization_status: profile.sterilizationStatus === '已絕育' ? 'sterilized' : profile.sterilizationStatus === '未絕育' ? 'not_sterilized' : 'unknown',
                  weight_kg: profile.weightKg ? Number(profile.weightKg) : null,
                  meals_per_day: profile.mealsPerDay,
                  water_goal_ml: profile.waterGoalMl,
                  avatar_icon: profile.avatarIcon,
                  avatar_path: avatarPath,
                });
                setPets((current) => current.map((pet) => pet.id === updatedPet.id ? updatedPet : pet));
                setPetAvatarUris((current) => ({ ...current, [updatedPet.id]: avatarUri }));
                if (oldAvatarPath && oldAvatarPath !== avatarPath) {
                  void deletePetMedia(oldAvatarPath).catch(() => undefined);
                }
                profile = { ...profile, avatarPath: avatarPath ?? '', avatarUri };
              }
              setPetProfile(profile);
              setShowPetSettings(false);
            } catch (error) {
              Alert.alert('儲存失敗', error instanceof Error ? error.message : '無法更新寵物資料。');
            }
          })();
        }}
      />
      <PreventiveCareModal
        key={editingPreventiveCareKind ?? 'closed'}
        visible={editingPreventiveCareKind !== null}
        initialKind={editingPreventiveCareKind ?? 'deworming'}
        schedules={preventiveCareSchedules}
        ownerId={selectedOwnerId}
        petId={petId}
        onClose={() => setEditingPreventiveCareKind(null)}
        onSave={async (schedule) => {
          const savedSchedule = isPreviewMode
            ? {
                ...schedule,
                id: preventiveCareSchedules.find((item) => item.kind === schedule.kind)?.id ?? `preview-${schedule.kind}`,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              }
            : await savePreventiveCareSchedule(schedule);
          setPreventiveCareSchedules((current) => [
            ...current.filter((item) => item.kind !== savedSchedule.kind),
            savedSchedule,
          ]);
        }}
        onComplete={async (schedule) => {
          if (isPreviewMode) {
            const today = formatDateValue(new Date());
            setPreventiveCareSchedules((current) => current.map((item) => item.id === schedule.id ? {
              ...item,
              last_completed_on: today,
              next_due_on: addMonthsToDateValue(today, schedule.interval_months),
              updated_at: new Date().toISOString(),
            } : item));
            const occurredAt = Date.now();
            const completedActivity: ActivityRecord = {
              id: `preview-preventive-${occurredAt}`,
              kind: schedule.kind === 'vaccine' ? 'vaccine' : 'medical',
              icon: schedule.kind === 'vaccine' ? '💉' : '🩺',
              title: schedule.title,
              detail: schedule.note || '健康排程已完成',
              time: formatActivityTime(occurredAt),
              occurredAt,
              tone: schedule.kind === 'vaccine' ? '#E76F77' : '#4F9D85',
              petId,
              ownerId: selectedOwnerId,
              petName: petProfile.name,
            };
            setActivities((current) => [completedActivity, ...current]);
            setAllPetActivities((current) => [completedActivity, ...current]);
          } else {
            const completedSchedule = await completePreventiveCare(schedule.id);
            setPreventiveCareSchedules((current) => current.map((item) => item.id === completedSchedule.id ? completedSchedule : item));
            setPetDataReloadKey((current) => current + 1);
          }
        }}
      />
      <MedicationManagementModal
        visible={showMedicationManager}
        plans={medicationPlans}
        onClose={() => setShowMedicationManager(false)}
        onAddPlan={addMedicationPlan}
        onTogglePlan={toggleMedicationPlan}
      />
      <PetSwitcherModal
        visible={showPetSwitcher}
        pets={pets}
        avatarUris={petAvatarUris}
        selectedPetId={petId}
        currentUserId={currentProfileId}
        onClose={() => setShowPetSwitcher(false)}
        onSelect={(nextPetId) => {
          setShowPetSwitcher(false);
          setSelectedPetId(nextPetId);
        }}
        onAdd={() => {
          setShowPetSwitcher(false);
          setShowAddPet(true);
        }}
      />
      <AccountSettingsModal
        visible={showAccountSettings}
        displayName={accountDisplayName || '飼主'}
        accountEmail={isPreviewMode ? '開發預覽模式' : authSession?.user.email ?? ''}
        onClose={() => setShowAccountSettings(false)}
        onSave={async (displayName) => {
          if (!authSession || isPreviewMode) {
            setAccountDisplayName(displayName);
            setShowAccountSettings(false);
            return;
          }
          const updatedProfile = await updateMyProfile(authSession.user.id, { display_name: displayName });
          setAccountDisplayName(updatedProfile.display_name?.trim() || displayName);
          setShowAccountSettings(false);
        }}
      />
      {authSession && selectedPet && (
        <CollaborationModal
          visible={showCollaboration}
          currentUserId={currentProfileId}
          currentUserEmail={authSession.user.email ?? ''}
          petId={selectedPet.id}
          petName={selectedPet.name}
          ownerId={selectedPet.owner_id}
          onClose={() => setShowCollaboration(false)}
          onAccessChanged={() => setPetDataReloadKey((current) => current + 1)}
        />
      )}
      {authSession && (
        <MessagesModal
          visible={showMessages}
          invitations={pendingInvitations}
          onClose={() => setShowMessages(false)}
          onAccept={async (invitationId) => {
            await acceptPetInvitation(invitationId);
            setPendingInvitations((current) => current.filter((item) => item.id !== invitationId));
            setPetDataReloadKey((current) => current + 1);
          }}
        />
      )}
      <AppConfirmDialog
        visible={showOfflineDisclosure}
        icon="☁"
        title="離線記錄同步"
        message="飲食、喝水、便便與尿尿會先安全存於這台裝置；連線後可自動上傳，伺服器確認成功才會刪除本機副本。疫苗、驅蟲、用藥與遛狗不包含在內。"
        confirmLabel="使用自動同步"
        cancelLabel="改用手動同步"
        dismissOnBackdropPress={false}
        onConfirm={() => {
          if (!authSession) return;
          setOfflineSyncMode('auto');
          setOfflineSettingsReady(true);
          setShowOfflineDisclosure(false);
          void persistOfflineSyncMode(authSession.user.id, 'auto');
        }}
        onCancel={() => {
          if (!authSession) return;
          setOfflineSyncMode('manual');
          setOfflineSettingsReady(true);
          setShowOfflineDisclosure(false);
          void acknowledgeOfflineDisclosure(authSession.user.id).then(() => persistOfflineSyncMode(authSession.user.id, 'manual'));
        }}
      />
    </SafeAreaView>
  );
}

function AccountSettingsModal({
  visible,
  displayName,
  accountEmail,
  onClose,
  onSave,
}: {
  visible: boolean;
  displayName: string;
  accountEmail: string;
  onClose: () => void;
  onSave: (displayName: string) => Promise<void>;
}) {
  const [draftDisplayName, setDraftDisplayName] = useState(displayName);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setDraftDisplayName(displayName);
      setIsSaving(false);
    }
  }, [displayName, visible]);

  const save = async () => {
    const normalizedDisplayName = draftDisplayName.trim();
    if (!normalizedDisplayName) {
      Alert.alert('請輸入暱稱', '暱稱不能留空。');
      return;
    }
    setIsSaving(true);
    try {
      await onSave(normalizedDisplayName);
    } catch (error) {
      Alert.alert('儲存失敗', error instanceof Error ? error.message : '無法更新帳號暱稱。');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.modalBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <SafeAreaView edges={['bottom', 'left', 'right']} style={styles.modalSheet}>
          <View style={styles.modalHandle} />
          <Text style={styles.modalTitle}>帳號暱稱</Text>
          <Text style={styles.modalSubtitle}>這個名稱會顯示在首頁問候語及「我的」頁面。</Text>
          <View style={styles.accountSettingsEmailCard}>
            <Text style={styles.accountSettingsEmailLabel}>登入帳號</Text>
            <Text style={styles.accountSettingsEmail} numberOfLines={1}>{accountEmail}</Text>
          </View>
          <FormField
            label="顯示暱稱"
            placeholder="例如：毛爸、Amy"
            value={draftDisplayName}
            onChangeText={setDraftDisplayName}
            maxLength={30}
          />
          <TouchableOpacity disabled={isSaving} style={[styles.formSaveButton, isSaving && styles.formSaveButtonDisabled]} onPress={() => void save()}>
            <Text style={styles.formSaveButtonText}>{isSaving ? '儲存中…' : '儲存暱稱'}</Text>
          </TouchableOpacity>
          <TouchableOpacity disabled={isSaving} style={styles.formCancelButton} onPress={onClose}>
            <Text style={styles.formCancelButtonText}>取消</Text>
          </TouchableOpacity>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function MessagesModal({
  visible,
  invitations,
  onClose,
  onAccept,
}: {
  visible: boolean;
  invitations: PetInvitationRow[];
  onClose: () => void;
  onAccept: (id: string) => Promise<void>;
}) {
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const hasMessages = invitations.length > 0;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.modalSheet, styles.messagesSheet]}>
          <View style={styles.modalHandle} />
          <View style={styles.messagesHeader}><View><Text style={styles.modalTitle}>訊息</Text><Text style={styles.modalSubtitle}>共同照護邀請</Text></View><TouchableOpacity accessibilityRole="button" accessibilityLabel="關閉訊息" onPress={onClose}><Text style={styles.textLink}>完成</Text></TouchableOpacity></View>
          {!hasMessages ? <View style={styles.messageEmpty}><Text style={styles.messageEmptyIcon}>✉</Text><Text style={styles.messageEmptyTitle}>目前沒有新訊息</Text></View> : null}
          {invitations.map((item) => (
            <View key={item.id} style={styles.messageCard}>
              <View style={styles.messageIcon}><Text>🐾</Text></View>
              <View style={styles.messageContent}><Text style={styles.messageTitle}>共同照護邀請</Text><Text style={styles.messageText}>有人邀請你共同照護寵物，權限為「{item.role === 'editor' ? '可新增與編輯' : '僅查看'}」。</Text></View>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="接受共同照護邀請" disabled={acceptingId !== null} style={styles.messageAccept} onPress={() => void (async () => { setAcceptingId(item.id); try { await onAccept(item.id); } catch (error) { Alert.alert('接受失敗', error instanceof Error ? error.message : '無法接受邀請。'); } finally { setAcceptingId(null); } })()}><Text style={styles.messageAcceptText}>{acceptingId === item.id ? '處理中' : '接受'}</Text></TouchableOpacity>
            </View>
          ))}
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function PetSwitcherModal({
  visible,
  pets,
  avatarUris,
  selectedPetId,
  currentUserId,
  onClose,
  onSelect,
  onAdd,
}: {
  visible: boolean;
  pets: PetRow[];
  avatarUris: Record<string, string>;
  selectedPetId: string;
  currentUserId: string;
  onClose: () => void;
  onSelect: (petId: string) => void;
  onAdd: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.modalSheet, styles.petSwitcherSheet]}>
          <View style={styles.modalHandle} />
          <Text style={styles.modalTitle}>選擇寵物</Text>
          <Text style={styles.modalSubtitle}>切換後，首頁、紀錄與用藥資料會一起更新。</Text>
          {pets.map((pet) => {
            const profile = { ...petRowToProfile(pet), avatarUri: avatarUris[pet.id] ?? '' };
            const selected = pet.id === selectedPetId;
            return (
              <TouchableOpacity key={pet.id} style={[styles.petSwitcherRow, selected && styles.petSwitcherRowActive]} onPress={() => onSelect(pet.id)}>
                <View style={styles.petSwitcherAvatar}><PetAvatarContent profile={profile} iconSize={27} /></View>
                <View style={styles.petSwitcherInfo}>
                  <Text style={styles.petSwitcherName}>{pet.name}</Text>
                  <Text style={styles.petSwitcherMeta}>{pet.breed}・{pet.owner_id === currentUserId ? '我的寵物' : '共同照護'}</Text>
                </View>
                <Text style={styles.petSwitcherCheck}>{selected ? '✓' : '›'}</Text>
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity style={styles.petSwitcherAdd} onPress={onAdd}><Text style={styles.petSwitcherAddText}>＋ 新增寵物</Text></TouchableOpacity>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function PetEntryChoiceScreen({ onBack, onJoin, onCreate }: { onBack: () => void; onJoin: () => void; onCreate: () => void }) {
  return (
    <SafeAreaView style={styles.entryFlowSafeArea}>
      <ScrollView contentContainerStyle={styles.entryFlowContent} showsVerticalScrollIndicator={false} stickyHeaderIndices={[0]}>
        <View style={styles.entryFlowNavigation}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="返回登入" style={styles.entryFlowBack} onPress={onBack}>
            <Text style={styles.entryFlowBackText}>‹ 返回登入</Text>
          </TouchableOpacity>
          <Text style={styles.entryFlowStep}>步驟 1/2</Text>
        </View>
        <View style={styles.entryFlowProgress}><View style={[styles.entryFlowProgressFill, { width: '50%' }]} /></View>
        <Text style={styles.entryFlowEyebrow}>開始使用 Smart Pet Life</Text>
        <Text style={styles.entryFlowTitle}>你要如何加入狗狗？</Text>
        <Text style={styles.entryFlowSubtitle}>若狗狗已由家人建立，直接加入共同照護即可，不需要再建立一份重複資料。</Text>

        <TouchableOpacity accessibilityRole="button" style={styles.entryChoiceCard} onPress={onJoin}>
          <View style={[styles.entryChoiceIcon, { backgroundColor: '#E5F1F6' }]}><Text style={styles.entryChoiceEmoji}>🤝</Text></View>
          <View style={styles.entryChoiceBody}>
            <Text style={styles.entryChoiceTitle}>加入已有犬隻</Text>
            <Text style={styles.entryChoiceText}>接受邀請、掃描 QR code 或輸入邀請碼</Text>
          </View>
          <Text style={styles.entryChoiceArrow}>›</Text>
        </TouchableOpacity>

        <TouchableOpacity accessibilityRole="button" style={styles.entryChoiceCard} onPress={onCreate}>
          <View style={[styles.entryChoiceIcon, { backgroundColor: '#E8F4EC' }]}><Text style={styles.entryChoiceEmoji}>🐕</Text></View>
          <View style={styles.entryChoiceBody}>
            <Text style={styles.entryChoiceTitle}>建立新的犬隻資料</Text>
            <Text style={styles.entryChoiceText}>第一次使用，且目前沒有人建立過這隻狗狗</Text>
          </View>
          <Text style={styles.entryChoiceArrow}>›</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function normalizeInvitationCode(value: string) {
  const lastSegment = value.trim().split('/').filter(Boolean).pop() ?? value;
  return lastSegment.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 10);
}

function JoinExistingPetScreen({
  invitations,
  isPreview,
  onBack,
  onAcceptInvitation,
  onAcceptCode,
}: {
  invitations: PetInvitationRow[];
  isPreview: boolean;
  onBack: () => void;
  onAcceptInvitation: (invitationId: string) => Promise<void>;
  onAcceptCode: (joinCode: string) => Promise<void>;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [joinCode, setJoinCode] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [acceptingInvitationId, setAcceptingInvitationId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const acceptCode = async (value = joinCode) => {
    const normalized = normalizeInvitationCode(value);
    if (normalized.length !== 10) {
      setErrorMessage('請輸入完整的 10 位邀請碼。');
      return;
    }
    if (isPreview) {
      setErrorMessage('開發預覽模式無法接受真實邀請，請使用已註冊帳號測試。');
      return;
    }
    setErrorMessage('');
    setIsSubmitting(true);
    try {
      await onAcceptCode(normalized);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '邀請碼無效、已過期，或不是提供給目前登入的 Email。');
      setIsScanning(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  const openScanner = async () => {
    const cameraPermission = permission?.granted ? permission : await requestPermission();
    if (!cameraPermission.granted) {
      setErrorMessage('需要相機權限才能掃描 QR code，你仍可改用邀請碼加入。');
      return;
    }
    setErrorMessage('');
    setIsScanning(true);
  };

  return (
    <SafeAreaView style={styles.entryFlowSafeArea}>
      <ScrollView contentContainerStyle={styles.entryFlowContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} stickyHeaderIndices={[0]}>
        <View style={styles.entryFlowNavigation}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="返回上一步" style={styles.entryFlowBack} onPress={onBack}>
            <Text style={styles.entryFlowBackText}>‹ 上一步</Text>
          </TouchableOpacity>
          <Text style={styles.entryFlowStep}>步驟 2/2</Text>
        </View>
        <View style={styles.entryFlowProgress}><View style={styles.entryFlowProgressFill} /></View>
        <Text style={styles.entryFlowEyebrow}>共同照護</Text>
        <Text style={styles.entryFlowTitle}>加入已有犬隻</Text>
        <Text style={styles.entryFlowSubtitle}>請接受寄到你註冊 Email 的邀請，或使用犬隻管理者提供的 QR code／邀請碼。</Text>

        {invitations.length > 0 ? (
          <View style={styles.joinInvitationCard}>
            <Text style={styles.joinSectionTitle}>等待你接受的邀請</Text>
            {invitations.map((invitation) => (
              <View key={invitation.id} style={styles.joinInvitationRow}>
                <View style={styles.joinInvitationInfo}>
                  <Text style={styles.joinInvitationTitle}>共同照護邀請</Text>
                  <Text style={styles.joinInvitationMeta}>{invitation.role === 'editor' ? '可新增與編輯照護紀錄' : '僅查看照護紀錄'}・7 天內有效</Text>
                </View>
                <TouchableOpacity
                  disabled={acceptingInvitationId !== null}
                  style={styles.joinInvitationAccept}
                  onPress={() => void (async () => {
                    setAcceptingInvitationId(invitation.id);
                    setErrorMessage('');
                    try { await onAcceptInvitation(invitation.id); }
                    catch (error) { setErrorMessage(error instanceof Error ? error.message : '暫時無法接受邀請。'); }
                    finally { setAcceptingInvitationId(null); }
                  })()}
                >
                  <Text style={styles.joinInvitationAcceptText}>{acceptingInvitationId === invitation.id ? '加入中…' : '接受'}</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        ) : null}

        <View style={styles.joinMethodCard}>
          <Text style={styles.joinSectionTitle}>使用 QR code</Text>
          {isScanning ? (
            <View style={styles.joinScannerWrap}>
              <CameraView
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                facing="back"
                onBarcodeScanned={isSubmitting ? undefined : ({ data }) => {
                  setIsScanning(false);
                  const normalized = normalizeInvitationCode(data);
                  setJoinCode(normalized);
                  void acceptCode(normalized);
                }}
                style={StyleSheet.absoluteFill}
              />
              <View pointerEvents="none" style={styles.joinScannerGuide} />
              <TouchableOpacity style={styles.joinScannerCancel} onPress={() => setIsScanning(false)}><Text style={styles.joinScannerCancelText}>取消掃描</Text></TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity accessibilityRole="button" style={styles.joinScanButton} onPress={() => void openScanner()}>
              <Text style={styles.joinScanIcon}>▣</Text><Text style={styles.joinScanButtonText}>掃描邀請 QR code</Text>
            </TouchableOpacity>
          )}

          <View style={styles.joinDivider}><View style={styles.joinDividerLine} /><Text style={styles.joinDividerText}>或手動輸入</Text><View style={styles.joinDividerLine} /></View>
          <TextInput
            accessibilityLabel="10 位共同照護邀請碼"
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!isSubmitting}
            maxLength={10}
            onChangeText={(value) => setJoinCode(normalizeInvitationCode(value))}
            placeholder="例如：A1B2C3D4E5"
            placeholderTextColor="#9AA7A0"
            style={styles.joinCodeInput}
            value={joinCode}
          />
          <Text style={styles.joinCodeHint}>邀請碼由犬隻管理者在「共同照護」頁建立，僅限受邀 Email 使用，7 天內有效。</Text>
          {errorMessage ? <View accessibilityRole="alert" style={styles.joinErrorCard}><Text style={styles.joinErrorText}>{errorMessage}</Text></View> : null}
          <TouchableOpacity accessibilityRole="button" disabled={isSubmitting} style={[styles.joinSubmitButton, isSubmitting && styles.joinSubmitButtonDisabled]} onPress={() => void acceptCode()}>
            {isSubmitting ? <ActivityIndicator color={colors.white} /> : <Text style={styles.joinSubmitButtonText}>加入這隻狗狗</Text>}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function PendingInvitationScreen({
  invitations,
  onAccept,
  onCreatePet,
  onSignOut,
}: {
  invitations: PetInvitationRow[];
  onAccept: (invitationId: string) => Promise<void>;
  onCreatePet: () => void;
  onSignOut: () => void;
}) {
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.invitationGate}>
        <Text style={styles.invitationGateIcon}>🐾</Text>
        <Text style={styles.invitationGateTitle}>你收到共同照護邀請</Text>
        <Text style={styles.invitationGateText}>接受後，這隻寵物會直接出現在你的寵物清單，不需要另外建立資料。</Text>
        {invitations.map((invitation) => (
          <View key={invitation.id} style={styles.invitationGateCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.invitationGateCardTitle}>Smart Pet Life 寵物邀請</Text>
              <Text style={styles.invitationGateCardMeta}>{invitation.role === 'editor' ? '可新增與編輯照護紀錄' : '僅查看照護紀錄'}</Text>
            </View>
            <TouchableOpacity
              disabled={acceptingId !== null}
              style={styles.invitationGateAccept}
              onPress={() => void (async () => {
                setAcceptingId(invitation.id);
                try { await onAccept(invitation.id); }
                catch (error) { Alert.alert('接受失敗', error instanceof Error ? error.message : '無法接受邀請。'); }
                finally { setAcceptingId(null); }
              })()}
            >
              <Text style={styles.invitationGateAcceptText}>{acceptingId === invitation.id ? '處理中…' : '接受'}</Text>
            </TouchableOpacity>
          </View>
        ))}
        <TouchableOpacity style={styles.invitationGateSecondary} onPress={onCreatePet}><Text style={styles.invitationGateSecondaryText}>先建立自己的寵物</Text></TouchableOpacity>
        <TouchableOpacity style={styles.petDataSignOutButton} onPress={onSignOut}><Text style={styles.petDataSignOutButtonText}>登出帳號</Text></TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function PetDataErrorScreen({ message, onRetry, onSignOut }: { message: string; onRetry: () => void; onSignOut: () => void }) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.petDataErrorScreen}>
        <View style={styles.petDataErrorIcon}><Text style={styles.petDataErrorIconText}>!</Text></View>
        <Text style={styles.petDataErrorTitle}>無法載入寵物資料</Text>
        <Text style={styles.petDataErrorText}>{message || '請檢查網路後再試一次。'}</Text>
        <TouchableOpacity accessibilityRole="button" style={styles.petDataRetryButton} onPress={onRetry}>
          <Text style={styles.petDataRetryButtonText}>重新載入</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" style={styles.petDataSignOutButton} onPress={onSignOut}>
          <Text style={styles.petDataSignOutButtonText}>返回登入</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function PetAvatarContent({ profile, iconSize }: { profile: PetProfile; iconSize: number }) {
  if (profile.avatarUri) {
    return <Image source={{ uri: profile.avatarUri }} style={styles.petAvatarImage} />;
  }

  return <Text style={[styles.petAvatarText, { fontSize: iconSize }]}>{profile.avatarIcon}</Text>;
}

function HomeScreen({
  activities,
  preventiveCareSchedules,
  petProfile,
  displayName,
  dailyStats,
  medicationReminder,
  onCompleteMedication,
  onManageMedication,
  onAdd,
  onEditPet,
  onSelectPet,
  petCount,
  onWalk,
  onAllRecords,
  onMessages,
  messageCount,
  isRefreshing,
  onRefresh,
  onManagePreventiveCare,
  onCompletePreventiveCare,
  pendingSmartBinSession,
  onResumeSmartBin,
}: {
  activities: ActivityRecord[];
  preventiveCareSchedules: PreventiveCareScheduleRow[];
  petProfile: PetProfile;
  displayName: string;
  dailyStats: { meals: number; waterMl: number; stools: number; urines: number };
  medicationReminder: MedicationReminder | null;
  onCompleteMedication: () => void;
  onManageMedication: () => void;
  onAdd: (action?: QuickAction) => void;
  onEditPet: () => void;
  onSelectPet: () => void;
  petCount: number;
  onWalk: () => void;
  onAllRecords?: () => void;
  onMessages: () => void;
  messageCount: number;
  isRefreshing: boolean;
  onRefresh: () => void;
  onManagePreventiveCare: (kind: PreventiveCareKind) => void;
  onCompletePreventiveCare: (schedule: PreventiveCareScheduleRow) => Promise<void>;
  pendingSmartBinSession: SmartBinSession | null;
  onResumeSmartBin: () => void;
}) {
  const window = useWindowDimensions();
  const compactLayout = isCompactPhone(window.width);
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [confirmingCompletionKind, setConfirmingCompletionKind] = useState<PreventiveCareKind | null>(null);
  const [isCompletingPreventiveCare, setIsCompletingPreventiveCare] = useState(false);
  const currentHour = new Date(currentTime).getHours();
  const greeting = currentHour < 11 ? '早安' : currentHour < 18 ? '午安' : '晚安';
  const ageLabel = formatPetAge(petProfile.birthday, new Date(currentTime));

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const completionOpensAt = medicationReminder ? getMedicationCompletionOpensAt(medicationReminder) : null;
  const canCompleteMedication = completionOpensAt ? currentTime >= completionOpensAt.getTime() : false;
  const completionTimeLabel = completionOpensAt
    ? `${String(completionOpensAt.getHours()).padStart(2, '0')}:${String(completionOpensAt.getMinutes()).padStart(2, '0')}`
    : '';
  const vaccineStatus = getPreventiveCareStatus(preventiveCareSchedules.find((item) => item.kind === 'vaccine'), 'vaccine');
  const dewormStatus = getPreventiveCareStatus(preventiveCareSchedules.find((item) => item.kind === 'deworming'), 'deworming');
  const scheduleForConfirmation = confirmingCompletionKind
    ? preventiveCareSchedules.find((item) => item.kind === confirmingCompletionKind) ?? null
    : null;

  const completePreventiveCare = async () => {
    if (!scheduleForConfirmation) return;
    setIsCompletingPreventiveCare(true);
    try {
      await onCompletePreventiveCare(scheduleForConfirmation);
      setConfirmingCompletionKind(null);
    } catch (error) {
      Alert.alert('完成失敗', error instanceof Error ? error.message : '暫時無法完成這筆預防照護，請稍後再試。');
    } finally {
      setIsCompletingPreventiveCare(false);
    }
  };

  return (
    <View style={styles.tabScreen}>
      <View style={styles.tabHeader}>
        <View style={styles.topRow}>
          <View>
            <Text style={styles.eyebrow}>{greeting}，{displayName} 👋</Text>
            <Text style={styles.brand}>Smart Pet Life</Text>
          </View>
          <TouchableOpacity accessibilityLabel="訊息" style={styles.notificationButton} onPress={onMessages}>
            <Text style={styles.notificationIcon}>♢</Text>
            {messageCount > 0 ? <View style={styles.notificationDot}><Text style={styles.notificationCount}>{messageCount}</Text></View> : null}
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView style={styles.tabScroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {pendingSmartBinSession ? (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="繼續未完成的模擬智能垃圾桶任務" style={styles.smartBinResumeCard} onPress={onResumeSmartBin}>
            <View style={styles.smartBinResumeIcon}><Text style={styles.smartBinResumeIconText}>♻</Text></View>
            <View style={styles.smartBinResumeCopy}>
              <Text style={styles.smartBinResumeLabel}>模擬設備任務尚未完成</Text>
              <Text style={styles.smartBinResumeTitle}>繼續領袋與投放流程</Text>
              <Text style={styles.smartBinResumeText}>任務只保存在這台裝置，不會產生真實投放或積分。</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity style={styles.petCard} activeOpacity={0.78} onPress={onSelectPet}>
        <View style={styles.petAvatar}>
          <PetAvatarContent profile={petProfile} iconSize={30} />
        </View>
        <View style={styles.petInfo}>
          <View style={styles.petNameRow}>
            <Text style={styles.petName}>{petProfile.name}</Text>
            <View style={styles.demoPill}><Text style={styles.demoPillText}>{petCount > 1 ? `${petCount} 隻寵物` : '切換寵物'}</Text></View>
          </View>
          <Text style={styles.petMeta}>
            {petProfile.breed}・{petProfile.sex}・{ageLabel}・{petProfile.sterilizationStatus}・{petProfile.weightKg || '--'} kg
          </Text>
        </View>
        <Text style={styles.chevron}>›</Text>
      </TouchableOpacity>

      <View style={styles.healthCard}>
        <View style={styles.healthHeader}>
          <View>
            <Text style={styles.sectionKicker}>今日照護</Text>
            <Text style={styles.healthTitle}>{petProfile.name}今日照護</Text>
          </View>
          <View style={styles.healthHeaderActions}>
            <TouchableOpacity accessibilityLabel="刷新今日照護" disabled={isRefreshing} style={styles.careRefreshButton} onPress={onRefresh}>
              <Text style={styles.careRefreshButtonText}>{isRefreshing ? '刷新中' : '↻ 刷新'}</Text>
            </TouchableOpacity>
          </View>
        </View>
        <View style={styles.metricsRow}>
          <Metric icon="🍚" iconBackground="#F7DCDD" value={`${dailyStats.meals} / ${petProfile.mealsPerDay}`} label="餐次" />
          <Metric icon="💧" iconBackground="#D8F0F7" value={`${dailyStats.waterMl}/${petProfile.waterGoalMl}`} label="飲水 ml" />
          <Metric icon="💩" iconBackground="#F1DDD6" value={`${dailyStats.stools} 次`} label="便便" />
          <Metric icon="🟡" iconBackground="#F7E7A9" kind="urine" value={`${dailyStats.urines} 次`} label="尿尿" />
        </View>
        <View style={styles.careLogicNote}>
          <Text style={styles.careLogicIcon}>ⓘ</Text>
          <Text style={styles.careLogicText}>今天還在進行，不會因尚未進食或飲水而扣分。健康評估待加入精神、食慾、活動與症狀後再啟用。</Text>
        </View>
      </View>

      {medicationReminder ? (
        <View style={styles.reminderCard}>
          <View style={styles.reminderIcon}><Text style={styles.reminderEmoji}>💊</Text></View>
          <View style={styles.reminderContent}>
            <Text style={styles.reminderOverline}>下一個提醒・{medicationReminder.when} {medicationReminder.time}</Text>
            <Text style={styles.reminderTitle}>{medicationReminder.title} {medicationReminder.dose}</Text>
            <Text style={styles.reminderText}>
              {canCompleteMedication
                ? `${medicationReminder.instruction}，剩餘 ${medicationReminder.remainingDays} 天`
                : `${completionTimeLabel} 起可標記完成`}
            </Text>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="管理用藥提醒" onPress={onManageMedication}>
              <Text style={styles.reminderManageLink}>管理提醒 ›</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={canCompleteMedication ? '完成用藥' : `完成用藥，${completionTimeLabel} 起開放`}
            accessibilityState={{ disabled: !canCompleteMedication }}
            disabled={!canCompleteMedication}
            style={[styles.doneButton, !canCompleteMedication && styles.doneButtonDisabled]}
            onPress={onCompleteMedication}
          >
            <Text style={[styles.doneButtonText, !canCompleteMedication && styles.doneButtonTextDisabled]}>
              {canCompleteMedication ? '完成' : '未開放'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={[styles.reminderCard, styles.reminderCompleteCard]}>
          <View style={styles.reminderIcon}><Text style={styles.reminderEmoji}>✓</Text></View>
          <View style={styles.reminderContent}>
            <Text style={styles.reminderOverline}>用藥提醒</Text>
            <Text style={styles.reminderTitle}>目前沒有待完成的用藥</Text>
            <Text style={styles.reminderText}>完成後會保留用藥紀錄，並自動顯示下一個提醒。</Text>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="管理用藥提醒" onPress={onManageMedication}>
              <Text style={styles.reminderManageLink}>新增或管理提醒 ›</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <View style={styles.preventiveCareSection}>
        <View style={[styles.preventiveCareHeader, compactLayout && styles.preventiveCareHeaderCompact]}>
          <Text style={styles.preventiveCareTitle}>健康提醒</Text>
          <Text style={styles.preventiveCareHint}>依排程到期日自動倒數</Text>
        </View>
        <View style={[styles.preventiveCareRow, compactLayout && styles.preventiveCareRowCompact]}>
          <PreventiveCareCard
            status={dewormStatus}
            onPress={() => onManagePreventiveCare('deworming')}
            isCompleting={isCompletingPreventiveCare}
            onRequestComplete={() => setConfirmingCompletionKind('deworming')}
          />
          <PreventiveCareCard
            status={vaccineStatus}
            onPress={() => onManagePreventiveCare('vaccine')}
            isCompleting={isCompletingPreventiveCare}
            onRequestComplete={() => setConfirmingCompletionKind('vaccine')}
          />
        </View>
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>快速紀錄</Text>
        <TouchableOpacity onPress={() => onAdd()}><Text style={styles.textLink}>更多</Text></TouchableOpacity>
      </View>
      <View style={styles.actionGrid}>
        {quickActions.slice(0, 4).map((action) => (
          <TouchableOpacity key={action.label} style={styles.actionCard} onPress={() => onAdd(action)}>
            <View style={[styles.actionIcon, { backgroundColor: `${action.tone}1F` }]}>
              {action.kind === 'urine' ? <UrinePuddleIcon size={23} /> : <Text style={styles.actionEmoji}>{action.icon}</Text>}
            </View>
            <Text style={styles.actionLabel}>{action.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity style={styles.walkStartCard} activeOpacity={0.86} onPress={onWalk}>
        <View style={styles.walkStartCopy}>
          <View style={styles.walkStartBadge}><Text style={styles.walkStartBadgeText}>戶外遛狗</Text></View>
          <Text style={styles.walkStartTitle}>和 {petProfile.name} 出門走走</Text>
          <Text style={styles.walkStartText}>即時路線、時間、距離與途中排泄記錄</Text>
          <View style={styles.walkStartAction}><Text style={styles.walkStartActionText}>開始遛狗</Text><Text style={styles.walkStartArrow}>→</Text></View>
        </View>
        <View style={styles.walkStartArt}><Text style={styles.walkStartArtText}>🐕</Text></View>
      </TouchableOpacity>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>最近動態</Text>
        {onAllRecords ? <TouchableOpacity accessibilityRole="button" accessibilityLabel="查看全部紀錄" onPress={onAllRecords}><Text style={styles.textLink}>全部紀錄</Text></TouchableOpacity> : null}
      </View>
      {activities.length > 0 ? (
        <View style={styles.timelineCard}>
          {activities.slice(0, 3).map((activity, index) => (
            <TimelineItem
              key={activity.id}
              activity={activity}
              isLast={index === Math.min(activities.length, 3) - 1}
            />
          ))}
        </View>
      ) : (
        <View style={styles.recentEmptyCard}>
          <Text style={styles.recentEmptyIcon}>▤</Text>
          <Text style={styles.recentEmptyTitle}>還沒有生活紀錄</Text>
          <Text style={styles.recentEmptyText}>完成第一次飲食、喝水或排便紀錄後，資料會顯示在這裡。</Text>
        </View>
      )}
      </ScrollView>
      <AppConfirmDialog
        visible={scheduleForConfirmation !== null}
        icon={scheduleForConfirmation?.kind === 'vaccine' ? '💉' : '🪱'}
        title={`確認完成${scheduleForConfirmation?.kind === 'vaccine' ? '疫苗' : '驅蟲'}？`}
        message={scheduleForConfirmation
          ? `將為 ${petProfile.name} 新增「${scheduleForConfirmation.title}」健康紀錄，並從完成日重新計算下次提醒。`
          : ''}
        confirmLabel="確認完成"
        loadingLabel="完成中…"
        tone="warning"
        loading={isCompletingPreventiveCare}
        testID="preventive-care-home-confirm-dialog"
        onCancel={() => setConfirmingCompletionKind(null)}
        onConfirm={() => void completePreventiveCare()}
      />
    </View>
  );
}

function offlineQueueRowToActivity(row: OfflineCareQueueRow): ActivityRecord | null {
  try {
    const payload = JSON.parse(row.payload_json) as {
      title: string;
      note: string | null;
      amount: number | null;
      unit: string | null;
      food_type: CareRecordRow['food_type'];
      stool_texture: CareRecordRow['stool_texture'];
      stool_color: CareRecordRow['stool_color'];
      stool_status: CareRecordRow['stool_status'];
      urine_color: CareRecordRow['urine_color'];
      metadata: CareRecordRow['metadata'];
    };
    return {
      ...careRecordToActivity({
        id: row.local_id,
        owner_id: row.owner_id,
        pet_id: row.pet_id,
        kind: row.kind,
        occurred_at: row.occurred_at,
        source: 'manual',
        amount: payload.amount,
        unit: payload.unit,
        food_type: payload.food_type,
        medication_name: null,
        medication_dose: null,
        stool_texture: payload.stool_texture,
        stool_color: payload.stool_color,
        stool_status: payload.stool_status,
        urine_color: payload.urine_color,
        title: payload.title,
        note: payload.note,
        image_path: null,
        walk_session_id: null,
        recorded_by: row.profile_id,
        client_request_key: row.client_request_key,
        recorded_timezone: row.timezone,
        received_at: row.created_local_at,
        capture_mode: 'offline',
        medical_file_paths: [],
        metadata: payload.metadata,
        created_at: row.created_local_at,
        updated_at: row.updated_local_at,
      }, row.pet_name),
      syncStatus: row.status,
    };
  } catch {
    return null;
  }
}

function PreventiveCareCard({
  status,
  onPress,
  isCompleting,
  onRequestComplete,
}: {
  status: PreventiveCareStatus;
  onPress: () => void;
  isCompleting: boolean;
  onRequestComplete: () => void;
}) {
  return (
    <View
      style={[styles.preventiveCareCard, status.isOverdue && styles.preventiveCareCardOverdue]}
    >
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={`${status.label}提醒設定，目前${status.statusLabel}`} activeOpacity={0.78} onPress={onPress}>
      <View style={styles.preventiveCareCardHeader}>
        <View style={[styles.preventiveCareIcon, status.isOverdue && styles.preventiveCareIconOverdue]}>
          <Text style={styles.preventiveCareEmoji}>{status.icon}</Text>
        </View>
        <Text style={styles.preventiveCareLabel}>{status.label}</Text>
      </View>
      <Text style={[styles.preventiveCareStatus, status.isOverdue && styles.preventiveCareStatusOverdue]}>{status.statusLabel}</Text>
      <Text style={styles.preventiveCareDetail}>{status.isUnconfigured ? status.detailLabel : `${status.intervalLabel} · ${status.detailLabel}`}</Text>
      <Text style={styles.preventiveCareAction}>{status.isUnconfigured ? '設定提醒 ›' : '查看與管理 ›'}</Text>
      </TouchableOpacity>
      {!status.isUnconfigured && (status.isOverdue ? (
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={`${status.label}完成`} disabled={isCompleting} style={styles.preventiveCareCardCompleteButton} onPress={onRequestComplete}>
          <Text style={styles.preventiveCareCardCompleteButtonText}>完成</Text>
        </TouchableOpacity>
      ) : (
        <View accessibilityRole="text" accessibilityLabel={`${status.label}已完成`} style={[styles.preventiveCareCardCompleteButton, styles.preventiveCareCardCompleteButtonDisabled]}>
          <Text style={[styles.preventiveCareCardCompleteButtonText, styles.preventiveCareCardCompleteButtonTextDisabled]}>已完成</Text>
        </View>
      ))}
    </View>
  );
}

function UrinePuddleIcon({ size = 22 }: { size?: number }) {
  return (
    <View style={[styles.urineIconCanvas, { width: size, height: size * 0.72 }]}>
      <View
        style={[
          styles.urinePuddleBase,
          { width: size, height: size * 0.38, borderRadius: size / 2, bottom: 0 },
        ]}
      />
      <View
        style={[
          styles.urinePuddleLobe,
          { width: size * 0.44, height: size * 0.34, borderRadius: size / 2, left: size * 0.08, bottom: size * 0.18 },
        ]}
      />
      <View
        style={[
          styles.urinePuddleShine,
          { width: size * 0.24, height: size * 0.09, borderRadius: size, right: size * 0.16, bottom: size * 0.16 },
        ]}
      />
    </View>
  );
}

function Metric({
  icon,
  iconBackground,
  value,
  label,
  kind,
}: {
  icon: string;
  iconBackground: string;
  value: string;
  label: string;
  kind?: ActivityKind;
}) {
  return (
    <View style={styles.metric}>
      <View style={[styles.metricIconBadge, { backgroundColor: iconBackground }]}>
        {kind === 'urine' ? <UrinePuddleIcon size={19} /> : <Text style={styles.metricIcon}>{icon}</Text>}
      </View>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

type RecordFilter = 'all' | ActivityKind | 'walk';
type TrendRange = 7 | 30;

const recordFilters: { value: RecordFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'meal', label: '飲食' },
  { value: 'water', label: '喝水' },
  { value: 'stool', label: '便便' },
  { value: 'urine', label: '尿尿' },
  { value: 'walk', label: '遛狗' },
  { value: 'medication', label: '用藥' },
  { value: 'vaccine', label: '疫苗' },
  { value: 'medical', label: '驅蟲' },
];

function RecordsScreen({
  activities,
  walks,
  pets,
  selectedPetId,
  isRefreshing,
  offlineSummary,
  offlineSyncMode,
  isOnline,
  isSyncingOffline,
  onRefresh,
  onSyncOffline,
  onChangeOfflineSyncMode,
  onAdd,
  onUpdate,
  onDelete,
}: {
  activities: ActivityRecord[];
  walks: WalkSessionRecord[];
  pets: PetRow[];
  selectedPetId: string;
  isRefreshing: boolean;
  offlineSummary: OfflineQueueSummary;
  offlineSyncMode: OfflineSyncMode;
  isOnline: boolean;
  isSyncingOffline: boolean;
  onRefresh: () => void;
  onSyncOffline: () => void;
  onChangeOfflineSyncMode: (mode: OfflineSyncMode) => void;
  onAdd: () => void;
  onUpdate: (activityId: string, changes: ActivityInput) => Promise<void>;
  onDelete: (activityId: string) => void;
}) {
  const todayValue = formatDateValue(new Date());
  const minimumDate = new Date();
  minimumDate.setFullYear(minimumDate.getFullYear() - 2);
  const [selectedDate, setSelectedDate] = useState(todayValue);
  const [selectedFilter, setSelectedFilter] = useState<RecordFilter>('all');
  const [trendRange, setTrendRange] = useState<TrendRange>(7);
  const [showFilterPicker, setShowFilterPicker] = useState(false);
  const [editingActivity, setEditingActivity] = useState<ActivityRecord | null>(null);
  const [viewingPetId, setViewingPetId] = useState<string>('all');
  const [showOfflineSyncSettings, setShowOfflineSyncSettings] = useState(false);
  const offlineCount = offlineSummary.pending + offlineSummary.syncing + offlineSummary.failed;

  const recordsForDate = useMemo(() => {
    return activities
      .filter((activity) => viewingPetId === 'all' || activity.petId === viewingPetId || (!activity.petId && viewingPetId === selectedPetId))
      .filter((activity) => formatDateValue(new Date(activity.occurredAt)) === selectedDate)
      .filter((activity) => selectedFilter === 'all' || (selectedFilter !== 'walk' && activity.kind === selectedFilter))
      .sort((left, right) => right.occurredAt - left.occurredAt);
  }, [activities, selectedDate, selectedFilter, viewingPetId, selectedPetId]);

  const scopedActivities = useMemo(() => activities.filter((activity) => (
    viewingPetId === 'all' || activity.petId === viewingPetId || (!activity.petId && viewingPetId === selectedPetId)
  )), [activities, viewingPetId, selectedPetId]);
  const scopedWalks = useMemo(() => walks.filter((walk) => (
    viewingPetId === 'all' || walk.pet_id === viewingPetId
  )), [viewingPetId, walks]);
  const walksForDate = useMemo(() => scopedWalks
    .filter((walk) => formatDateValue(new Date(walk.started_at)) === selectedDate)
    .filter(() => selectedFilter === 'all' || selectedFilter === 'walk'), [scopedWalks, selectedDate, selectedFilter]);

  const selectedDateObject = parseDateValue(selectedDate) ?? new Date();
  const dateTitle = selectedDate === todayValue
    ? '今天'
    : `${selectedDateObject.getMonth() + 1} 月 ${selectedDateObject.getDate()} 日`;

  const moveDate = (days: number) => {
    const nextDate = new Date(selectedDateObject);
    nextDate.setDate(nextDate.getDate() + days);
    const nextValue = formatDateValue(nextDate);
    if (nextValue <= todayValue && nextDate >= minimumDate) setSelectedDate(nextValue);
  };

  return (
    <View style={styles.tabScreen}>
      <View style={styles.tabHeader}>
        <View style={styles.pageHeader}>
          <View>
            <Text style={styles.eyebrow}>麻糬的健康日誌</Text>
            <Text style={styles.pageTitle}>生活紀錄</Text>
          </View>
          <View style={styles.recordHeaderActions}><TouchableOpacity accessibilityLabel="刷新生活記錄" disabled={isRefreshing} style={styles.refreshMiniButton} onPress={onRefresh}><Text style={styles.refreshMiniButtonText}>{isRefreshing ? '刷新中…' : '↻ 刷新'}</Text></TouchableOpacity><TouchableOpacity accessibilityLabel="新增生活記錄" style={styles.primaryMiniButton} onPress={onAdd}><Text style={styles.primaryMiniButtonText}>＋ 新增</Text></TouchableOpacity></View>
        </View>
      </View>

      <ScrollView style={styles.tabScroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {pets.length > 1 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.petScopeRow}>
          <TouchableOpacity style={[styles.petScopeChip, viewingPetId === 'all' && styles.petScopeChipActive]} onPress={() => setViewingPetId('all')}><Text style={[styles.petScopeText, viewingPetId === 'all' && styles.petScopeTextActive]}>全部寵物</Text></TouchableOpacity>
          {pets.map((pet) => <TouchableOpacity key={pet.id} style={[styles.petScopeChip, viewingPetId === pet.id && styles.petScopeChipActive]} onPress={() => setViewingPetId(pet.id)}><Text style={[styles.petScopeText, viewingPetId === pet.id && styles.petScopeTextActive]}>{pet.name}</Text></TouchableOpacity>)}
        </ScrollView> : null}

        <View style={styles.offlineSyncCard}>
          <View style={styles.offlineSyncHeader}>
            <View style={styles.offlineSyncIcon}><Text>{isOnline ? '☁' : '↧'}</Text></View>
            <View style={styles.offlineSyncCopy}>
              <Text style={styles.offlineSyncTitle}>{isOnline ? '離線記錄同步' : '目前沒有網路'}</Text>
              <Text style={styles.offlineSyncText}>
                {offlineCount > 0
                  ? `${offlineCount} 筆留在本機（待同步 ${offlineSummary.pending}、失敗 ${offlineSummary.failed}）`
                  : '所有可離線生活記錄均已同步'}
              </Text>
            </View>
            <TouchableOpacity accessibilityLabel="離線同步設定" onPress={() => setShowOfflineSyncSettings(true)}>
              <Text style={styles.offlineSyncSettings}>設定</Text>
            </TouchableOpacity>
          </View>
          {offlineCount > 0 ? (
            <TouchableOpacity
              accessibilityRole="button"
              disabled={!isOnline || isSyncingOffline}
              style={[styles.offlineSyncButton, (!isOnline || isSyncingOffline) && styles.offlineSyncButtonDisabled]}
              onPress={onSyncOffline}
            >
              <Text style={styles.offlineSyncButtonText}>{isSyncingOffline ? '同步中…' : isOnline ? '立即同步' : '連線後即可同步'}</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <CalendarDateField
          label="選擇查看日期"
          value={selectedDate}
          onChange={setSelectedDate}
          minDate={formatDateValue(minimumDate)}
          maxDate={todayValue}
          hint="日期只用來篩選記錄，不會修改任何記錄的發生時間。"
          navigatorTitle={dateTitle}
          onPrevious={() => moveDate(-1)}
          onNext={() => moveDate(1)}
          previousDisabled={selectedDate <= formatDateValue(minimumDate)}
          nextDisabled={selectedDate === todayValue}
        />

        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`篩選紀錄，目前為${recordFilters.find((filter) => filter.value === selectedFilter)?.label}`}
          style={styles.filterSelector}
          onPress={() => setShowFilterPicker(true)}
        >
          <View>
            <Text style={styles.filterSelectorLabel}>紀錄分類</Text>
            <Text style={styles.filterSelectorValue}>{recordFilters.find((filter) => filter.value === selectedFilter)?.label}</Text>
          </View>
          <Text style={styles.filterSelectorChevron}>⌄</Text>
        </TouchableOpacity>

        {selectedFilter === 'walk' ? (
          <WalkTrendCard
            walks={scopedWalks}
            endDate={selectedDate}
            range={trendRange}
            onRangeChange={setTrendRange}
          />
        ) : (
          <HealthTrendCard
            activities={scopedActivities}
            endDate={selectedDate}
            filter={selectedFilter}
            range={trendRange}
            onRangeChange={setTrendRange}
          />
        )}

        <View style={styles.recordListHeader}>
          <Text style={styles.dateHeading}>{dateTitle}・{recordFilters.find((filter) => filter.value === selectedFilter)?.label}</Text>
          <Text style={styles.recordCount}>{recordsForDate.length + walksForDate.length} 筆</Text>
        </View>
        {walksForDate.length ? <View style={styles.walkDailyList}>
          {walksForDate.map((walk) => <WalkHistoryCard key={walk.id} walk={walk} />)}
        </View> : null}
        {recordsForDate.length ? (
          <View style={styles.timelineCard}>
            {recordsForDate.map((activity, index) => (
              <TimelineItem
                key={activity.id}
                activity={activity}
                isLast={index === recordsForDate.length - 1}
                onPress={activity.syncStatus ? undefined : () => setEditingActivity(activity)}
              />
            ))}
          </View>
        ) : recordsForDate.length + walksForDate.length === 0 ? (
          <View style={styles.recordEmptyCard}>
            <Text style={styles.recordEmptyIcon}>▤</Text>
            <Text style={styles.recordEmptyTitle}>這一天沒有相關記錄</Text>
            <Text style={styles.recordEmptyText}>可以切換分類或日期查看其他資料。</Text>
          </View>
        ) : null}

      </ScrollView>

      <Modal visible={showFilterPicker} transparent animationType="fade" onRequestClose={() => setShowFilterPicker(false)}>
        <View style={styles.filterPickerBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowFilterPicker(false)} />
          <View style={styles.filterPickerCard}>
            <View style={styles.filterPickerHeader}>
              <View>
                <Text style={styles.filterPickerTitle}>選擇紀錄分類</Text>
                <Text style={styles.filterPickerSubtitle}>可查看生活照護或遛狗摘要</Text>
              </View>
              <TouchableOpacity onPress={() => setShowFilterPicker(false)}><Text style={styles.textLink}>取消</Text></TouchableOpacity>
            </View>
            <View style={styles.filterPickerGrid}>
              {recordFilters.map((filter) => {
                const isActive = selectedFilter === filter.value;
                return (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityState={{ selected: isActive }}
                    key={filter.value}
                    style={[styles.filterPickerOption, isActive && styles.filterPickerOptionActive]}
                    onPress={() => {
                      setSelectedFilter(filter.value);
                      setShowFilterPicker(false);
                    }}
                  >
                    <Text style={[styles.filterPickerOptionText, isActive && styles.filterPickerOptionTextActive]}>{filter.label}</Text>
                    {isActive ? <Text style={styles.filterPickerCheck}>✓</Text> : null}
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={showOfflineSyncSettings} transparent animationType="fade" onRequestClose={() => setShowOfflineSyncSettings(false)}>
        <View style={styles.filterPickerBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowOfflineSyncSettings(false)} />
          <View style={styles.filterPickerCard}>
            <View style={styles.filterPickerHeader}>
              <View><Text style={styles.filterPickerTitle}>離線同步方式</Text><Text style={styles.filterPickerSubtitle}>只影響飲食、喝水、便便與尿尿</Text></View>
              <TouchableOpacity onPress={() => setShowOfflineSyncSettings(false)}><Text style={styles.textLink}>完成</Text></TouchableOpacity>
            </View>
            {([
              ['auto', '自動同步', '任何可用網路連線後自動上傳'],
              ['wifi', '僅 Wi‑Fi', '連上 Wi‑Fi 後自動上傳'],
              ['manual', '手動同步', '由你點擊「立即同步」才上傳'],
            ] as const).map(([mode, label, description]) => (
              <TouchableOpacity
                key={mode}
                accessibilityRole="radio"
                accessibilityState={{ checked: offlineSyncMode === mode }}
                style={[styles.offlineModeOption, offlineSyncMode === mode && styles.offlineModeOptionActive]}
                onPress={() => onChangeOfflineSyncMode(mode)}
              >
                <View style={styles.offlineModeCopy}><Text style={styles.offlineModeTitle}>{label}</Text><Text style={styles.offlineModeText}>{description}</Text></View>
                <Text style={styles.offlineModeCheck}>{offlineSyncMode === mode ? '✓' : ''}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </Modal>

      <EditActivityModal
        activity={editingActivity}
        onClose={() => setEditingActivity(null)}
        onSave={async (activityId, changes) => {
          await onUpdate(activityId, changes);
          setEditingActivity(null);
        }}
        onDelete={(activityId) => {
          onDelete(activityId);
          setEditingActivity(null);
        }}
      />
    </View>
  );
}

function WalkHistoryCard({ walk }: { walk: WalkSessionRecord }) {
  const date = new Date(walk.started_at);
  const energy = walk.energy_kcal_low != null && walk.energy_kcal_high != null
    ? `${Math.round(Number(walk.energy_kcal_low))}–${Math.round(Number(walk.energy_kcal_high))} kcal`
    : '未估算熱量';
  return (
    <View style={styles.walkHistoryCard}>
      <View style={styles.walkHistoryCardTop}>
        <View>
          <Text style={styles.walkHistoryDate}>{date.toLocaleDateString('zh-TW', { month: 'long', day: 'numeric' })}・{String(date.getHours()).padStart(2, '0')}:{String(date.getMinutes()).padStart(2, '0')}</Text>
          <Text style={styles.walkHistoryPet}>{walk.petName ? `${walk.petName}・` : ''}{formatWalkDuration(walk.duration_seconds)}</Text>
        </View>
        <View style={styles.walkHistoryDistance}><Text style={styles.walkHistoryDistanceValue}>{(Number(walk.distance_m) / 1000).toFixed(2)}</Text><Text style={styles.walkHistoryDistanceUnit}>km</Text></View>
      </View>
      <View style={styles.walkHistoryMeta}>
        <Text style={styles.walkHistoryMetaText}>平均 {(Number(walk.average_speed_mps) * 3.6).toFixed(1)} km/h</Text>
        <Text style={styles.walkHistoryMetaDot}>•</Text>
        <Text style={styles.walkHistoryMetaText}>{energy}</Text>
        <Text style={styles.walkHistoryMetaDot}>•</Text>
        <Text style={styles.walkHistoryMetaText}>💩 {walk.stool_count}　🟡 {walk.urine_count}</Text>
      </View>
    </View>
  );
}

type TrendDay = {
  date: string;
  label: string;
  count: number;
  amount: number;
  hasAlert: boolean;
};

function trendHasAlert(activity: ActivityRecord) {
  if (activity.kind === 'stool') return /腹瀉|便秘|水樣|黑|鮮紅|血/.test(activity.detail);
  if (activity.kind === 'urine') return /紅|棕|血|混濁|深黃/.test(activity.detail);
  return false;
}

function buildTrendDays(activities: ActivityRecord[], endDate: string, range: TrendRange, kind?: ActivityKind) {
  const end = parseDateValue(endDate) ?? new Date();
  return Array.from({ length: range }, (_, index): TrendDay => {
    const date = new Date(end);
    date.setDate(end.getDate() - (range - index - 1));
    const dateValue = formatDateValue(date);
    const records = activities.filter((activity) => (
      formatDateValue(new Date(activity.occurredAt)) === dateValue && (!kind || activity.kind === kind)
    ));
    return {
      date: dateValue,
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      count: records.length,
      amount: records.reduce((total, activity) => total + (activity.amount ?? 0), 0),
      hasAlert: records.some(trendHasAlert),
    };
  });
}

function TrendBars({
  days,
  useAmount,
  unit,
  showAlerts,
}: {
  days: TrendDay[];
  useAmount: boolean;
  unit: string;
  showAlerts?: boolean;
}) {
  const chartWidth = 320;
  const chartHeight = 148;
  const left = 38;
  const right = 8;
  const top = 15;
  const bottom = 27;
  const plotWidth = chartWidth - left - right;
  const plotHeight = chartHeight - top - bottom;
  const values = days.map((day) => useAmount ? day.amount : day.count);
  const maximum = Math.max(...values, 1);
  const slotWidth = plotWidth / days.length;
  const barWidth = Math.max(2, Math.min(20, slotWidth * 0.62));
  const tickIndexes = days.length === 7 ? [0, 3, 6] : [0, 14, 29];

  return (
    <Svg width="100%" height={chartHeight} viewBox={`0 0 ${chartWidth} ${chartHeight}`} accessibilityLabel={`最近 ${days.length} 天${unit}趨勢圖`}>
      <Line x1={left} x2={chartWidth - right} y1={top} y2={top} stroke="rgba(255,255,255,0.15)" strokeWidth={1} />
      <Line x1={left} x2={chartWidth - right} y1={top + plotHeight / 2} y2={top + plotHeight / 2} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
      <Line x1={left} x2={chartWidth - right} y1={top + plotHeight} y2={top + plotHeight} stroke="rgba(255,255,255,0.2)" strokeWidth={1} />
      <SvgText x={left - 5} y={top + 4} fill="#C5D8CF" fontSize={9} textAnchor="end">{Math.round(maximum)}</SvgText>
      <SvgText x={left - 5} y={top + plotHeight + 3} fill="#C5D8CF" fontSize={9} textAnchor="end">0</SvgText>
      {days.map((day, index) => {
        const value = values[index];
        const height = value > 0 ? Math.max(3, (value / maximum) * plotHeight) : 0;
        const x = left + index * slotWidth + (slotWidth - barWidth) / 2;
        const y = top + plotHeight - height;
        return (
          <Fragment key={day.date}>
            {height > 0 ? <Rect x={x} y={y} width={barWidth} height={height} rx={Math.min(4, barWidth / 2)} fill="#8FD0AC" /> : null}
            {showAlerts && day.hasAlert ? <Circle cx={x + barWidth / 2} cy={Math.max(top + 4, y - 6)} r={3.5} fill="#FFB36B" /> : null}
          </Fragment>
        );
      })}
      {tickIndexes.map((index) => (
        <SvgText key={days[index].date} x={left + index * slotWidth + slotWidth / 2} y={chartHeight - 7} fill="#C5D8CF" fontSize={9} textAnchor="middle">
          {days[index].label}
        </SvgText>
      ))}
      <SvgText x={5} y={top - 4} fill="#C5D8CF" fontSize={8}>{unit}</SvgText>
    </Svg>
  );
}

function TrendLine({ days, unit }: { days: TrendDay[]; unit: string }) {
  const chartWidth = 320;
  const chartHeight = 148;
  const left = 38;
  const right = 8;
  const top = 15;
  const bottom = 27;
  const plotWidth = chartWidth - left - right;
  const plotHeight = chartHeight - top - bottom;
  const maximum = Math.max(...days.map((day) => day.amount), 1);
  const step = plotWidth / Math.max(days.length - 1, 1);
  const points = days.map((day, index) => {
    const x = left + index * step;
    const y = top + plotHeight - (day.amount / maximum) * plotHeight;
    return { ...day, x, y };
  });
  const tickIndexes = days.length === 7 ? [0, 3, 6] : [0, 14, 29];

  return (
    <Svg width="100%" height={chartHeight} viewBox={`0 0 ${chartWidth} ${chartHeight}`} accessibilityLabel={`最近 ${days.length} 天${unit}趨勢圖`}>
      <Line x1={left} x2={chartWidth - right} y1={top} y2={top} stroke="rgba(255,255,255,0.15)" strokeWidth={1} />
      <Line x1={left} x2={chartWidth - right} y1={top + plotHeight / 2} y2={top + plotHeight / 2} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
      <Line x1={left} x2={chartWidth - right} y1={top + plotHeight} y2={top + plotHeight} stroke="rgba(255,255,255,0.2)" strokeWidth={1} />
      <SvgText x={left - 5} y={top + 4} fill="#C5D8CF" fontSize={9} textAnchor="end">{Math.round(maximum)}</SvgText>
      <SvgText x={left - 5} y={top + plotHeight + 3} fill="#C5D8CF" fontSize={9} textAnchor="end">0</SvgText>
      <Polyline points={points.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke="#8FD0AC" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      {points.map((point) => (
        <Circle
          key={point.date}
          cx={point.x}
          cy={point.y}
          r={days.length === 7 ? 4 : 2.5}
          fill="#DDF4E6"
          stroke="#5FB485"
          strokeWidth={1.5}
        />
      ))}
      {tickIndexes.map((index) => (
        <SvgText key={days[index].date} x={left + index * step} y={chartHeight - 7} fill="#C5D8CF" fontSize={9} textAnchor={index === 0 ? 'start' : index === days.length - 1 ? 'end' : 'middle'}>
          {days[index].label}
        </SvgText>
      ))}
      <SvgText x={5} y={top - 4} fill="#C5D8CF" fontSize={8}>{unit}</SvgText>
    </Svg>
  );
}

function TrendMiniRow({ label, days, useAmount, unit }: { label: string; days: TrendDay[]; useAmount: boolean; unit: string }) {
  const values = days.map((day) => useAmount ? day.amount : day.count);
  const maximum = Math.max(...values, 1);
  const total = values.reduce((sum, value) => sum + value, 0);
  return (
    <View style={styles.trendMiniRow}>
      <View style={styles.trendMiniLabelWrap}>
        <Text style={styles.trendMiniLabel}>{label}</Text>
        <Text style={styles.trendMiniValue}>{Math.round(total)} {unit}</Text>
      </View>
      <View style={styles.trendMiniChart}>
        {values.map((value, index) => (
          <View key={days[index].date} style={styles.trendMiniSlot}>
            <View style={[styles.trendMiniBar, { height: value ? Math.max(3, (value / maximum) * 36) : 1 }, days[index].hasAlert && styles.trendMiniBarAlert]} />
          </View>
        ))}
      </View>
    </View>
  );
}

function PreventiveTimeline({ days, label }: { days: TrendDay[]; label: string }) {
  const events = days.filter((day) => day.count > 0);
  return (
    <View style={styles.preventiveTimeline}>
      <View style={styles.preventiveTimelineLine} />
      {events.length ? events.map((day, index) => (
        <View key={day.date} style={[styles.preventiveTimelineEvent, { left: `${(days.indexOf(day) / Math.max(days.length - 1, 1)) * 88 + 4}%` }]}>
          <View style={styles.preventiveTimelineDot} />
          <Text style={styles.preventiveTimelineDate}>{day.label}</Text>
          <Text style={styles.preventiveTimelineLabel}>{label}</Text>
        </View>
      )) : <Text style={styles.preventiveTimelineEmpty}>此期間沒有{label}紀錄</Text>}
    </View>
  );
}

function HealthTrendCard({
  activities,
  endDate,
  filter,
  range,
  onRangeChange,
}: {
  activities: ActivityRecord[];
  endDate: string;
  filter: Exclude<RecordFilter, 'walk'>;
  range: TrendRange;
  onRangeChange: (range: TrendRange) => void;
}) {
  const selectedLabel = recordFilters.find((item) => item.value === filter)?.label ?? '全部';
  const selectedKind = filter === 'all' ? undefined : filter;
  const days = useMemo(() => buildTrendDays(activities, endDate, range, selectedKind), [activities, endDate, range, selectedKind]);
  const allDays = useMemo(() => buildTrendDays(activities, endDate, range), [activities, endDate, range]);
  const totalRecords = days.reduce((sum, day) => sum + day.count, 0);
  const alertDays = days.filter((day) => day.hasAlert).length;
  const recordedDays = allDays.filter((day) => day.count > 0).length;

  let insight = `近 ${range} 天共有 ${totalRecords} 筆${selectedLabel}紀錄。`;
  if (filter === 'all') insight = `近 ${range} 天有 ${recordedDays} 天留下照護紀錄；沒有紀錄的日期不代表沒有活動。`;
  if ((filter === 'stool' || filter === 'urine') && alertDays > 0) insight = `有 ${alertDays} 天出現需要留意的${selectedLabel}特徵，請結合精神、食慾與持續時間觀察。`;
  if (filter === 'medication') insight = `近 ${range} 天有 ${totalRecords} 筆已完成用藥紀錄；目前資料不能判斷漏服。`;
  if (filter !== 'all' && totalRecords === 0) insight = `近 ${range} 天沒有${selectedLabel}紀錄，資料不足以判斷趨勢。`;

  const useAmount = filter === 'meal' || filter === 'water';
  const unit = filter === 'meal' ? 'g' : filter === 'water' ? 'ml' : '次';

  return (
    <View style={styles.healthTrendCard}>
      <View style={styles.healthTrendHeader}>
        <View style={styles.healthTrendHeading}>
          <Text style={styles.healthTrendKicker}>健康趨勢</Text>
          <Text style={styles.healthTrendTitle}>{selectedLabel}・近 {range} 天</Text>
        </View>
        <View style={styles.trendRangeControl}>
          {([7, 30] as TrendRange[]).map((value) => (
            <TouchableOpacity
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected: range === value }}
              style={[styles.trendRangeButton, range === value && styles.trendRangeButtonActive]}
              onPress={() => onRangeChange(value)}
            >
              <Text style={[styles.trendRangeButtonText, range === value && styles.trendRangeButtonTextActive]}>{value} 天</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {filter === 'all' ? (
        <View style={styles.trendOverview}>
          <TrendMiniRow label="飲食" days={buildTrendDays(activities, endDate, range, 'meal')} useAmount unit="g" />
          <TrendMiniRow label="喝水" days={buildTrendDays(activities, endDate, range, 'water')} useAmount unit="ml" />
          <TrendMiniRow label="便便" days={buildTrendDays(activities, endDate, range, 'stool')} useAmount={false} unit="次" />
          <TrendMiniRow label="尿尿" days={buildTrendDays(activities, endDate, range, 'urine')} useAmount={false} unit="次" />
        </View>
      ) : filter === 'vaccine' || filter === 'medical' ? (
        <PreventiveTimeline days={days} label={selectedLabel} />
      ) : filter === 'water' ? (
        <TrendLine days={days} unit="ml" />
      ) : (
        <TrendBars
          days={days}
          useAmount={useAmount}
          unit={unit}
          showAlerts={filter === 'stool' || filter === 'urine'}
        />
      )}

      <View style={styles.trendInsightRow}>
        <Text style={styles.trendInsightIcon}>{alertDays ? '!' : 'i'}</Text>
        <Text style={styles.trendInsightText}>{insight}</Text>
      </View>
      <Text style={styles.trendDisclaimer}>趨勢僅供日常觀察，不能取代獸醫診斷。</Text>
    </View>
  );
}

function TimelineItem({
  activity,
  isLast,
  onPress,
}: {
  activity: ActivityRecord;
  isLast: boolean;
  onPress?: () => void;
}) {
  return (
    <View style={styles.timelineRow}>
      <View style={styles.timelineRail}>
        <View style={[styles.timelineIcon, { backgroundColor: `${activity.tone}1F` }]}>
          {activity.kind === 'urine' ? <UrinePuddleIcon size={19} /> : <Text style={styles.timelineEmoji}>{activity.icon}</Text>}
        </View>
        {!isLast && <View style={styles.timelineLine} />}
      </View>
      <Pressable
        accessibilityRole={onPress ? 'button' : undefined}
        accessibilityLabel={onPress ? `查看 ${activity.title} 記錄` : undefined}
        disabled={!onPress}
        style={[styles.timelineContent, !isLast && styles.timelineContentBorder]}
        onPress={onPress}
      >
        <View style={styles.timelineTitleRow}>
          <Text style={styles.timelineTitle}>{activity.title}{activity.petName ? `・${activity.petName}` : ''}</Text>
          <Text style={styles.timelineTime}>{formatActivityTime(activity.occurredAt).replace('今天 ', '').replace('昨天 ', '')}</Text>
        </View>
        <Text style={styles.timelineDetail}>{activity.detail}</Text>
        {activity.syncStatus ? (
          <Text style={[styles.timelineSyncStatus, activity.syncStatus === 'failed' && styles.timelineSyncStatusFailed]}>
            {activity.syncStatus === 'syncing' ? '正在同步' : activity.syncStatus === 'failed' ? '同步失敗・本機資料已保留' : '等待同步'}
          </Text>
        ) : null}
        {onPress ? <Text style={styles.timelineEditHint}>點擊查看或修改</Text> : null}
      </Pressable>
    </View>
  );
}

type ActivityFormState = {
  nameValue: string;
  amountValue: string;
  noteValue: string;
  foodType: string;
  stoolTexture: string;
  stoolColor: string;
  stoolStatus: string;
  urineColor: string;
};

type ActivityFormSetters = {
  setNameValue: (value: string) => void;
  setAmountValue: (value: string) => void;
  setNoteValue: (value: string) => void;
  setFoodType: (value: string) => void;
  setStoolTexture: (value: string) => void;
  setStoolColor: (value: string) => void;
  setStoolStatus: (value: string) => void;
  setUrineColor: (value: string) => void;
};

function activityFieldConfig(kind: ActivityKind) {
  return {
    meal: { nameLabel: '', namePlaceholder: '', amountLabel: '份量（g）', numeric: true },
    water: { nameLabel: '', namePlaceholder: '', amountLabel: '飲水量（ml）', numeric: true },
    medication: { nameLabel: '藥物名稱', namePlaceholder: '例如：過敏藥', amountLabel: '劑量', numeric: false },
    stool: { nameLabel: '', namePlaceholder: '', amountLabel: '', numeric: false },
    urine: { nameLabel: '', namePlaceholder: '', amountLabel: '', numeric: false },
    vaccine: { nameLabel: '疫苗名稱', namePlaceholder: '例如：八合一疫苗', amountLabel: '', numeric: false },
    medical: { nameLabel: '驅蟲藥名稱', namePlaceholder: '例如：全能狗 S', amountLabel: '', numeric: false },
  }[kind];
}

function ActivityStructuredFields({ kind, values, setters }: { kind: ActivityKind; values: ActivityFormState; setters: ActivityFormSetters }) {
  const config = activityFieldConfig(kind);
  return (
    <>
      {kind === 'meal' ? <SelectField label="食物種類" value={values.foodType} options={foodTypeOptions} onChange={setters.setFoodType} /> : null}
      {kind === 'stool' ? (
        <>
          <SelectField label="便便質地" value={values.stoolTexture} options={stoolTextureOptions} onChange={setters.setStoolTexture} />
          <SelectField label="便便顏色" value={values.stoolColor} options={stoolColorOptions} onChange={setters.setStoolColor} />
          <SelectField label="排便狀態" value={values.stoolStatus} options={stoolStatusOptions} onChange={setters.setStoolStatus} />
        </>
      ) : null}
      {kind === 'urine' ? <SelectField label="尿液顏色" value={values.urineColor} options={urineColorOptions} onChange={setters.setUrineColor} /> : null}
      {config.nameLabel ? <FormField label={config.nameLabel} placeholder={config.namePlaceholder} value={values.nameValue} onChangeText={setters.setNameValue} /> : null}
      {kind === 'medication' ? (
        <View style={styles.formNoticeCard}>
          <Text style={styles.formNoticeIcon}>ⓘ</Text>
          <Text style={styles.formNoticeText}>若是首頁提醒中的藥物，請直接在提醒卡點「完成」，系統會自動建立紀錄。此處只用於補登或非排程藥物，避免重複。</Text>
        </View>
      ) : null}
      {config.amountLabel ? (
        <FormField
          label={config.amountLabel}
          placeholder={kind === 'medication' ? '例如：5 mg、半錠' : '輸入正整數'}
          value={values.amountValue}
          onChangeText={setters.setAmountValue}
          keyboardType={config.numeric ? 'number-pad' : 'default'}
        />
      ) : null}
      <FormField label="備註（選填）" placeholder="例如：已吃完、飯後服用" value={values.noteValue} onChangeText={setters.setNoteValue} multiline />
    </>
  );
}

function EditActivityModal({
  activity,
  onClose,
  onSave,
  onDelete,
}: {
  activity: ActivityRecord | null;
  onClose: () => void;
  onSave: (activityId: string, changes: ActivityInput) => Promise<void>;
  onDelete: (activityId: string) => void;
}) {
  const [nameValue, setNameValue] = useState('');
  const [amountValue, setAmountValue] = useState('');
  const [noteValue, setNoteValue] = useState('');
  const [foodType, setFoodType] = useState('乾糧');
  const [stoolTexture, setStoolTexture] = useState('正常');
  const [stoolColor, setStoolColor] = useState('巧克力棕');
  const [stoolStatus, setStoolStatus] = useState('正常');
  const [urineColor, setUrineColor] = useState('未知');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!activity) return;
    setNameValue(activity.kind === 'medication' ? activity.medicationName ?? activity.title : activity.kind === 'vaccine' || activity.kind === 'medical' ? activity.title : '');
    setAmountValue(activity.kind === 'medication' ? activity.medicationDose ?? '' : activity.amount == null ? '' : String(activity.amount));
    setNoteValue(activity.note ?? '');
    setFoodType(activity.foodType ? foodTypeFromDatabase[activity.foodType] : '乾糧');
    setStoolTexture(activity.stoolTexture ? stoolTextureFromDatabase[activity.stoolTexture] : '正常');
    setStoolColor(activity.stoolColor ? stoolColorFromDatabase[activity.stoolColor] : '巧克力棕');
    setStoolStatus(activity.stoolStatus ? stoolStatusFromDatabase[activity.stoolStatus] : '正常');
    setUrineColor(activity.urineColor ? urineColorFromDatabase[activity.urineColor] : '未知');
    setConfirmDelete(false);
    setSaving(false);
  }, [activity]);

  if (!activity) return null;

  const occurredDate = new Date(activity.occurredAt);
  const lockedTime = `${occurredDate.getFullYear()}/${occurredDate.getMonth() + 1}/${occurredDate.getDate()} ${String(occurredDate.getHours()).padStart(2, '0')}:${String(occurredDate.getMinutes()).padStart(2, '0')}`;

  const save = async () => {
    if ((activity.kind === 'meal' || activity.kind === 'water') && !isPositiveIntegerInput(amountValue)) {
      const fieldName = activity.kind === 'meal' ? '飲食份量' : '飲水量';
      const example = activity.kind === 'meal' ? '120' : '250';
      Alert.alert('輸入格式不正確', `${fieldName}請輸入大於 0 的正整數，例如 ${example}。`);
      return;
    }
    const config = activityFieldConfig(activity.kind);
    if (config.nameLabel && !nameValue.trim()) {
      Alert.alert('還差一個欄位', `請輸入${config.nameLabel}。`);
      return;
    }
    if (activity.kind === 'medication' && !amountValue.trim()) {
      Alert.alert('還差一個欄位', '請輸入藥物劑量，例如 5 mg 或半錠。');
      return;
    }

    const numericAmount = Number(amountValue);
    const noteSuffix = noteValue.trim() ? `・${noteValue.trim()}` : '';
    let title = activityPresentation[activity.kind].title;
    let detail = '';
    if (activity.kind === 'meal') detail = `${foodType} ${numericAmount} g${noteSuffix}`;
    if (activity.kind === 'water') detail = `${numericAmount} ml${noteSuffix}`;
    if (activity.kind === 'medication') { title = nameValue.trim(); detail = `劑量 ${amountValue.trim()}${noteSuffix}`; }
    if (activity.kind === 'stool') detail = `質地：${stoolTexture}・顏色：${stoolColor}・排便狀態：${stoolStatus}${noteSuffix}`;
    if (activity.kind === 'urine') detail = `尿液顏色：${urineColor}${noteSuffix}`;
    if (activity.kind === 'vaccine') { title = nameValue.trim(); detail = `疫苗接種${noteSuffix}`; }
    if (activity.kind === 'medical') { title = nameValue.trim(); detail = `${nameValue.trim()}${noteSuffix}`; }

    setSaving(true);
    try {
      await onSave(activity.id, {
        kind: activity.kind,
        icon: activity.icon,
        tone: activity.tone,
        title,
        detail,
        amount: activity.kind === 'meal' || activity.kind === 'water' ? numericAmount : undefined,
        unit: activity.kind === 'meal' ? 'g' : activity.kind === 'water' ? 'ml' : undefined,
        note: noteValue.trim() || undefined,
        foodType: activity.kind === 'meal' ? foodTypeToDatabase[foodType as keyof typeof foodTypeToDatabase] : undefined,
        medicationName: activity.kind === 'medication' ? nameValue.trim() : undefined,
        medicationDose: activity.kind === 'medication' ? amountValue.trim() : undefined,
        stoolTexture: activity.kind === 'stool' ? stoolTextureToDatabase[stoolTexture as keyof typeof stoolTextureToDatabase] : undefined,
        stoolColor: activity.kind === 'stool' ? stoolColorToDatabase[stoolColor as keyof typeof stoolColorToDatabase] : undefined,
        stoolStatus: activity.kind === 'stool' ? stoolStatusToDatabase[stoolStatus as keyof typeof stoolStatusToDatabase] : undefined,
        urineColor: activity.kind === 'urine' ? urineColorToDatabase[urineColor as keyof typeof urineColorToDatabase] : undefined,
        petId: activity.petId,
        ownerId: activity.ownerId,
        petName: activity.petName,
      });
    } catch {
      // 上層會顯示資料庫錯誤；保留表單內容與詳情視窗供使用者重試。
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.modalBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <SafeAreaView edges={['bottom', 'left', 'right']} style={styles.modalSheet}>
          <View style={styles.modalHandle} />
          <Text style={styles.modalTitle}>記錄詳情</Text>
          <Text style={styles.modalSubtitle}>可以修改內容或刪除記錄，發生時間永久鎖定。</Text>

          <View style={styles.lockedTimeCard}>
            <View>
              <Text style={styles.lockedTimeLabel}>記錄時間</Text>
              <Text style={styles.lockedTimeValue}>{lockedTime}</Text>
            </View>
            <View style={styles.lockedTimePill}><Text style={styles.lockedTimePillText}>🔒 不可修改</Text></View>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <ActivityStructuredFields
              kind={activity.kind}
              values={{ nameValue, amountValue, noteValue, foodType, stoolTexture, stoolColor, stoolStatus, urineColor }}
              setters={{ setNameValue, setAmountValue, setNoteValue, setFoodType, setStoolTexture, setStoolColor, setStoolStatus, setUrineColor }}
            />

          {confirmDelete ? (
            <View style={styles.deleteConfirmCard}>
              <Text style={styles.deleteConfirmTitle}>確定刪除這筆記錄？</Text>
              <Text style={styles.deleteConfirmText}>刪除後不會再出現在每日統計中。</Text>
              <View style={styles.deleteConfirmActions}>
                <TouchableOpacity style={styles.deleteCancelButton} onPress={() => setConfirmDelete(false)}>
                  <Text style={styles.deleteCancelButtonText}>取消</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.deleteConfirmButton} onPress={() => onDelete(activity.id)}>
                  <Text style={styles.deleteConfirmButtonText}>確認刪除</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <TouchableOpacity style={styles.deleteRecordButton} onPress={() => setConfirmDelete(true)}>
              <Text style={styles.deleteRecordButtonText}>刪除這筆記錄</Text>
            </TouchableOpacity>
          )}

           <TouchableOpacity disabled={saving} style={[styles.formSaveButton, saving && styles.formSaveButtonDisabled]} onPress={() => void save()}>
             <Text style={styles.formSaveButtonText}>{saving ? '儲存中…' : '儲存修改'}</Text>
          </TouchableOpacity>
           <TouchableOpacity style={styles.formCancelButton} onPress={onClose}>
            <Text style={styles.formCancelButtonText}>關閉</Text>
           </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function CameraScreen({
  pet,
  isPreview,
  initialPhotoUri,
  initialCapturedAt,
  initialCaptureMethod,
  onClose,
  onReturnHome,
  onStartSmartBin,
}: {
  pet: PetRow;
  isPreview: boolean;
  initialPhotoUri: string | null;
  initialCapturedAt: string | null;
  initialCaptureMethod: StoolObservationRow['capture_method'];
  onClose: () => void;
  onReturnHome: () => void;
  onStartSmartBin: (observationId: string) => void;
}) {
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [step, setStep] = useState<CameraStep>(initialPhotoUri ? 'captured' : 'idle');
  const [photoUri, setPhotoUri] = useState<string | null>(initialPhotoUri);
  const [captureMethod, setCaptureMethod] = useState<StoolObservationRow['capture_method']>(initialCaptureMethod);
  const [capturedAt, setCapturedAt] = useState(initialCapturedAt ?? new Date().toISOString());
  const [observation, setObservation] = useState<StoolObservationRow | null>(null);
  const [analysisTrace, setAnalysisTrace] = useState<StoolAnalysisTrace | null>(null);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [cameraZoom, setCameraZoom] = useState(0);
  const [cameraViewport, setCameraViewport] = useState<ImageSize | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const guideFrame = useMemo(
    () => cameraViewport ? calculateStoolGuideFrame(cameraViewport) : null,
    [cameraViewport],
  );

  const requestClose = useCallback(() => {
    if (step === 'success') {
      onReturnHome();
      return;
    }
    if (step === 'awaiting_review') {
      onClose();
      return;
    }
    if (!photoUri) {
      onClose();
      return;
    }
    Alert.alert('放棄目前照片？', '返回後，這張尚未儲存的照片會從目前流程移除。', [
      { text: '繼續拍攝', style: 'cancel' },
      { text: '放棄照片', style: 'destructive', onPress: onClose },
    ]);
  }, [onClose, onReturnHome, photoUri, step]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      requestClose();
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, [requestClose]);

  useEffect(() => {
    if (step === 'success' && captureMethod === 'live_camera' && observation?.id) {
      onStartSmartBin(observation.id);
    }
  }, [captureMethod, observation?.id, onStartSmartBin, step]);

  const renderCameraTab = (content: ReactNode) => (
    <View testID="stool-camera-flow" style={styles.tabScreen}>
      <View style={styles.tabHeader}>
        <View style={styles.pageHeader}>
          <View style={styles.cameraHeaderLeft}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="返回便便記錄方式" style={styles.cameraBackButton} onPress={requestClose}>
              <Text style={styles.cameraBackButtonText}>‹</Text>
            </TouchableOpacity>
            <View style={styles.cameraHeaderCopy}>
            <Text style={styles.eyebrow}>目前寵物：{pet.name}</Text>
            <Text style={styles.pageTitle}>{captureMethod === 'gallery_upload' ? '便便圖片辨識' : '便便拍照'}</Text>
            </View>
          </View>
        </View>
      </View>
      <View style={styles.cameraTabBody}>{content}</View>
    </View>
  );

  const takePhoto = async () => {
    if (!cameraViewport || !guideFrame) {
      Alert.alert('相機尚未準備完成', '請稍候一秒，等取景框出現後再拍攝。');
      return;
    }
    try {
      const photo = await cameraRef.current?.takePictureAsync({ quality: 1, shutterSound: false });
      if (!photo?.uri) return;
      const prepared = await prepareStoolRoiImage(
        photo.uri,
        mapGuideFrameToPhotoCrop(
          cameraViewport,
          { width: photo.width, height: photo.height },
          guideFrame,
        ),
      );
      setTorchEnabled(false);
      setCaptureMethod('live_camera');
      setCapturedAt(new Date().toISOString());
      setPhotoUri(prepared.uri);
      setStep('captured');
    } catch {
      Alert.alert('無法拍攝', '請確認相機權限後再試一次。');
    }
  };

  const startVerification = async () => {
    if (!photoUri) return;
    if (isPreview) {
      Alert.alert('預覽模式不會上傳', '請登入測試帳號後再執行真正的影像分析。');
      return;
    }
    setErrorMessage(null);
    try {
      setStep('uploading');
      const created = await createStoolObservation({
        petId: pet.id,
        clientRequestKey: createStoolClientRequestKey(),
        capturedAt,
        capturedTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Taipei',
        captureMethod,
      });
      setObservation(created.observation);
      await uploadAndQueueStoolImage({
        observationId: created.observation.id,
        mediaPath: created.mediaPath,
        uri: photoUri,
        inputRoiVersion: STOOL_CAPTURE_ROI_VERSION,
        preprocessingVersion: STOOL_MODEL_PREPROCESSING_VERSION,
      });
      setStep('analysing');
      const result = await analyzeStoolObservation(created.observation.id);
      setObservation(result.observation);
      setAnalysisTrace(result.trace ?? null);
      if (result.observation.analysis_status === 'completed') {
        setStep('success');
      } else {
        setStep('awaiting_review');
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '影像分析暫時失敗，請稍後重試。');
      setStep('error');
    }
  };

  const resetCamera = () => {
    setPhotoUri(null);
    setObservation(null);
    setAnalysisTrace(null);
    setTorchEnabled(false);
    setCaptureMethod('live_camera');
    setCapturedAt(new Date().toISOString());
    setErrorMessage(null);
    setStep('idle');
  };

  if (!photoUri && !permission) {
    return renderCameraTab(<View style={styles.cameraLoading}><ActivityIndicator color="#2D6A4F" /></View>);
  }

  if (!photoUri && !permission?.granted) {
    return renderCameraTab(
      <View style={styles.permissionScreen}>
        <View style={styles.permissionIcon}><Text style={styles.permissionEmoji}>📷</Text></View>
        <Text style={styles.permissionTitle}>需要相機權限</Text>
        <Text style={styles.permissionText}>
          即時拍攝需要相機權限；你也可以返回並改用相簿入口。送出後照片會上傳供辨識與必要人工複核，不會自動作為模型訓練資料。
        </Text>
        <TouchableOpacity accessibilityRole="button" style={styles.primaryButton} onPress={requestPermission}>
          <Text style={styles.primaryButtonText}>開啟相機</Text>
        </TouchableOpacity>
      </View>,
    );
  }

  if (photoUri) {
    return renderCameraTab(
      <View style={styles.cameraPage}>
        <Image source={{ uri: photoUri }} style={styles.capturedImage} />
        <View style={styles.cameraShadeTop}>
          <Text style={styles.cameraInstructionText}>
            {captureMethod === 'gallery_upload'
              ? `相簿來源・已套用 ${STOOL_CAPTURE_ROI_VERSION} 中央裁切`
              : `即時拍攝・只送出框內的 ${STOOL_CAPTURE_ROI_VERSION} 影像`}
          </Text>
        </View>

        {(step === 'uploading' || step === 'analysing') && (
          <View style={styles.analysisOverlay}>
            <View style={styles.analysisCard}>
              <ActivityIndicator size="large" color="#2D6A4F" />
              <Text style={styles.analysisTitle}>{step === 'uploading' ? '安全上傳中' : '模型辨識中'}</Text>
              <Text style={styles.analysisText}>{step === 'uploading' ? '正在傳送已裁切、重新編碼的私有 ROI 影像。' : '正在產生實驗候選答案；未偵測到便便或無法確定時會送交人工審核。'}</Text>
            </View>
          </View>
        )}

        {step === 'success' && (
          <View style={styles.resultSheet}>
            <View style={styles.successIcon}><Text style={styles.successMark}>✓</Text></View>
            <View style={styles.resultHeading}>
              <Text style={styles.resultTitle}>辨識成功</Text>
              <Text style={styles.resultConfidence}>已辨識到疑似便便</Text>
            </View>
            <Text style={styles.resultText}>
              {captureMethod === 'live_camera'
                ? '你可以繼續體驗公共智能垃圾桶的模擬領袋與投放流程。'
                : '相簿圖片不能啟動垃圾桶；只有即時拍攝的原型任務可以繼續。'}
            </Text>
            <View style={styles.resultNotice}>
              <Text style={styles.resultNoticeText}>這是未校準模型的候選結果，不是人工確認、準確率或健康診斷。</Text>
            </View>
            {captureMethod === 'live_camera' ? (
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="開始模擬智能垃圾桶流程" style={styles.primaryButton} onPress={() => onStartSmartBin(observation?.id ?? 'simulated-observation')}>
                <Text style={styles.primaryButtonText}>尋找智能垃圾桶</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="返回桌面" style={styles.secondaryButton} onPress={onReturnHome}>
              <Text style={styles.secondaryButtonText}>返回桌面</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === 'awaiting_review' && (
          <View style={styles.resultSheet}>
            <View style={styles.successIcon}><Text style={styles.successMark}>i</Text></View>
            <View style={styles.resultHeading}>
              <Text style={styles.resultTitle}>
                {analysisTrace?.candidateCode === 'absent'
                  ? '模型實驗判斷：未偵測到便便'
                  : '模型實驗判斷：無法確定'}
              </Text>
              <Text style={styles.resultConfidence}>
                {observation?.latest_confidence == null ? '模型原始分數未提供' : `未校準模型原始分數 ${formatUncalibratedDetectionScore(observation.latest_confidence)}`}
              </Text>
            </View>
            <Text style={styles.resultText}>
              這是未校準的模型候選答案，不是準確率或健康診斷。照片已自動送交後端人工審核，使用者不需要確認或修正。
            </Text>
            <View style={styles.resultNotice}>
              <Text style={styles.resultNoticeText}>這是物件存在辨識，不是健康診斷；照片目前只供服務與複核，不會自動加入訓練集。</Text>
            </View>
            {analysisTrace ? (
              <View style={styles.analysisTraceCard}>
                <Text style={styles.analysisTraceTitle}>此次處理軌跡（可供查核）</Text>
                <Text style={styles.analysisTraceText}>來源：{captureMethod === 'gallery_upload' ? '相簿選擇' : '即時拍攝'}</Text>
                <Text numberOfLines={1} style={styles.analysisTraceText}>工作編號：{analysisTrace.observationId}</Text>
                <Text numberOfLines={1} style={styles.analysisTraceText}>模型：{analysisTrace.modelVersion}</Text>
                <Text numberOfLines={1} style={styles.analysisTraceText}>模型類型：{analysisTrace.modelFamily ?? '未提供'}</Text>
                <Text numberOfLines={1} style={styles.analysisTraceText}>輸入 ROI：{analysisTrace.inputRoiVersion ?? '舊版全圖輸入'}</Text>
                <Text numberOfLines={1} style={styles.analysisTraceText}>前處理：{analysisTrace.preprocessingVersion ?? '未提供'}</Text>
                <Text style={styles.analysisTraceText}>
                  模型候選：{analysisTrace.candidateCode === 'present' ? '疑似有便便' : analysisTrace.candidateCode === 'absent' ? '未偵測到便便' : '無法確定'}
                </Text>
                <Text numberOfLines={1} style={styles.analysisTraceText}>分數類型：{analysisTrace.scoreKind ?? '未提供'}</Text>
                <Text style={styles.analysisTraceText}>原始分數：{formatUncalibratedDetectionScore(analysisTrace.rawScore ?? observation?.latest_confidence)}</Text>
                {analysisTrace.activationCountAboveFloor == null ? null : (
                  <Text style={styles.analysisTraceText}>
                    高於上游驗證啟用值的 activation：{analysisTrace.activationCountAboveFloor}
                    {analysisTrace.activationFloor == null ? '' : `（啟用值 ${formatUncalibratedDetectionScore(analysisTrace.activationFloor)}）`}
                  </Text>
                )}
                <Text style={styles.analysisTraceText}>門檻版本：{analysisTrace.thresholdSetVersion ?? '未提供'}・耗時 {analysisTrace.latencyMs} ms</Text>
                <Text style={styles.analysisTraceWarning}>
                  {analysisTrace.modelFamily === 'mobilenet_binary_v1'
                    ? '這是未校準的二分類 softmax 相對分數，不是機率、準確率或健康診斷；可用工作編號對照後端日誌。'
                    : '這是未校準模型 activation，不是便便存在機率或準確率；可用工作編號對照後端日誌。'}
                </Text>
              </View>
            ) : null}
            <TouchableOpacity style={styles.secondaryButton} onPress={resetCamera}>
              <Text style={styles.secondaryButtonText}>{captureMethod === 'gallery_upload' ? '改用相機' : '重新拍攝'}</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === 'error' && (
          <View style={styles.resultSheet}>
            <View style={styles.resultHeading}>
              <Text style={styles.resultTitle}>這次未能完成分析</Text>
              <Text style={styles.resultConfidence}>照片不會被視為已辨識</Text>
            </View>
            <Text style={styles.resultText}>{errorMessage}</Text>
            <TouchableOpacity style={styles.primaryButton} onPress={() => void startVerification()}>
              <Text style={styles.primaryButtonText}>重試</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryButton} onPress={resetCamera}>
              <Text style={styles.secondaryButtonText}>{captureMethod === 'gallery_upload' ? '改用相機' : '重新拍攝'}</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === 'captured' && (
          <View style={styles.captureReview}>
            <Text style={styles.reviewTitle}>照片清楚嗎？</Text>
            <Text style={styles.reviewText}>
              {captureMethod === 'gallery_upload'
                ? '這是相簿圖片，不是即時拍攝；請確認便便完整入鏡，並避免人物、車牌或門牌。'
                : '請確認便便完整留在框選裁切範圍內，避免人物、車牌或門牌。'}
            </Text>
            <View style={styles.reviewActions}>
              <TouchableOpacity style={styles.reviewSecondary} onPress={resetCamera}>
                <Text style={styles.reviewSecondaryText}>{captureMethod === 'gallery_upload' ? '改用相機' : '重拍'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.reviewPrimary} onPress={startVerification}>
                <Text style={styles.reviewPrimaryText}>送出辨識</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

      </View>,
    );
  }

  return renderCameraTab(
    <View
      style={styles.cameraPage}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        if (width > 0 && height > 0) setCameraViewport({ width, height });
      }}
    >
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" enableTorch={torchEnabled} zoom={cameraZoom} />
      <View style={styles.cameraShadeTop}>
        <Text style={styles.cameraInstructionText}>請將便便完整放在框內・送出時只保留框內影像</Text>
      </View>
      {guideFrame ? <View
        testID="stool-capture-roi-guide"
        accessible
        accessibilityLabel="便便拍攝裁切框，請將便便完整放在框內"
        pointerEvents="none"
        style={[
          styles.guideFrame,
          {
            left: guideFrame.originX,
            top: guideFrame.originY,
            width: guideFrame.width,
            height: guideFrame.height,
          },
        ]}
      >
        <View style={[styles.guideCorner, styles.guideTopLeft]} />
        <View style={[styles.guideCorner, styles.guideTopRight]} />
        <View style={[styles.guideCorner, styles.guideBottomLeft]} />
        <View style={[styles.guideCorner, styles.guideBottomRight]} />
      </View> : null}
      <View style={styles.cameraBottom}>
        <View style={styles.liveOnlyPill}>
          <Text style={styles.liveOnlyText}>●  即時相機模式</Text>
        </View>
        <View style={styles.cameraControlsShade}>
          <View accessibilityLabel="調整相機縮放倍率" style={styles.cameraZoomControls}>
            {[
              { label: '1×', value: 0 },
              { label: '約 2×', value: 0.16 },
              { label: '約 3×', value: 0.32 },
            ].map((option) => {
              const selected = cameraZoom === option.value;
              return (
                <TouchableOpacity
                  key={option.label}
                  accessibilityRole="button"
                  accessibilityLabel={`相機縮放${option.label}`}
                  accessibilityState={{ selected }}
                  style={[styles.cameraZoomButton, selected && styles.cameraZoomButtonActive]}
                  onPress={() => setCameraZoom(option.value)}
                >
                  <Text style={[styles.cameraZoomButtonText, selected && styles.cameraZoomButtonTextActive]}>{option.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={styles.cameraZoomHint}>倍率會依手機鏡頭能力近似換算</Text>
          <View style={styles.cameraCaptureControls}>
            <TouchableOpacity
              accessibilityLabel={torchEnabled ? '關閉閃光燈' : '開啟閃光燈'}
              accessibilityRole="switch"
              accessibilityState={{ checked: torchEnabled }}
              style={[styles.torchButton, torchEnabled && styles.torchButtonActive]}
              onPress={() => setTorchEnabled((current) => !current)}
            >
              <Text style={[styles.torchButtonText, torchEnabled && styles.torchButtonTextActive]}>⚡</Text>
            </TouchableOpacity>
            <TouchableOpacity accessibilityLabel="拍照" style={styles.shutterOuter} onPress={takePhoto}>
              <View style={styles.shutterInner} />
            </TouchableOpacity>
            <View style={styles.cameraControlSpacer} />
          </View>
          <Text style={styles.cameraHint}>拍攝時請注意周遭環境安全</Text>
        </View>
      </View>
    </View>,
  );
}

function ProfileScreen({
  accountEmail,
  displayName,
  petProfile,
  onEditAccount,
  onEditPet,
  onReviewStool,
  onManageMedication,
  onManageCollaboration,
  onAddPet,
  onSignOut,
}: {
  accountEmail: string;
  displayName: string;
  petProfile: PetProfile;
  onEditAccount: () => void;
  onEditPet: () => void;
  onReviewStool?: () => void;
  onManageMedication: () => void;
  onManageCollaboration: () => void;
  onAddPet: () => void;
  onSignOut: () => void;
}) {
  return (
    <View style={styles.tabScreen}>
      <View style={styles.tabHeader}>
        <View style={styles.pageHeader}>
          <View>
            <Text style={styles.eyebrow}>文明飼主計畫</Text>
            <Text style={styles.pageTitle}>我的足跡</Text>
          </View>
          <TouchableOpacity accessibilityLabel="編輯帳號暱稱" style={styles.userAvatar} onPress={onEditAccount}>
            <Text style={styles.userAvatarText}>{displayName.trim().charAt(0) || '毛'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView style={styles.tabScroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <TouchableOpacity accessibilityRole="button" style={styles.accountCard} activeOpacity={0.8} onPress={onEditAccount}>
        <View style={styles.accountIcon}><Text style={styles.accountIconText}>♙</Text></View>
        <View style={styles.accountInfo}>
          <Text style={styles.accountLabel}>帳號暱稱</Text>
          <Text style={styles.accountDisplayName} numberOfLines={1}>{displayName}</Text>
          <Text style={styles.accountEmail} numberOfLines={1}>{accountEmail}</Text>
        </View>
        <View style={styles.cloudPill}><Text style={styles.cloudPillText}>編輯</Text></View>
        </TouchableOpacity>

      <TouchableOpacity style={styles.profilePetCard} activeOpacity={0.8} onPress={onEditPet}>
        <View style={styles.profilePetAvatar}><PetAvatarContent profile={petProfile} iconSize={29} /></View>
        <View style={styles.profilePetInfo}>
          <Text style={styles.profilePetName}>{petProfile.name}</Text>
          <Text style={styles.profilePetMeta}>
            {petProfile.breed}・{petProfile.sterilizationStatus}・每日 {petProfile.mealsPerDay} 餐・飲水目標 {petProfile.waterGoalMl} ml
          </Text>
        </View>
        <View style={styles.editPill}><Text style={styles.editPillText}>編輯</Text></View>
      </TouchableOpacity>

      <View style={styles.creditCard}>
        <View style={styles.creditGlow} />
        <Text style={styles.creditOverline}>環境友善積分</Text>
        <View style={styles.creditScoreRow}>
          <Text style={styles.creditScore}>0</Text>
          <Text style={styles.creditUnit}>分</Text>
        </View>
        <Text style={styles.creditLevel}>尚未開始累積</Text>
        <View style={styles.creditProgress}><View style={[styles.creditProgressFill, { width: '0%' }]} /></View>
        <Text style={styles.creditHint}>積分功能仍在規劃中；目前的拍攝原型不會產生積分</Text>
      </View>

      <View style={styles.statRow}>
        <StatCard value="0" label="本月驗證" />
        <StatCard value="0" label="累積撿便" />
        <StatCard value="0" label="連續天數" />
      </View>

      <View style={styles.rulesCard}>
        <Text style={styles.rulesTitle}>未來積分預計如何產生？</Text>
        <RuleRow number="1" text="規劃：App 即時拍攝並完成初步辨識" />
        <RuleRow number="2" text="規劃：現場垃圾桶以 BLE 與短效憑證驗證" />
        <RuleRow number="3" text="規劃：由出袋及投入口感測器確認事件" />
        <Text style={styles.rulesFootnote}>積分是正向鼓勵，不作為醫療、法律或個人信用評分。</Text>
      </View>

      <TouchableOpacity style={styles.lostPetCard} onPress={() => Alert.alert('寵物協尋', '此功能預計於第三階段推出')}>
        <View style={styles.lostPetIcon}><Text style={styles.lostPetEmoji}>🔎</Text></View>
        <View style={styles.lostPetContent}>
          <View style={styles.comingPill}><Text style={styles.comingPillText}>規劃中</Text></View>
          <Text style={styles.lostPetTitle}>AI 寵物協尋</Text>
          <Text style={styles.lostPetText}>依外觀特徵與地點，媒合最相近的拾獲資訊</Text>
        </View>
        <Text style={styles.chevronRight}>›</Text>
      </TouchableOpacity>

      <View style={styles.menuCard}>
        {[
          { label: '帳號暱稱', onPress: onEditAccount },
          { label: '新增另一隻寵物', onPress: onAddPet },
          { label: '共同照護者與權限', onPress: onManageCollaboration },
          { label: '寵物資料與照護目標', onPress: onEditPet },
          ...(onReviewStool ? [{ label: '便便影像人工審核', onPress: onReviewStool }] : []),
          { label: '用藥與提醒', onPress: onManageMedication },
          { label: '疫苗與驅蟲設定', onPress: undefined },
          { label: '隱私與資料匯出', onPress: undefined },
          { label: '客服與意見回饋', onPress: undefined },
        ].map((item, index, items) => (
          <TouchableOpacity
            key={item.label}
            style={[styles.menuRow, index < items.length - 1 && styles.menuRowBorder]}
            onPress={item.onPress}
          >
            <Text style={styles.menuText}>{item.label}</Text>
            <Text style={styles.chevronRight}>›</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity accessibilityRole="button" style={styles.signOutButton} onPress={onSignOut}>
        <Text style={styles.signOutButtonText}>登出帳號</Text>
      </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

function StatCard({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function RuleRow({ number, text }: { number: string; text: string }) {
  return (
    <View style={styles.ruleRow}>
      <View style={styles.ruleNumber}><Text style={styles.ruleNumberText}>{number}</Text></View>
      <Text style={styles.ruleText}>{text}</Text>
    </View>
  );
}

function PreventiveCareModal({
  visible,
  initialKind,
  schedules,
  ownerId,
  petId,
  onClose,
  onSave,
  onComplete,
}: {
  visible: boolean;
  initialKind: PreventiveCareKind;
  schedules: PreventiveCareScheduleRow[];
  ownerId: string;
  petId: string;
  onClose: () => void;
  onSave: (schedule: PreventiveCareScheduleInput) => Promise<void>;
  onComplete: (schedule: PreventiveCareScheduleRow) => Promise<void>;
}) {
  const kind = initialKind;
  const [title, setTitle] = useState(kind === 'vaccine' ? '疫苗' : '');
  const [intervalMonths, setIntervalMonths] = useState(kind === 'vaccine' ? '12' : '1');
  const [lastCompletedOn, setLastCompletedOn] = useState(formatDateValue(new Date()));
  const [note, setNote] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);
  const [isConfirmingComplete, setIsConfirmingComplete] = useState(false);
  const [isConfirmingSave, setIsConfirmingSave] = useState(false);

  const activeSchedule = schedules.find((item) => item.kind === kind);
  const today = formatDateValue(new Date());
  const canComplete = Boolean(activeSchedule && activeSchedule.next_due_on <= today);
  const remainingDays = activeSchedule
    ? Math.max(0, Math.round(((parseDateValue(activeSchedule.next_due_on)?.getTime() ?? Date.now()) - (parseDateValue(today)?.getTime() ?? Date.now())) / 86_400_000))
    : 0;
  const intervalOptions: SelectOption[] = [
    { label: '一個月', value: '1' },
    { label: '兩個月', value: '2' },
    { label: '三個月', value: '3' },
  ];

  useEffect(() => {
    if (visible) {
      setIsConfirmingComplete(false);
      setIsConfirmingSave(false);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const schedule = schedules.find((item) => item.kind === initialKind);
    const existingDewormInterval = schedule && [1, 2, 3].includes(schedule.interval_months)
      ? String(schedule.interval_months)
      : '1';
    setTitle(initialKind === 'vaccine' ? '疫苗' : schedule?.title ?? '');
    setIntervalMonths(initialKind === 'vaccine' ? '12' : existingDewormInterval);
    setLastCompletedOn(schedule?.last_completed_on ?? today);
    setNote(schedule?.note ?? '');
    setIsConfirmingComplete(false);
    setIsConfirmingSave(false);
  }, [initialKind, schedules, today, visible]);

  const save = async () => {
    const months = Number(intervalMonths);
    const normalizedTitle = kind === 'vaccine' ? '疫苗' : title.trim();
    if (!normalizedTitle) {
      Alert.alert('請輸入驅蟲品牌');
      return;
    }
    if (!parseDateValue(lastCompletedOn) || lastCompletedOn > today) {
      Alert.alert('完成日不正確', '最近完成日不能晚於今天。');
      return;
    }
    if (kind === 'deworming' && ![1, 2, 3].includes(months)) {
      Alert.alert('請選擇一個月、兩個月或三個月');
      return;
    }

    setIsSaving(true);
    try {
      await onSave({
        owner_id: ownerId,
        pet_id: petId,
        kind,
        title: normalizedTitle,
        interval_months: months,
        last_completed_on: lastCompletedOn,
        next_due_on: addMonthsToDateValue(lastCompletedOn, months),
        note: note.trim() || null,
      });
      setIsConfirmingSave(false);
    } catch (error) {
      Alert.alert('儲存失敗', error instanceof Error ? error.message : '無法更新健康排程。');
    } finally {
      setIsSaving(false);
    }
  };

  const completeToday = async () => {
    if (!activeSchedule) return;
    setIsCompleting(true);
    try {
      await onComplete(activeSchedule);
      setIsConfirmingComplete(false);
      onClose();
    } catch (error) {
      Alert.alert('更新失敗', error instanceof Error ? error.message : '無法完成健康排程。');
    } finally {
      setIsCompleting(false);
    }
  };

  return (
    <>
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.modalBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.modalSheet, styles.preventiveCareSheet]}>
          <View style={styles.modalHandle} />
          <Text style={styles.modalTitle}>{kind === 'vaccine' ? '💉 疫苗提醒' : '🪱 驅蟲提醒'}</Text>
          <Text style={styles.modalSubtitle}>
            {kind === 'vaccine'
              ? '設定最近完成日後，每年提醒一次。'
              : '選擇品牌、週期與最近完成日，系統會自動計算下次提醒。'}
          </Text>

          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {kind === 'deworming' ? (
              <>
                <FormField label="驅蟲品牌" placeholder="例如：全能狗 S" value={title} onChangeText={setTitle} />
                <SelectField label="提醒週期" value={intervalMonths} options={intervalOptions} onChange={setIntervalMonths} />
              </>
            ) : (
              <View style={styles.preventiveCareFixedCycle}>
                <Text style={styles.preventiveCareFixedCycleLabel}>提醒週期</Text>
                <Text style={styles.preventiveCareFixedCycleValue}>每年一次</Text>
              </View>
            )}
            <CalendarDateField label="最近完成日" value={lastCompletedOn} onChange={setLastCompletedOn} maxDate={today} />
            <FormField label="備註（選填）" placeholder="品牌、劑量或獸醫提醒" value={note} onChangeText={setNote} multiline />

            {activeSchedule && isConfirmingSave ? (
              <View style={styles.preventiveCareConfirmBox}>
                <Text style={styles.preventiveCareConfirmText}>確定要更新這個提醒計畫嗎？更新後會立即重新計算下次提醒日期。</Text>
                <View style={styles.preventiveCareConfirmActions}>
                  <TouchableOpacity disabled={isSaving} style={styles.preventiveCareConfirmCancel} onPress={() => setIsConfirmingSave(false)}>
                    <Text style={styles.preventiveCareConfirmCancelText}>取消</Text>
                  </TouchableOpacity>
                  <TouchableOpacity disabled={isSaving} style={styles.preventiveCareConfirmSubmit} onPress={() => void save()}>
                    <Text style={styles.preventiveCareConfirmSubmitText}>{isSaving ? '更新中…' : '確認更新'}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={activeSchedule ? '更新計畫' : '建立計畫'}
                disabled={isSaving}
                style={styles.formSaveButton}
                onPress={() => activeSchedule ? setIsConfirmingSave(true) : void save()}
              >
                <Text style={styles.formSaveButtonText}>{isSaving ? '儲存中…' : activeSchedule ? '更新計畫' : '建立計畫'}</Text>
              </TouchableOpacity>
            )}
            {activeSchedule && canComplete ? (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="完成"
                disabled={isCompleting}
                style={styles.preventiveCareCompleteButton}
                onPress={() => setIsConfirmingComplete(true)}
              >
                <Text style={styles.preventiveCareCompleteButtonText}>完成</Text>
              </TouchableOpacity>
            ) : activeSchedule ? (
              <>
                <View accessibilityRole="text" accessibilityLabel="已完成" style={[styles.preventiveCareCompleteButton, styles.preventiveCareCompleteButtonDisabled]}>
                  <Text style={[styles.preventiveCareCompleteButtonText, styles.preventiveCareCompleteButtonTextDisabled]}>已完成</Text>
                </View>
                <Text style={styles.preventiveCareLockedHint}>距離下次提醒還有 {remainingDays} 天。</Text>
              </>
            ) : null}
            <TouchableOpacity style={styles.formCancelButton} onPress={onClose}>
              <Text style={styles.formCancelButtonText}>關閉</Text>
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
    <AppConfirmDialog
      visible={visible && isConfirmingComplete && activeSchedule !== undefined}
      icon={kind === 'vaccine' ? '💉' : '🪱'}
      title={`確認完成${kind === 'vaccine' ? '疫苗' : '驅蟲'}？`}
      message={activeSchedule
        ? `將新增「${activeSchedule.title}」健康紀錄，並從完成日重新計算下次提醒。`
        : ''}
      confirmLabel="確認完成"
      loadingLabel="完成中…"
      tone="warning"
      loading={isCompleting}
      testID="preventive-care-manager-confirm-dialog"
      onCancel={() => setIsConfirmingComplete(false)}
      onConfirm={() => void completeToday()}
    />
    </>
  );
}

function StoolRecordMethodModal({
  visible,
  petProfile,
  onClose,
  onCamera,
  onGallery,
  onManual,
}: {
  visible: boolean;
  petProfile: PetProfile;
  onClose: () => void;
  onCamera: () => void;
  onGallery: () => void;
  onManual: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.modalSheet, styles.stoolMethodSheet]}>
          <View style={styles.modalHandle} />
          <Text style={styles.modalTitle}>記錄便便</Text>
          <Text style={styles.modalSubtitle}>選擇這次要使用的記錄方式</Text>

          <View style={styles.stoolPetContext}>
            <View style={styles.stoolPetAvatar}><PetAvatarContent profile={petProfile} iconSize={24} /></View>
            <View style={styles.stoolPetCopy}>
              <Text style={styles.stoolPetLabel}>目前記錄的寵物</Text>
              <Text numberOfLines={2} style={styles.stoolPetName}>{petProfile.name}</Text>
            </View>
          </View>

          {featureFlags.stoolExperiment ? (
          <>
            <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`為${petProfile.name}開啟便便拍攝記錄`}
            accessibilityHint="照片會安全上傳，用於便便存在辨識並自動送交後端人工審核"
            style={styles.stoolMethodCard}
            onPress={onCamera}
          >
            <View style={[styles.stoolMethodIcon, styles.stoolMethodCameraIcon]}><Text style={styles.stoolMethodEmoji}>📷</Text></View>
            <View style={styles.stoolMethodCopy}>
              <Text style={styles.stoolMethodTitle}>1. 即時拍攝</Text>
              <Text style={styles.stoolMethodText}>模型實驗完成後，每張照片都自動送交後端人工審核</Text>
            </View>
            <Text style={styles.stoolMethodArrow}>›</Text>
          </TouchableOpacity>

          {featureFlags.stoolGalleryUpload ? (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`為${petProfile.name}從相簿選擇便便照片進行辨識`}
              accessibilityHint="照片會重新編碼後私密上傳，並明確標記為相簿來源"
              style={styles.stoolMethodCard}
              onPress={onGallery}
            >
              <View style={[styles.stoolMethodIcon, styles.stoolMethodGalleryIcon]}><Text style={styles.stoolMethodEmoji}>▧</Text></View>
              <View style={styles.stoolMethodCopy}>
                <Text style={styles.stoolMethodTitle}>2. 相簿辨識</Text>
                <Text style={styles.stoolMethodText}>選擇現有照片；會標記為相簿來源，不會冒充即時拍攝</Text>
              </View>
              <Text style={styles.stoolMethodArrow}>›</Text>
            </TouchableOpacity>
          ) : null}
          </>
          ) : null}

          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`為${petProfile.name}手動記錄便便`}
            style={styles.stoolMethodCard}
            onPress={onManual}
          >
            <View style={[styles.stoolMethodIcon, styles.stoolMethodManualIcon]}><Text style={styles.stoolMethodEmoji}>✎</Text></View>
            <View style={styles.stoolMethodCopy}>
              <Text style={styles.stoolMethodTitle}>{featureFlags.stoolExperiment ? '3. 手動記錄' : '手動記錄'}</Text>
              <Text style={styles.stoolMethodText}>填寫質地、顏色、排便狀態與備註並保存</Text>
            </View>
            <Text style={styles.stoolMethodArrow}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity accessibilityRole="button" style={styles.formCancelButton} onPress={onClose}>
            <Text style={styles.formCancelButtonText}>取消</Text>
          </TouchableOpacity>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function QuickAddModal({
  visible,
  initialAction,
  onClose,
  onSave,
  onRequestStoolMethod,
}: {
  visible: boolean;
  initialAction: QuickAction | null;
  onClose: () => void;
  onSave: (activity: ActivityInput) => void;
  onRequestStoolMethod: () => void;
}) {
  const [selectedAction, setSelectedAction] = useState<QuickAction | null>(initialAction);
  const [nameValue, setNameValue] = useState('');
  const [amountValue, setAmountValue] = useState('');
  const [lastAmountByKind, setLastAmountByKind] = useState({ meal: '120', water: '200' });
  const [noteValue, setNoteValue] = useState('');
  const [foodType, setFoodType] = useState('乾糧');
  const [stoolTexture, setStoolTexture] = useState('正常');
  const [stoolColor, setStoolColor] = useState('巧克力棕');
  const [stoolStatus, setStoolStatus] = useState('正常');
  const [urineColor, setUrineColor] = useState('未知');

  useEffect(() => {
    if (!visible) return;
    setSelectedAction(initialAction);
    setNameValue('');
    setAmountValue(initialAction?.kind === 'water' ? lastAmountByKind.water : initialAction?.kind === 'meal' ? lastAmountByKind.meal : '');
    setNoteValue('');
    setFoodType('乾糧');
    setStoolTexture('正常');
    setStoolColor('巧克力棕');
    setStoolStatus('正常');
    setUrineColor('未知');
  }, [initialAction, lastAmountByKind, visible]);

  const selectAction = (action: QuickAction) => {
    if (action.kind === 'stool') {
      onRequestStoolMethod();
      return;
    }
    setSelectedAction(action);
    setNameValue('');
    setAmountValue(action.kind === 'water' ? lastAmountByKind.water : action.kind === 'meal' ? lastAmountByKind.meal : '');
    setNoteValue('');
    setFoodType('乾糧');
    setStoolTexture('正常');
    setStoolColor('巧克力棕');
    setStoolStatus('正常');
    setUrineColor('未知');
  };

  const fieldConfig = selectedAction
    ? activityFieldConfig(selectedAction.kind)
    : { nameLabel: '', namePlaceholder: '', amountLabel: '', numeric: false };

  const saveActivity = () => {
    if (!selectedAction) return;
    if ((selectedAction.kind === 'meal' || selectedAction.kind === 'water') &&
        !isPositiveIntegerInput(amountValue)) {
      const fieldName = selectedAction.kind === 'meal' ? '飲食份量' : '飲水量';
      const example = selectedAction.kind === 'meal' ? '120' : '250';
      Alert.alert('輸入格式不正確', `${fieldName}請輸入大於 0 的正整數，例如 ${example}。`);
      return;
    }
    const numericAmount = Number(amountValue);
    if (fieldConfig.nameLabel && !nameValue.trim()) {
      Alert.alert('還差一個欄位', `請輸入${fieldConfig.nameLabel}。`);
      return;
    }
    if (selectedAction.kind === 'medication' && !amountValue.trim()) {
      Alert.alert('還差一個欄位', '請輸入藥物劑量，例如 5 mg 或半錠。');
      return;
    }

    const noteSuffix = noteValue.trim() ? `・${noteValue.trim()}` : '';
    let title = selectedAction.label;
    let detail = selectedAction.detail;
    let amount: number | undefined;

    switch (selectedAction.kind) {
      case 'meal':
        detail = `${foodType} ${numericAmount} g${noteSuffix}`;
        amount = numericAmount;
        break;
      case 'water':
        detail = `${numericAmount} ml${noteSuffix}`;
        amount = numericAmount;
        break;
      case 'medication':
        title = nameValue.trim();
        detail = `劑量 ${amountValue.trim()}${noteSuffix}`;
        break;
      case 'stool':
        title = '便便';
        detail = `質地：${stoolTexture}・顏色：${stoolColor}・排便狀態：${stoolStatus}${noteSuffix}`;
        break;
      case 'urine':
        title = '尿尿';
        detail = `尿液顏色：${urineColor}${noteSuffix}`;
        break;
      case 'vaccine':
        title = nameValue.trim();
        detail = `疫苗接種${noteSuffix}`;
        break;
      case 'medical':
        detail = `${nameValue.trim()}${noteSuffix}`;
        break;
    }

    if (selectedAction.kind === 'meal' || selectedAction.kind === 'water') {
      setLastAmountByKind((current) => ({ ...current, [selectedAction.kind]: amountValue.trim() }));
    }

    onSave({
      kind: selectedAction.kind,
      icon: selectedAction.icon,
      title,
      detail,
      tone: selectedAction.tone,
      amount,
      unit: selectedAction.kind === 'water' ? 'ml' : selectedAction.kind === 'meal' ? 'g' : undefined,
      note: noteValue.trim() || undefined,
      foodType: selectedAction.kind === 'meal' ? foodTypeToDatabase[foodType as keyof typeof foodTypeToDatabase] : undefined,
      medicationName: selectedAction.kind === 'medication' ? nameValue.trim() : undefined,
      medicationDose: selectedAction.kind === 'medication' ? amountValue.trim() : undefined,
      stoolTexture: selectedAction.kind === 'stool' ? stoolTextureToDatabase[stoolTexture as keyof typeof stoolTextureToDatabase] : undefined,
      stoolColor: selectedAction.kind === 'stool' ? stoolColorToDatabase[stoolColor as keyof typeof stoolColorToDatabase] : undefined,
      stoolStatus: selectedAction.kind === 'stool' ? stoolStatusToDatabase[stoolStatus as keyof typeof stoolStatusToDatabase] : undefined,
      urineColor: selectedAction.kind === 'urine' ? urineColorToDatabase[urineColor as keyof typeof urineColorToDatabase] : undefined,
    });
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.modalBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <SafeAreaView edges={['bottom', 'left', 'right']} style={styles.modalSheet}>
          <View style={styles.modalHandle} />
          {!selectedAction ? (
            <>
              <Text style={styles.modalTitle}>新增生活紀錄</Text>
              <Text style={styles.modalSubtitle}>選擇這次要紀錄的項目</Text>
              <View style={styles.modalGrid}>
                {quickActions.map((action) => (
                  <TouchableOpacity key={action.kind} style={styles.modalAction} onPress={() => selectAction(action)}>
                    <View style={[styles.modalActionIcon, { backgroundColor: `${action.tone}1F` }]}>
                      {action.kind === 'urine' ? <UrinePuddleIcon size={23} /> : <Text style={styles.modalActionEmoji}>{action.icon}</Text>}
                    </View>
                    <View>
                      <Text style={styles.modalActionLabel}>{action.label}</Text>
                      <Text style={styles.modalActionDetail}>{action.detail}</Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <View style={styles.entryHeader}>
                <TouchableOpacity style={styles.backButton} onPress={() => setSelectedAction(null)}>
                  <Text style={styles.backButtonText}>‹</Text>
                </TouchableOpacity>
                <View style={[styles.entryIcon, { backgroundColor: `${selectedAction.tone}1F` }]}>
                  {selectedAction.kind === 'urine' ? <UrinePuddleIcon size={25} /> : <Text style={styles.entryIconText}>{selectedAction.icon}</Text>}
                </View>
                <View style={styles.entryHeadingText}>
                  <Text style={styles.modalTitle}>記錄{selectedAction.label}</Text>
                  <Text style={styles.modalSubtitle}>資料會立即更新到今天的照護進度</Text>
                </View>
              </View>

              <ActivityStructuredFields
                kind={selectedAction.kind}
                values={{ nameValue, amountValue, noteValue, foodType, stoolTexture, stoolColor, stoolStatus, urineColor }}
                setters={{ setNameValue, setAmountValue, setNoteValue, setFoodType, setStoolTexture, setStoolColor, setStoolStatus, setUrineColor }}
              />
              <TouchableOpacity style={styles.formSaveButton} onPress={saveActivity}>
                <Text style={styles.formSaveButtonText}>儲存紀錄</Text>
              </TouchableOpacity>
            </ScrollView>
          )}
          <Text style={styles.prototypeNote}>登入後，新增與修改會同步儲存到雲端資料庫。</Text>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function MedicationTimeField({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  return (
    <View style={styles.medicationTimeField}>
      <Text style={styles.formLabel}>{label}</Text>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`${label}：${value}`}
        style={styles.medicationTimeButton}
        onPress={onPress}
      >
        <Text style={styles.medicationTimeValue}>{value}</Text>
        <Text style={styles.medicationTimeChevron}>⌄</Text>
      </TouchableOpacity>
    </View>
  );
}

const timeWheelRowHeight = 52;

function TimeWheel({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));

  useEffect(() => {
    const timer = setTimeout(() => {
      scrollRef.current?.scrollTo({ y: selectedIndex * timeWheelRowHeight, animated: false });
    }, 0);
    return () => clearTimeout(timer);
  }, [selectedIndex]);

  const selectIndex = (nextIndex: number) => {
    const safeIndex = Math.max(0, Math.min(options.length - 1, nextIndex));
    onChange(options[safeIndex].value);
    scrollRef.current?.scrollTo({ y: safeIndex * timeWheelRowHeight, animated: true });
  };

  return (
    <View style={styles.timeWheelColumn}>
      <Text style={styles.timeWheelLabel}>{label}</Text>
      <View style={styles.timeWheelViewport}>
        <View pointerEvents="none" style={styles.timeWheelFocus} />
        <ScrollView
          ref={scrollRef}
          accessibilityRole="adjustable"
          accessibilityLabel={label}
          accessibilityValue={{ text: options[selectedIndex]?.label }}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === 'increment') selectIndex(selectedIndex + 1);
            if (event.nativeEvent.actionName === 'decrement') selectIndex(selectedIndex - 1);
          }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          showsVerticalScrollIndicator={false}
          snapToInterval={timeWheelRowHeight}
          decelerationRate="fast"
          nestedScrollEnabled
          contentContainerStyle={styles.timeWheelContent}
          onMomentumScrollEnd={(event) => {
            selectIndex(Math.round(event.nativeEvent.contentOffset.y / timeWheelRowHeight));
          }}
          onScrollEndDrag={(event) => {
            const nextIndex = Math.round(event.nativeEvent.contentOffset.y / timeWheelRowHeight);
            if (Math.abs(event.nativeEvent.velocity?.y ?? 0) < 0.05) selectIndex(nextIndex);
          }}
        >
          {options.map((option, index) => {
            const isSelected = index === selectedIndex;
            return (
              <TouchableOpacity
                key={option.value}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
                style={styles.timeWheelRow}
                onPress={() => selectIndex(index)}
              >
                <Text style={[styles.timeWheelText, isSelected && styles.timeWheelTextSelected]}>{option.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    </View>
  );
}

function TimeWheelPicker({
  visible,
  title,
  value,
  onCancel,
  onConfirm,
  minMinutes = 0,
  maxMinutes = 23 * 60 + 55,
}: {
  visible: boolean;
  title: string;
  value: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
  minMinutes?: number;
  maxMinutes?: number;
}) {
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    if (visible) {
      const clampedMinutes = Math.max(minMinutes, Math.min(maxMinutes, timeToMinutes(value)));
      setDraftValue(minutesToTime(clampedMinutes));
    }
  }, [maxMinutes, minMinutes, value, visible]);

  const [hour = '08', minute = '00'] = draftValue.split(':');
  const allowedHourOptions = medicationHourOptions.filter((option) => {
    const hourValue = Number(option.value);
    return hourValue * 60 + 55 >= minMinutes && hourValue * 60 <= maxMinutes;
  });
  const allowedMinuteOptions = medicationMinuteOptions.filter((option) => {
    const total = Number(hour) * 60 + Number(option.value);
    return total >= minMinutes && total <= maxMinutes;
  });

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalBackdrop}>
        <Pressable accessibilityRole="button" accessibilityLabel="取消時間選擇" style={StyleSheet.absoluteFill} onPress={onCancel} />
        <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.modalSheet, styles.medicationTimePickerSheet]}>
          <View style={styles.modalHandle} />
          <Text style={styles.modalTitle}>{title}</Text>
          <Text style={styles.modalSubtitle}>可選 {minutesToTime(minMinutes)}–{minutesToTime(maxMinutes)}，滑動後會停在最接近的時間</Text>
          <View style={styles.timeWheelRowWrap}>
            <TimeWheel
              label="小時"
              options={allowedHourOptions}
              value={hour}
              onChange={(nextHour) => {
                const validMinutes = medicationMinuteOptions.filter((option) => {
                  const total = Number(nextHour) * 60 + Number(option.value);
                  return total >= minMinutes && total <= maxMinutes;
                });
                const nextMinute = validMinutes.some((option) => option.value === minute)
                  ? minute
                  : validMinutes[0].value;
                setDraftValue(`${nextHour}:${nextMinute}`);
              }}
            />
            <Text accessibilityElementsHidden style={styles.timeWheelColon}>:</Text>
            <TimeWheel label="分鐘" options={allowedMinuteOptions} value={minute} onChange={(nextMinute) => setDraftValue(`${hour}:${nextMinute}`)} />
          </View>
          <TouchableOpacity style={styles.formSaveButton} onPress={() => onConfirm(draftValue)}>
            <Text style={styles.formSaveButtonText}>完成</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.formCancelButton} onPress={onCancel}>
            <Text style={styles.formCancelButtonText}>取消</Text>
          </TouchableOpacity>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function MedicationManagementModal({
  visible,
  plans,
  onClose,
  onAddPlan,
  onTogglePlan,
}: {
  visible: boolean;
  plans: MedicationPlan[];
  onClose: () => void;
  onAddPlan: (plan: MedicationPlan) => Promise<void>;
  onTogglePlan: (planId: string) => Promise<void>;
}) {
  const [view, setView] = useState<'list' | 'add'>('list');
  const [title, setTitle] = useState('');
  const [dose, setDose] = useState('');
  const [doseUnit, setDoseUnit] = useState<MedicationDoseUnit>('mg');
  const [frequency, setFrequency] = useState(1);
  const [times, setTimes] = useState(['08:00', '13:00', '20:00']);
  const [startDate, setStartDate] = useState(dateValueWithOffset(0));
  const [endDate, setEndDate] = useState(dateValueWithOffset(6));
  const [instruction, setInstruction] = useState('依獸醫或藥袋指示');
  const [note, setNote] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [editingTimeIndex, setEditingTimeIndex] = useState<number | null>(null);
  const [medicationSubmitError, setMedicationSubmitError] = useState('');

  const resetForm = () => {
    setTitle('');
    setDose('');
    setDoseUnit('mg');
    setFrequency(1);
    setTimes(['08:00', '13:00', '20:00']);
    setStartDate(dateValueWithOffset(0));
    setEndDate(dateValueWithOffset(6));
    setInstruction('依獸醫或藥袋指示');
    setNote('');
    setEditingTimeIndex(null);
    setMedicationSubmitError('');
  };

  useEffect(() => {
    if (visible) setView('list');
  }, [visible]);

  const updateTime = (index: number, value: string) => {
    setTimes((current) => current.map((time, timeIndex) => timeIndex === index ? value : time));
  };

  const hasUnsavedMedicationChanges = Boolean(
    title.trim()
    || dose.trim()
    || doseUnit !== 'mg'
    || frequency !== 1
    || times.some((time, index) => time !== ['08:00', '13:00', '20:00'][index])
    || startDate !== dateValueWithOffset(0)
    || endDate !== dateValueWithOffset(6)
    || instruction !== '依獸醫或藥袋指示'
    || note.trim(),
  );

  const requestLeaveMedicationAdd = () => {
    if (isSaving) return;
    if (!hasUnsavedMedicationChanges) {
      setView('list');
      return;
    }
    Alert.alert('放棄尚未儲存的內容？', '返回後，本次輸入的用藥資料將不會保留。', [
      { text: '繼續填寫', style: 'cancel' },
      { text: '放棄', style: 'destructive', onPress: () => { resetForm(); setView('list'); } },
    ]);
  };

  const savePlan = async () => {
    const activeTimes = times.slice(0, frequency);
    const start = parseDateValue(startDate);
    const end = parseDateValue(endDate);
    const validTimes = activeTimes.every((time) => {
      const match = /^(\d{2}):(\d{2})$/.exec(time);
      return Boolean(match && Number(match[1]) <= 23 && Number(match[2]) <= 59);
    });
    const timesAreIncreasing = activeTimes.every((time, index) => (
      index === 0 || timeToMinutes(time) >= timeToMinutes(activeTimes[index - 1]) + 5
    ));
    setMedicationSubmitError('');

    if (!title.trim() || !dose.trim()) {
      Alert.alert('資料不完整', '請填寫藥物名稱與每次劑量。');
      return;
    }
    if (!isPositiveDoseInput(dose)) {
      Alert.alert('劑量格式不正確', '每次劑量請輸入大於 0 的數字，最多三位小數，例如 5 或 0.5。');
      return;
    }
    if (!validTimes) {
      Alert.alert('提醒時間不正確', '請使用 24 小時格式，例如 08:30 或 20:30。');
      return;
    }
    if (new Set(activeTimes).size !== activeTimes.length) {
      setMedicationSubmitError('每次服藥時間必須不同，請重新選擇。');
      return;
    }
    if (!timesAreIncreasing) {
      setMedicationSubmitError('後一次服藥時間必須至少比前一次晚 5 分鐘。');
      return;
    }
    if (!start || !end || end < start) {
      Alert.alert('日期範圍不正確', '結束日期不能早於開始日期。');
      return;
    }
    if ((end.getTime() - start.getTime()) / 86_400_000 > 365) {
      Alert.alert('期間過長', '單次用藥計畫最多設定一年，之後可再建立新的計畫。');
      return;
    }

    const doseAmount = Number(dose);
    const unitLabel = medicationDoseUnitOptions.find((item) => item.value === doseUnit)?.label ?? doseUnit;
    setIsSaving(true);
    try {
      await onAddPlan({
      id: `medication-plan-${Date.now()}`,
      title: title.trim(),
      dose: `${doseAmount} ${unitLabel}`,
      doseAmount,
      doseUnit,
      times: activeTimes,
      startDate,
      endDate,
      instruction,
      note: note.trim(),
      active: true,
      });
      resetForm();
      setView('list');
    } catch (error) {
      setMedicationSubmitError(errorMessage(error, '無法建立用藥提醒，請稍後再試。'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
    <Modal visible={visible} transparent animationType="slide" onRequestClose={view === 'add' ? requestLeaveMedicationAdd : onClose}>
      <KeyboardAvoidingView style={styles.modalBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={StyleSheet.absoluteFill} onPress={view === 'list' ? onClose : undefined} />
        <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.modalSheet, styles.medicationManagerSheet]}>
          <View style={styles.modalHandle} />
          {view === 'list' ? (
            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={styles.medicationManagerHeader}>
                <View style={styles.medicationManagerHeading}>
                  <Text style={styles.modalTitle}>用藥與提醒</Text>
                  <Text style={styles.modalSubtitle}>管理療程與提醒時間，完成後會自動建立用藥紀錄</Text>
                </View>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="新增用藥提醒"
                  style={styles.medicationAddButton}
                  onPress={() => setView('add')}
                >
                  <Text style={styles.medicationAddButtonText}>＋ 新增</Text>
                </TouchableOpacity>
              </View>

              {plans.length ? plans.map((plan) => (
                <View key={plan.id} style={styles.medicationPlanCard}>
                  <View style={styles.medicationPlanHeader}>
                    <View style={styles.medicationPlanIcon}><Text style={styles.medicationPlanEmoji}>💊</Text></View>
                    <View style={styles.medicationPlanTitleWrap}>
                      <Text style={styles.medicationPlanTitle}>{plan.title}</Text>
                      <Text style={styles.medicationPlanDose}>{plan.dose}・{plan.instruction}</Text>
                    </View>
                    <View style={[styles.medicationPlanStatus, !plan.active && styles.medicationPlanStatusPaused]}>
                      <Text style={[styles.medicationPlanStatusText, !plan.active && styles.medicationPlanStatusTextPaused]}>
                        {plan.active ? '提醒中' : '已暫停'}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.medicationPlanSchedule}>
                    <Text style={styles.medicationPlanScheduleLabel}>每天 {plan.times.length} 次</Text>
                    <Text style={styles.medicationPlanScheduleValue}>{plan.times.join('、')}</Text>
                  </View>
                  <Text style={styles.medicationPlanDates}>{plan.startDate} 至 {plan.endDate}</Text>
                  {plan.note ? <Text style={styles.medicationPlanNote}>{plan.note}</Text> : null}
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`${plan.active ? '暫停' : '啟用'}${plan.title}提醒`}
                    style={[styles.medicationPlanToggle, !plan.active && styles.medicationPlanToggleResume]}
                    onPress={() => void onTogglePlan(plan.id).catch((error) => Alert.alert('更新失敗', error instanceof Error ? error.message : '無法更新提醒狀態。'))}
                  >
                    <Text style={[styles.medicationPlanToggleText, !plan.active && styles.medicationPlanToggleTextResume]}>
                      {plan.active ? '暫停未來提醒' : '重新啟用提醒'}
                    </Text>
                  </TouchableOpacity>
                </View>
              )) : (
                <View style={styles.medicationEmptyCard}>
                  <Text style={styles.medicationEmptyIcon}>💊</Text>
                  <Text style={styles.medicationEmptyTitle}>尚未建立用藥提醒</Text>
                  <Text style={styles.medicationEmptyText}>新增療程後，首頁會顯示下一個提醒。</Text>
                </View>
              )}

              <Text style={styles.prototypeNote}>用藥計畫與提醒會同步到雲端，並依目前寵物與共同照護權限顯示。</Text>
              <TouchableOpacity style={styles.formCancelButton} onPress={onClose}>
                <Text style={styles.formCancelButtonText}>關閉</Text>
              </TouchableOpacity>
            </ScrollView>
          ) : (
            <View style={styles.medicationAddView}>
              <View style={[styles.entryHeader, styles.medicationAddStickyHeader]}>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel="返回用藥管理" style={styles.backButton} onPress={requestLeaveMedicationAdd}>
                  <Text style={styles.backButtonText}>‹</Text>
                </TouchableOpacity>
                <View style={styles.entryHeadingText}>
                  <Text style={styles.modalTitle}>新增用藥提醒</Text>
                  <Text style={styles.modalSubtitle}>請依獸醫或藥袋指示填寫，不提供醫療劑量建議</Text>
                </View>
              </View>

            <ScrollView
              style={styles.medicationAddScroll}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.medicationAddScrollContent}
            >
              <FormField label="藥物名稱" placeholder="例如：過敏藥" value={title} onChangeText={setTitle} />
              <View style={styles.medicationDoseRow}>
                <View style={styles.medicationDoseAmount}>
                  <FormField label="每次劑量" placeholder="例如：5 或 0.5" value={dose} onChangeText={setDose} keyboardType="decimal-pad" />
                </View>
                <View style={styles.medicationDoseUnit}>
                  <SelectField label="單位" value={doseUnit} options={medicationDoseUnitOptions} onChange={(value) => setDoseUnit(value as MedicationDoseUnit)} />
                </View>
              </View>

              <Text style={styles.formLabel}>每天次數</Text>
              <View style={styles.segmentRow}>
                {[1, 2, 3].map((count) => (
                  <TouchableOpacity
                    key={count}
                    style={[styles.segmentButton, frequency === count && styles.segmentButtonActive]}
                    onPress={() => {
                      if (count > frequency) {
                        const lastActiveMinutes = timeToMinutes(times[frequency - 1]);
                        if (lastActiveMinutes + (count - frequency) * 5 > 23 * 60 + 55) {
                          setMedicationSubmitError('目前最後一次時間太晚，無法再新增服藥次數。請先調整前一次時間。');
                          return;
                        }
                        setTimes((current) => {
                          const next = [...current];
                          for (let index = frequency; index < count; index += 1) {
                            const minimum = timeToMinutes(next[index - 1]) + 5;
                            const maximum = 23 * 60 + 55 - (count - 1 - index) * 5;
                            next[index] = minutesToTime(Math.min(Math.max(timeToMinutes(next[index]), minimum), maximum));
                          }
                          return next;
                        });
                      }
                      setMedicationSubmitError('');
                      setFrequency(count);
                      if (editingTimeIndex != null && editingTimeIndex >= count) setEditingTimeIndex(null);
                    }}
                  >
                    <Text style={[styles.segmentText, frequency === count && styles.segmentTextActive]}>{count} 次</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View style={styles.medicationTimesRow}>
                {times.slice(0, frequency).map((time, index) => (
                  <MedicationTimeField
                    key={index}
                    label={`第 ${index + 1} 次時間`}
                    value={time}
                    onPress={() => setEditingTimeIndex(index)}
                  />
                ))}
              </View>

              <SelectField
                label="服用時機"
                value={instruction}
                options={medicationInstructionOptions}
                onChange={setInstruction}
              />
              <CalendarDateField
                label="開始日期"
                value={startDate}
                onChange={(value) => {
                  setStartDate(value);
                  if (endDate < value) setEndDate(value);
                }}
                minDate={dateValueWithOffset(0)}
                maxDate={dateValueWithOffset(730)}
                hint="可設定今天起兩年內的日期"
              />
              <CalendarDateField
                label="結束日期"
                value={endDate}
                onChange={setEndDate}
                minDate={startDate}
                maxDate={dateValueWithOffset(730)}
                hint="單次用藥計畫最長一年"
              />
              <FormField label="備註（選填）" placeholder="例如：依獸醫指示，若嘔吐請聯絡醫院" value={note} onChangeText={setNote} multiline />

            </ScrollView>

            <View style={styles.medicationAddFooter}>
              <View style={[styles.goalHintCard, styles.medicationAddFooterHint]}>
                <Text style={styles.goalHintIcon}>ⓘ</Text>
                <Text style={styles.goalHintText}>提醒只協助記錄時間與完成狀態；藥名、劑量與療程仍應以獸醫或藥袋指示為準。</Text>
              </View>
              {medicationSubmitError ? (
                <View accessibilityRole="alert" style={styles.medicationSubmitErrorCard}>
                  <Text style={styles.medicationSubmitErrorText}>{medicationSubmitError}</Text>
                </View>
              ) : null}
              <TouchableOpacity disabled={isSaving} style={[styles.formSaveButton, isSaving && styles.formSaveButtonDisabled]} onPress={() => void savePlan()}>
                <Text style={styles.formSaveButtonText}>{isSaving ? '建立中…' : '建立用藥提醒'}</Text>
              </TouchableOpacity>
              <TouchableOpacity disabled={isSaving} style={styles.formCancelButton} onPress={requestLeaveMedicationAdd}>
                <Text style={styles.formCancelButtonText}>取消</Text>
              </TouchableOpacity>
            </View>
            </View>
          )}
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
    <TimeWheelPicker
      visible={editingTimeIndex != null}
      title={`選擇第 ${(editingTimeIndex ?? 0) + 1} 次服藥時間`}
      value={editingTimeIndex == null ? '08:00' : times[editingTimeIndex]}
      minMinutes={editingTimeIndex == null || editingTimeIndex === 0 ? 0 : timeToMinutes(times[editingTimeIndex - 1]) + 5}
      maxMinutes={editingTimeIndex == null || editingTimeIndex >= frequency - 1 ? 23 * 60 + 55 : timeToMinutes(times[editingTimeIndex + 1]) - 5}
      onCancel={() => setEditingTimeIndex(null)}
      onConfirm={(nextTime) => {
        if (editingTimeIndex != null) updateTime(editingTimeIndex, nextTime);
        setEditingTimeIndex(null);
      }}
    />
    </>
  );
}

function PetSettingsModal({
  visible,
  profile,
  onClose,
  onSave,
}: {
  visible: boolean;
  profile: PetProfile;
  onClose: () => void;
  onSave: (profile: PetProfile) => void;
}) {
  const [draft, setDraft] = useState(profile);

  useEffect(() => {
    if (visible) setDraft(profile);
  }, [profile, visible]);

  const updateDraft = <K extends keyof PetProfile>(key: K, value: PetProfile[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const chooseAvatarPhoto = async (source: 'camera' | 'library') => {
    try {
      if (source === 'camera') {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          Alert.alert('需要相機權限', '請允許使用相機，才能直接拍攝寵物頭像。');
          return;
        }
      } else if (Platform.OS !== 'web') {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
          Alert.alert('需要照片權限', '請允許讀取照片，才能選擇寵物頭像。');
          return;
        }
      }

      const result = source === 'camera'
        ? await ImagePicker.launchCameraAsync({
            mediaTypes: ['images'],
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.78,
          })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.78,
          });

      if (!result.canceled && result.assets[0]?.uri) {
        setDraft((current) => ({ ...current, avatarUri: result.assets[0].uri, avatarPath: '' }));
      }
    } catch {
      Alert.alert('無法取得照片', '請稍後再試，或先使用犬種圖示。');
    }
  };

  const saveProfile = () => {
    const meals = Number(draft.mealsPerDay);
    const water = Number(draft.waterGoalMl);
    const weight = Number(draft.weightKg);

    if (!draft.name.trim() || !draft.breed.trim()) {
      Alert.alert('資料不完整', '請填寫寵物名字與品種。');
      return;
    }
    if (!Number.isInteger(meals) || meals < 1 || meals > 10) {
      Alert.alert('餐數不正確', '每日餐數請輸入 1 到 10 的整數。');
      return;
    }
    if (!Number.isFinite(water) || water < 50 || water > 10000) {
      Alert.alert('飲水目標不正確', '每日飲水目標請輸入 50 到 10000 ml。');
      return;
    }
    if (draft.weightKg.trim() && (!Number.isFinite(weight) || weight <= 0 || weight > 200)) {
      Alert.alert('體重不正確', '請輸入有效的公斤數。');
      return;
    }

    onSave({
      ...draft,
      name: draft.name.trim(),
      breed: draft.breed.trim(),
      weightKg: draft.weightKg.trim(),
      mealsPerDay: meals,
      waterGoalMl: water,
    });
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.modalBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.modalSheet, styles.petSettingsSheet]}>
          <View style={styles.modalHandle} />
          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <Text style={styles.modalTitle}>寵物資料與每日目標</Text>
            <Text style={styles.modalSubtitle}>首頁的餐數、飲水量和完成度會依這裡的設定更新</Text>

            <View style={styles.formSectionTitleRow}>
              <Text style={styles.formSectionTitle}>基本資料</Text>
              <View style={styles.localPill}><Text style={styles.localPillText}>等待雲端</Text></View>
            </View>
            <View style={styles.avatarEditorCard}>
              <View
                style={[
                  styles.avatarEditorPreview,
                  !draft.avatarUri && {
                    backgroundColor: dogAvatarOptions.find((option) => option.icon === draft.avatarIcon)?.background ?? '#FFF0D9',
                  },
                ]}
              >
                <PetAvatarContent profile={draft} iconSize={38} />
              </View>
              <View style={styles.avatarEditorContent}>
                <Text style={styles.avatarEditorTitle}>寵物頭像</Text>
                <Text style={styles.avatarEditorHint}>選擇犬種圖示，或使用寵物的正面照片</Text>
                <View style={styles.avatarPhotoActions}>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="拍攝寵物頭像"
                    style={styles.avatarPhotoButton}
                    onPress={() => chooseAvatarPhoto('camera')}
                  >
                    <Text style={styles.avatarPhotoButtonIcon}>📷</Text>
                    <Text style={styles.avatarPhotoButtonText}>拍照</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="從相簿選擇寵物頭像"
                    style={styles.avatarPhotoButton}
                    onPress={() => chooseAvatarPhoto('library')}
                  >
                    <Text style={styles.avatarPhotoButtonIcon}>▧</Text>
                    <Text style={styles.avatarPhotoButtonText}>相簿</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
            <Text style={styles.avatarChoiceLabel}>犬種圖示</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.avatarChoices}
              style={styles.avatarChoicesScroll}
            >
              {dogAvatarOptions.map((option) => {
                const isSelected = !draft.avatarUri && draft.avatarIcon === option.icon;
                return (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`${option.label}頭像`}
                    accessibilityState={{ selected: isSelected }}
                    key={option.label}
                    style={[styles.avatarChoice, isSelected && styles.avatarChoiceSelected]}
                    onPress={() => setDraft((current) => ({ ...current, avatarIcon: option.icon, avatarUri: '', avatarPath: '' }))}
                  >
                    <View style={[styles.avatarChoiceIcon, { backgroundColor: option.background }]}>
                      <Text style={styles.avatarChoiceEmoji}>{option.icon}</Text>
                    </View>
                    <Text style={[styles.avatarChoiceText, isSelected && styles.avatarChoiceTextSelected]}>{option.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <FormField label="寵物名字" placeholder="例如：麻糬" value={draft.name} onChangeText={(value) => updateDraft('name', value)} />
            <SelectField
              label="品種"
              value={draft.breed}
              options={dogBreedOptions}
              onChange={(value) => updateDraft('breed', value)}
              helperText="目前使用受控的台灣常見犬種示範名單，不開放任意輸入；正式上線前需依使用地區法規由後台更新。"
            />
            <Text style={styles.formLabel}>性別</Text>
            <View style={styles.segmentRow}>
              {['公', '母', '未知'].map((sex) => (
                <TouchableOpacity
                  key={sex}
                  style={[styles.segmentButton, draft.sex === sex && styles.segmentButtonActive]}
                  onPress={() => updateDraft('sex', sex)}
                >
                  <Text style={[styles.segmentText, draft.sex === sex && styles.segmentTextActive]}>{sex}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <SelectField
              label="絕育狀態"
              value={draft.sterilizationStatus}
              options={sterilizationOptions}
              onChange={(value) => updateDraft('sterilizationStatus', value)}
            />
            <View style={styles.lockedTimeCard}>
              <View>
                <Text style={styles.lockedTimeLabel}>生日</Text>
                <Text style={styles.lockedTimeValue}>{draft.birthday || '未設定'}</Text>
              </View>
              <View style={styles.lockedTimePill}><Text style={styles.lockedTimePillText}>🔒 建立後不可修改</Text></View>
            </View>
            <FormField
              label="體重（kg）"
              placeholder="例如：10.8"
              value={draft.weightKg}
              onChangeText={(value) => updateDraft('weightKg', value)}
              keyboardType="decimal-pad"
            />

            <Text style={[styles.formSectionTitle, styles.goalSectionTitle]}>每日照護目標</Text>
            <View style={styles.goalInputsRow}>
              <View style={styles.goalInputCell}>
                <FormField
                  label="每天幾餐"
                  placeholder="2"
                  value={String(draft.mealsPerDay)}
                  onChangeText={(value) => updateDraft('mealsPerDay', Number(value.replace(/[^0-9]/g, '')) || 0)}
                  keyboardType="number-pad"
                />
              </View>
              <View style={styles.goalInputCell}>
                <FormField
                  label="每日飲水（ml）"
                  placeholder="650"
                  value={String(draft.waterGoalMl)}
                  onChangeText={(value) => updateDraft('waterGoalMl', Number(value.replace(/[^0-9]/g, '')) || 0)}
                  keyboardType="number-pad"
                />
              </View>
            </View>
            <View style={styles.goalHintCard}>
              <Text style={styles.goalHintIcon}>ⓘ</Text>
              <Text style={styles.goalHintText}>飲水目標應依體重、飲食、活動量與獸醫建議調整；App 不會自行提供醫療劑量。</Text>
            </View>
            <TouchableOpacity style={styles.formSaveButton} onPress={saveProfile}>
              <Text style={styles.formSaveButtonText}>儲存寵物資料</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.formCancelButton} onPress={onClose}>
              <Text style={styles.formCancelButtonText}>取消</Text>
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
  helperText,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  helperText?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 12, width: 240, maxHeight: 220 });
  const anchorRef = useRef<View>(null);
  const selectedOption = options.find((option) => option.value === value);

  const closeMenu = () => setExpanded(false);
  const openMenu = () => {
    Keyboard.dismiss();
    const window = Dimensions.get('window');
    const fallbackWidth = Math.min(320, window.width - 24);
    setMenuPosition({
      top: Math.max(12, (window.height - 220) / 2),
      left: Math.max(12, (window.width - fallbackWidth) / 2),
      width: fallbackWidth,
      maxHeight: 220,
    });
    setExpanded(true);
    requestAnimationFrame(() => {
      anchorRef.current?.measureInWindow((x, y, width, height) => {
        const measuredWindow = Dimensions.get('window');
        const horizontalMargin = 12;
        const gap = 6;
        const estimatedHeight = Math.min(options.length * 44 + 2, 220);
        const availableBelow = measuredWindow.height - (y + height) - horizontalMargin;
        const availableAbove = y - horizontalMargin;
        const placeBelow = availableBelow >= Math.min(estimatedHeight, 132) || availableBelow >= availableAbove;
        const maxHeight = Math.max(88, Math.min(estimatedHeight, placeBelow ? availableBelow - gap : availableAbove - gap));
        const top = placeBelow
          ? y + height + gap
          : Math.max(horizontalMargin, y - maxHeight - gap);
        const safeWidth = Math.min(width, measuredWindow.width - horizontalMargin * 2);
        const left = Math.max(horizontalMargin, Math.min(x, measuredWindow.width - safeWidth - horizontalMargin));
        setMenuPosition({ top, left, width: safeWidth, maxHeight });
      });
    });
  };

  useEffect(() => {
    const subscription = Dimensions.addEventListener('change', () => {
      if (expanded) openMenu();
    });
    return () => subscription.remove();
  }, [expanded, options.length]);

  return (
    <View style={styles.formField}>
      <Text style={styles.formLabel}>{label}</Text>
      <View ref={anchorRef} collapsable={false}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`${label}：${selectedOption?.label ?? value}`}
          accessibilityHint="點兩下開啟選項"
          accessibilityState={{ expanded }}
          style={[styles.selectButton, expanded && styles.selectButtonExpanded]}
          onPress={expanded ? closeMenu : openMenu}
        >
          <View style={styles.selectValueRow}>
            {selectedOption?.color ? <View style={[styles.colorSwatch, { backgroundColor: selectedOption.color }]} /> : null}
            <Text style={styles.selectValue}>{selectedOption?.label ?? value}</Text>
          </View>
          <Text style={styles.selectChevron}>{expanded ? '⌃' : '⌄'}</Text>
        </TouchableOpacity>
      </View>
      {helperText ? <Text style={styles.selectHelper}>{helperText}</Text> : null}
      <Modal visible={expanded} transparent animationType="fade" onRequestClose={closeMenu}>
        <View style={StyleSheet.absoluteFill}>
          <Pressable accessibilityRole="button" accessibilityLabel={`取消${label}選擇`} style={[StyleSheet.absoluteFill, styles.selectOverlayBackdrop]} onPress={closeMenu} />
          <View
            accessibilityViewIsModal
            style={[styles.selectMenu, {
              top: menuPosition.top,
              left: menuPosition.left,
              width: menuPosition.width,
              maxHeight: menuPosition.maxHeight,
            }]}
          >
            <ScrollView style={{ maxHeight: menuPosition.maxHeight }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
              {options.map((option, index) => {
                const isSelected = option.value === value;
                return (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={option.label}
                    accessibilityState={{ selected: isSelected }}
                    key={option.value}
                    style={[
                      styles.selectOption,
                      index !== options.length - 1 && styles.selectOptionBorder,
                      isSelected && styles.selectOptionSelected,
                    ]}
                    onPress={() => {
                      onChange(option.value);
                      closeMenu();
                    }}
                  >
                    <View style={styles.selectValueRow}>
                      {option.color ? <View style={[styles.colorSwatch, { backgroundColor: option.color }]} /> : null}
                      <Text style={[styles.selectOptionText, isSelected && styles.selectOptionTextSelected]}>{option.label}</Text>
                    </View>
                    {isSelected ? <Text style={styles.selectCheck}>✓</Text> : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const calendarWeekdays = ['日', '一', '二', '三', '四', '五', '六'];

function parseDateValue(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return date;
}

function formatPetAge(birthdayValue: string, today = new Date()) {
  const birthday = parseDateValue(birthdayValue);
  if (!birthday || birthday.getTime() > today.getTime()) return '年齡未知';

  let completedMonths = (today.getFullYear() - birthday.getFullYear()) * 12
    + today.getMonth()
    - birthday.getMonth();
  const lastDayOfCurrentMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const currentMonthAnniversary = new Date(
    today.getFullYear(),
    today.getMonth(),
    Math.min(birthday.getDate(), lastDayOfCurrentMonth),
  );
  if (today.getTime() < currentMonthAnniversary.getTime()) completedMonths -= 1;
  if (completedMonths < 1) return '未滿 1 個月';

  const years = Math.floor(completedMonths / 12);
  const months = completedMonths % 12;
  if (years === 0) return `${months} 個月`;
  return months === 0 ? `${years} 歲` : `${years} 歲 ${months} 個月`;
}

function formatDateValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addMonthsToDateValue(value: string, months: number) {
  const date = parseDateValue(value);
  if (!date) return '';
  const targetMonthStart = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const targetMonthLastDay = new Date(
    targetMonthStart.getFullYear(),
    targetMonthStart.getMonth() + 1,
    0,
  ).getDate();
  targetMonthStart.setDate(Math.min(date.getDate(), targetMonthLastDay));
  return formatDateValue(targetMonthStart);
}

function CalendarDateField({
  label,
  value,
  onChange,
  minDate,
  maxDate,
  hint,
  navigatorTitle,
  onPrevious,
  onNext,
  previousDisabled,
  nextDisabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  minDate?: string;
  maxDate?: string;
  hint?: string;
  navigatorTitle?: string;
  onPrevious?: () => void;
  onNext?: () => void;
  previousDisabled?: boolean;
  nextDisabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [periodPicker, setPeriodPicker] = useState<'year' | 'month' | null>(null);
  const [viewMonth, setViewMonth] = useState(() => {
    const selectedDate = parseDateValue(value) ?? new Date();
    return new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
  });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const minimumDate = parseDateValue(minDate ?? '1980-01-01') ?? new Date(1980, 0, 1);
  const maximumDate = parseDateValue(maxDate ?? formatDateValue(today)) ?? today;
  minimumDate.setHours(0, 0, 0, 0);
  maximumDate.setHours(0, 0, 0, 0);

  const openCalendar = () => {
    const selectedDate = parseDateValue(value) ?? today;
    setViewMonth(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
    setPeriodPicker(null);
    setExpanded((current) => !current);
  };

  const firstWeekday = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1).getDay();
  const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate();
  const availableYears = Array.from(
    { length: maximumDate.getFullYear() - minimumDate.getFullYear() + 1 },
    (_, index) => maximumDate.getFullYear() - index,
  );

  return (
    <View style={styles.formField}>
      {navigatorTitle ? (
        <View style={[styles.recordDateNavigator, expanded && styles.recordDateNavigatorExpanded]}>
          <TouchableOpacity
            accessibilityLabel="查看前一天"
            disabled={previousDisabled}
            style={[styles.recordDateArrow, previousDisabled && styles.recordDateArrowDisabled]}
            onPress={onPrevious}
          >
            <Text style={[styles.recordDateArrowText, previousDisabled && styles.recordDateArrowTextDisabled]}>‹</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`${label}：${value}`}
            accessibilityState={{ expanded }}
            style={styles.recordDateCenter}
            onPress={openCalendar}
          >
            <Text style={styles.recordDateTitle}>{navigatorTitle}</Text>
            <View style={styles.recordDateValueRow}>
              <Text style={styles.recordDateCalendarIcon}>📅</Text>
              <Text style={styles.recordDateValue}>{value}</Text>
              <Text style={styles.recordDateExpandIcon}>{expanded ? '⌃' : '⌄'}</Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityLabel="查看後一天"
            disabled={nextDisabled}
            style={[styles.recordDateArrow, nextDisabled && styles.recordDateArrowDisabled]}
            onPress={onNext}
          >
            <Text style={[styles.recordDateArrowText, nextDisabled && styles.recordDateArrowTextDisabled]}>›</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <Text style={styles.formLabel}>{label}</Text>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`${label}：${value || '尚未選擇'}`}
            accessibilityState={{ expanded }}
            style={[styles.selectButton, expanded && styles.selectButtonExpanded]}
            onPress={openCalendar}
          >
            <View style={styles.selectValueRow}>
              <Text style={styles.calendarFieldIcon}>📅</Text>
              <Text style={[styles.selectValue, !value && styles.calendarPlaceholder]}>{value || '點選日期'}</Text>
            </View>
            <Text style={styles.selectChevron}>{expanded ? '⌃' : '⌄'}</Text>
          </TouchableOpacity>
        </>
      )}

      {expanded ? (
        <View style={styles.calendarCard}>
          <View style={styles.calendarHeader}>
            <View style={styles.calendarPeriodSelector}>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`選擇年份，目前 ${viewMonth.getFullYear()} 年`}
                accessibilityState={{ expanded: periodPicker === 'year' }}
                style={[styles.calendarPeriodButton, periodPicker === 'year' && styles.calendarPeriodButtonActive]}
                onPress={() => setPeriodPicker((current) => current === 'year' ? null : 'year')}
              >
                <Text style={[styles.calendarPeriodLabel, periodPicker === 'year' && styles.calendarPeriodLabelActive]}>年份</Text>
                <View style={styles.calendarPeriodValueRow}>
                  <Text style={[styles.calendarPeriodButtonText, periodPicker === 'year' && styles.calendarPeriodButtonTextActive]}>
                    {viewMonth.getFullYear()} 年
                  </Text>
                  <Text style={[styles.calendarPeriodChevron, periodPicker === 'year' && styles.calendarPeriodButtonTextActive]}>
                    {periodPicker === 'year' ? '⌃' : '⌄'}
                  </Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`選擇月份，目前 ${viewMonth.getMonth() + 1} 月`}
                accessibilityState={{ expanded: periodPicker === 'month' }}
                style={[styles.calendarPeriodButton, periodPicker === 'month' && styles.calendarPeriodButtonActive]}
                onPress={() => setPeriodPicker((current) => current === 'month' ? null : 'month')}
              >
                <Text style={[styles.calendarPeriodLabel, periodPicker === 'month' && styles.calendarPeriodLabelActive]}>月份</Text>
                <View style={styles.calendarPeriodValueRow}>
                  <Text style={[styles.calendarPeriodButtonText, periodPicker === 'month' && styles.calendarPeriodButtonTextActive]}>
                    {viewMonth.getMonth() + 1} 月
                  </Text>
                  <Text style={[styles.calendarPeriodChevron, periodPicker === 'month' && styles.calendarPeriodButtonTextActive]}>
                    {periodPicker === 'month' ? '⌃' : '⌄'}
                  </Text>
                </View>
              </TouchableOpacity>
            </View>
          </View>

          {periodPicker === 'year' ? (
            <View style={styles.calendarPeriodPanel}>
              <Text style={styles.calendarPeriodPanelTitle}>選擇年份</Text>
              <ScrollView style={styles.calendarPeriodScroll} nestedScrollEnabled showsVerticalScrollIndicator={false}>
                <View style={styles.calendarPeriodGrid}>
                {availableYears.map((year) => {
                  const isSelectedYear = year === viewMonth.getFullYear();
                  return (
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel={`${year} 年`}
                      accessibilityState={{ selected: isSelectedYear }}
                      key={year}
                      style={[styles.calendarPeriodOption, isSelectedYear && styles.calendarPeriodOptionSelected]}
                      onPress={() => {
                        let month = viewMonth.getMonth();
                        if (year === minimumDate.getFullYear()) month = Math.max(month, minimumDate.getMonth());
                        if (year === maximumDate.getFullYear()) month = Math.min(month, maximumDate.getMonth());
                        setViewMonth(new Date(year, month, 1));
                        setPeriodPicker('month');
                      }}
                    >
                      <Text style={[styles.calendarPeriodOptionText, isSelectedYear && styles.calendarPeriodOptionTextSelected]}>
                        {year}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
                </View>
              </ScrollView>
            </View>
          ) : periodPicker === 'month' ? (
            <View style={styles.calendarPeriodPanel}>
              <Text style={styles.calendarPeriodPanelTitle}>選擇月份</Text>
              <View style={styles.calendarPeriodGrid}>
                {Array.from({ length: 12 }, (_, month) => {
                  const isSelectedMonth = month === viewMonth.getMonth();
                  const monthStart = new Date(viewMonth.getFullYear(), month, 1);
                  const monthEnd = new Date(viewMonth.getFullYear(), month + 1, 0);
                  const isUnavailableMonth = monthEnd < minimumDate || monthStart > maximumDate;
                  return (
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel={`${month + 1} 月`}
                      accessibilityState={{ selected: isSelectedMonth, disabled: isUnavailableMonth }}
                      key={month}
                      disabled={isUnavailableMonth}
                      style={[
                        styles.calendarPeriodOption,
                        isSelectedMonth && styles.calendarPeriodOptionSelected,
                        isUnavailableMonth && styles.calendarPeriodOptionDisabled,
                      ]}
                      onPress={() => {
                        setViewMonth(new Date(viewMonth.getFullYear(), month, 1));
                        setPeriodPicker(null);
                      }}
                    >
                      <Text style={[
                        styles.calendarPeriodOptionText,
                        isSelectedMonth && styles.calendarPeriodOptionTextSelected,
                        isUnavailableMonth && styles.calendarPeriodOptionTextDisabled,
                      ]}>
                        {month + 1} 月
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          ) : (
            <>
              <View style={styles.calendarWeekRow}>
                {calendarWeekdays.map((weekday) => (
                  <Text key={weekday} style={styles.calendarWeekday}>{weekday}</Text>
                ))}
              </View>

              <View style={styles.calendarDaysGrid}>
                {Array.from({ length: 42 }, (_, index) => {
                  const day = index - firstWeekday + 1;
                  if (day < 1 || day > daysInMonth) {
                    return <View key={`empty-${index}`} style={styles.calendarDayCell} />;
                  }

                  const date = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), day);
                  const dateValue = formatDateValue(date);
                  const isSelected = dateValue === value;
                  const isToday = dateValue === formatDateValue(today);
                  const isUnavailable = date < minimumDate || date > maximumDate;

                  return (
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel={`${viewMonth.getFullYear()} 年 ${viewMonth.getMonth() + 1} 月 ${day} 日`}
                      accessibilityState={{ selected: isSelected, disabled: isUnavailable }}
                      key={dateValue}
                      disabled={isUnavailable}
                      style={styles.calendarDayCell}
                      onPress={() => {
                        onChange(dateValue);
                        setExpanded(false);
                      }}
                    >
                      <View style={[
                        styles.calendarDayCircle,
                        isToday && styles.calendarToday,
                        isSelected && styles.calendarDaySelected,
                      ]}>
                        <Text style={[
                          styles.calendarDayText,
                          isUnavailable && styles.calendarDayTextDisabled,
                          isSelected && styles.calendarDayTextSelected,
                        ]}>{day}</Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
          )}
          <Text style={styles.calendarHint}>{hint ?? '生日不能晚於今天'}</Text>
        </View>
      ) : null}
    </View>
  );
}

function FormField({
  label,
  placeholder,
  value,
  onChangeText,
  keyboardType = 'default',
  multiline = false,
  maxLength,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  keyboardType?: 'default' | 'decimal-pad' | 'number-pad';
  multiline?: boolean;
  maxLength?: number;
}) {
  return (
    <View style={styles.formField}>
      <Text style={styles.formLabel}>{label}</Text>
      <TextInput
        style={[styles.formInput, styles.formControlText, multiline && styles.formInputMultiline]}
        placeholder={placeholder}
        placeholderTextColor="#A5AFAA"
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        multiline={multiline}
        maxLength={maxLength}
        textAlignVertical={multiline ? 'top' : 'center'}
      />
    </View>
  );
}

const colors = {
  ink: '#19352B',
  muted: '#6C7E76',
  green: '#2D6A4F',
  greenDark: '#1F513C',
  mint: '#E8F4EC',
  cream: '#F7F6F0',
  white: '#FFFFFF',
  line: '#E6EAE6',
};

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.cream },
  appShell: {
    flex: 1,
    width: '100%',
    maxWidth: layoutTokens.contentMaxWidth,
    alignSelf: 'center',
    backgroundColor: colors.cream,
    borderLeftWidth: Platform.OS === 'web' ? 1 : 0,
    borderRightWidth: Platform.OS === 'web' ? 1 : 0,
    borderColor: colors.line,
  },
  content: { flex: 1 },
  tabScreen: { flex: 1, minHeight: 0, backgroundColor: colors.cream },
  tabHeader: { flexShrink: 0, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 12, backgroundColor: colors.cream, zIndex: 2 },
  tabScroll: { flex: 1, minHeight: 0 },
  scrollContent: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 32 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { fontSize: 13, color: colors.muted, fontWeight: '600', letterSpacing: 0.3, marginBottom: 4 },
  brand: { fontSize: 24, color: colors.ink, fontWeight: '800', letterSpacing: -0.6 },
  notificationButton: { width: 44, height: 44, borderRadius: 15, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line },
  notificationIcon: { fontSize: 23, color: colors.ink, transform: [{ rotate: '45deg' }] },
  notificationDot: { position: 'absolute', right: 5, top: 4, minWidth: 17, height: 17, paddingHorizontal: 3, backgroundColor: '#E76F51', borderRadius: 9, borderWidth: 1.5, borderColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  notificationCount: { color: colors.white, fontSize: 8, fontWeight: '900' },
  petCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.white, borderRadius: 22, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: colors.line },
  petAvatar: { width: 52, height: 52, borderRadius: 18, backgroundColor: '#FFF0D9', alignItems: 'center', justifyContent: 'center', marginRight: 13, overflow: 'hidden' },
  petAvatarText: { fontSize: 30 },
  petAvatarImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  petInfo: { flex: 1 },
  petNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  petName: { fontSize: 18, color: colors.ink, fontWeight: '800' },
  demoPill: { backgroundColor: '#F0F1EE', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 8 },
  demoPillText: { color: colors.muted, fontSize: 9, fontWeight: '700' },
  petMeta: { marginTop: 4, fontSize: 12, color: colors.muted },
  chevron: { color: colors.muted, fontSize: 20, paddingHorizontal: 8 },
  healthCard: { backgroundColor: colors.greenDark, borderRadius: 26, padding: 20, marginBottom: 14, overflow: 'hidden' },
  healthHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  healthHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  sectionKicker: { color: '#8EAA9D', fontSize: 11, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 5 },
  healthTitle: { color: colors.white, fontSize: 21, fontWeight: '800' },
  careRefreshButton: { minHeight: 30, paddingHorizontal: 9, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: '#4E8B6B', backgroundColor: 'rgba(255,255,255,0.08)' },
  careRefreshButtonText: { color: '#DCEDE4', fontSize: 9, fontWeight: '900' },
  metricsRow: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 18, paddingVertical: 14 },
  metric: { flex: 1, alignItems: 'center' },
  metricIconBadge: { width: 32, height: 32, borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  metricIcon: { fontSize: 18, lineHeight: 22 },
  metricValue: { color: colors.white, fontWeight: '800', fontSize: 12 },
  metricLabel: { color: '#AFC7BB', fontSize: 10, marginTop: 3 },
  careLogicNote: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 13, paddingHorizontal: 2 },
  careLogicIcon: { color: '#91B5A2', fontSize: 12, fontWeight: '900', marginRight: 7, marginTop: 1 },
  careLogicText: { flex: 1, color: '#B9D0C4', fontSize: 9, lineHeight: 15 },
  reminderCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF5E8', borderRadius: 20, padding: 14, marginBottom: 24, borderWidth: 1, borderColor: '#F5E4CE' },
  reminderCompleteCard: { backgroundColor: '#EEF6F0', borderColor: '#DDEBDF' },
  reminderIcon: { width: 45, height: 45, borderRadius: 15, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  reminderEmoji: { fontSize: 22 },
  reminderContent: { flex: 1 },
  reminderOverline: { color: '#A26C35', fontSize: 9, fontWeight: '700', letterSpacing: 0.4 },
  reminderTitle: { color: colors.ink, fontSize: 14, fontWeight: '800', marginTop: 3 },
  reminderText: { color: colors.muted, fontSize: 10, marginTop: 2 },
  reminderManageLink: { color: '#8A592C', fontSize: 9, fontWeight: '900', marginTop: 5 },
  doneButton: { backgroundColor: '#E7CFB2', paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12 },
  doneButtonText: { color: '#7B4F25', fontSize: 11, fontWeight: '800' },
  doneButtonDisabled: { backgroundColor: '#E8E4DE' },
  doneButtonTextDisabled: { color: '#A49B91' },
  preventiveCareSection: { marginBottom: 24 },
  preventiveCareHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 },
  preventiveCareHeaderCompact: { flexDirection: 'column', alignItems: 'flex-start', gap: 3 },
  preventiveCareTitle: { color: colors.ink, fontSize: 15, fontWeight: '900' },
  preventiveCareHint: { color: '#91A098', fontSize: 9, fontWeight: '600' },
  preventiveCareRow: { flexDirection: 'row', gap: 10 },
  preventiveCareRowCompact: { flexDirection: 'column' },
  preventiveCareCard: { flex: 1, backgroundColor: colors.white, borderRadius: 18, borderWidth: 1, borderColor: colors.line, padding: 13 },
  preventiveCareCardOverdue: { backgroundColor: '#FFF6ED', borderColor: '#F1D6B7' },
  preventiveCareCardHeader: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 12 },
  preventiveCareIcon: { width: 30, height: 30, borderRadius: 10, backgroundColor: '#EEF4F0', alignItems: 'center', justifyContent: 'center' },
  preventiveCareIconOverdue: { backgroundColor: '#FBE2CC' },
  preventiveCareEmoji: { fontSize: 16 },
  preventiveCareLabel: { color: colors.ink, fontSize: 12, fontWeight: '900' },
  preventiveCareStatus: { color: colors.greenDark, fontSize: 16, fontWeight: '900' },
  preventiveCareStatusOverdue: { color: '#B76428' },
  preventiveCareDetail: { color: colors.muted, fontSize: 9, marginTop: 4 },
  preventiveCareAction: { color: colors.green, fontSize: 9, fontWeight: '900', marginTop: 9 },
  preventiveCareCardCompleteButton: { minHeight: layoutTokens.minimumTouchSize, borderRadius: 10, backgroundColor: '#FFF1E1', borderWidth: 1, borderColor: '#EDCFAE', alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  preventiveCareCardCompleteButtonDisabled: { backgroundColor: '#ECEDEB', borderColor: '#D9DDDA' },
  preventiveCareCardCompleteButtonText: { color: '#9A5A24', fontSize: 10, fontWeight: '900' },
  preventiveCareCardCompleteButtonTextDisabled: { color: '#9BA49F' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: '800' },
  textLink: { color: colors.green, fontSize: 12, fontWeight: '700' },
  actionGrid: { flexDirection: 'row', gap: 9, marginBottom: 22 },
  actionCard: { flex: 1, alignItems: 'center', backgroundColor: colors.white, borderRadius: 17, paddingVertical: 13, borderWidth: 1, borderColor: colors.line },
  actionIcon: { width: 37, height: 37, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginBottom: 7 },
  actionEmoji: { fontSize: 18 },
  urineIconCanvas: { position: 'relative', alignItems: 'center', justifyContent: 'flex-end' },
  urinePuddleBase: { position: 'absolute', left: 0, backgroundColor: '#E6BB2D', borderWidth: 1, borderColor: '#C99716' },
  urinePuddleLobe: { position: 'absolute', backgroundColor: '#F0CA43', borderWidth: 1, borderColor: '#C99716' },
  urinePuddleShine: { position: 'absolute', backgroundColor: 'rgba(255,255,255,0.62)' },
  actionLabel: { color: colors.ink, fontSize: 11, fontWeight: '700' },
  walkStartCard: { minHeight: 168, borderRadius: 24, marginBottom: 14, padding: 20, backgroundColor: '#1F5C46', overflow: 'hidden', flexDirection: 'row' },
  walkStartCopy: { flex: 1, zIndex: 2 },
  walkStartBadge: { alignSelf: 'flex-start', paddingHorizontal: 9, paddingVertical: 5, borderRadius: 8, backgroundColor: '#F1CB79', marginBottom: 10 },
  walkStartBadgeText: { color: '#654A18', fontSize: 9, fontWeight: '900', letterSpacing: 0.5 },
  walkStartTitle: { color: colors.white, fontSize: 20, fontWeight: '900', marginBottom: 7 },
  walkStartText: { color: '#C6DED3', fontSize: 12, lineHeight: 18, maxWidth: '78%' },
  walkStartAction: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 15 },
  walkStartActionText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  walkStartArrow: { color: '#F1CB79', fontSize: 16 },
  walkStartArt: { position: 'absolute', right: -8, bottom: -10, width: 112, height: 112, borderRadius: 56, backgroundColor: '#F1CB79', alignItems: 'center', justifyContent: 'center' },
  walkStartArtText: { fontSize: 51 },
  timelineCard: { backgroundColor: colors.white, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 8, borderWidth: 1, borderColor: colors.line, marginBottom: 22 },
  timelineRow: { flexDirection: 'row', minHeight: 74 },
  timelineRail: { width: 43, alignItems: 'center' },
  timelineIcon: { width: 34, height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginTop: 15, zIndex: 2 },
  timelineEmoji: { fontSize: 16 },
  timelineLine: { position: 'absolute', top: 49, bottom: -15, width: 1, backgroundColor: colors.line },
  timelineContent: { flex: 1, paddingLeft: 7, paddingVertical: 16 },
  timelineContentBorder: { borderBottomWidth: 1, borderBottomColor: colors.line },
  timelineTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  timelineTitle: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  timelineTime: { color: '#93A098', fontSize: 9 },
  timelineDetail: { color: colors.muted, fontSize: 11, marginTop: 5 },
  timelineEditHint: { color: '#91A49A', fontSize: 8, fontWeight: '700', marginTop: 7 },
  timelineSyncStatus: { alignSelf: 'flex-start', color: '#87612C', fontSize: 9, fontWeight: '800', backgroundColor: '#FFF3D9', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4, marginTop: 7 },
  timelineSyncStatusFailed: { color: '#A34D47', backgroundColor: '#FCE9E6' },
  pageHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pageTitle: { color: colors.ink, fontSize: 28, fontWeight: '900', letterSpacing: -0.8 },
  primaryMiniButton: { backgroundColor: colors.green, borderRadius: 13, paddingHorizontal: 13, paddingVertical: 10 },
  primaryMiniButtonText: { color: colors.white, fontSize: 12, fontWeight: '800' },
  recordHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  refreshMiniButton: { backgroundColor: colors.mint, borderRadius: 13, paddingHorizontal: 11, paddingVertical: 10 },
  refreshMiniButtonText: { color: colors.greenDark, fontSize: 10, fontWeight: '900' },
  petScopeRow: { gap: 8, paddingBottom: 14 },
  petScopeChip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 13, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  petScopeChipActive: { backgroundColor: colors.greenDark, borderColor: colors.greenDark },
  petScopeText: { color: colors.muted, fontSize: 10, fontWeight: '800' },
  petScopeTextActive: { color: colors.white },
  walkHistorySection: { marginBottom: 18 },
  walkHistoryHeader: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 10 },
  walkHistoryKicker: { color: '#7E9188', fontSize: 9, fontWeight: '900', letterSpacing: 0.5 },
  walkHistoryTitle: { color: colors.ink, fontSize: 17, fontWeight: '900', marginTop: 2 },
  walkHistoryCount: { color: '#718078', fontSize: 11, fontWeight: '700' },
  walkHistoryCard: { backgroundColor: '#FFFFFF', borderRadius: 18, borderWidth: 1, borderColor: colors.line, padding: 14, marginBottom: 9 },
  walkHistoryCardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  walkHistoryDate: { color: '#6C7D75', fontSize: 10, fontWeight: '800' },
  walkHistoryPet: { color: colors.ink, fontSize: 14, fontWeight: '900', marginTop: 4 },
  walkHistoryDistance: { flexDirection: 'row', alignItems: 'baseline', gap: 3 },
  walkHistoryDistanceValue: { color: colors.greenDark, fontSize: 24, fontWeight: '900', fontVariant: ['tabular-nums'] },
  walkHistoryDistanceUnit: { color: '#667970', fontSize: 10, fontWeight: '800' },
  walkHistoryMeta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 11, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#EDF0ED' },
  walkHistoryMetaText: { color: '#63736B', fontSize: 10.5, fontWeight: '700' },
  walkHistoryMetaDot: { color: '#B1BBB6', fontSize: 8 },
  walkHistoryEmpty: { minHeight: 80, borderRadius: 18, backgroundColor: '#EEF4F0', flexDirection: 'row', alignItems: 'center', gap: 12, padding: 15 },
  walkHistoryEmptyIcon: { width: 39, height: 39, borderRadius: 13, backgroundColor: '#FFFFFF', color: colors.green, textAlign: 'center', lineHeight: 39, fontSize: 20 },
  walkHistoryEmptyTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' },
  walkHistoryEmptyText: { color: colors.muted, fontSize: 10, marginTop: 3 },
  walkDailyList: { marginBottom: 10 },
  filterSelector: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 17, paddingHorizontal: 16, paddingVertical: 10, marginBottom: 18 },
  filterSelectorLabel: { color: colors.muted, fontSize: 9, fontWeight: '700' },
  filterSelectorValue: { color: colors.ink, fontSize: 14, fontWeight: '900', marginTop: 3 },
  filterSelectorChevron: { color: colors.green, fontSize: 22, fontWeight: '900' },
  filterPickerBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(12,30,23,0.48)', padding: 22 },
  filterPickerCard: { width: '100%', maxWidth: layoutTokens.dialogMaxWidth, backgroundColor: '#F7F6F0', borderRadius: 22, padding: 18 },
  offlineSyncCard: { backgroundColor: '#F5F8F6', borderWidth: 1, borderColor: '#DCE8E1', borderRadius: 18, padding: 14, marginBottom: 14 },
  offlineSyncHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  offlineSyncIcon: { width: 36, aspectRatio: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: '#E4F0E9' },
  offlineSyncCopy: { flex: 1, minWidth: 0 },
  offlineSyncTitle: { color: '#244E3E', fontSize: 12, fontWeight: '900' },
  offlineSyncText: { color: '#748078', fontSize: 10, lineHeight: 16, marginTop: 2 },
  offlineSyncSettings: { color: '#2D6A4F', fontSize: 11, fontWeight: '900', paddingVertical: 8 },
  offlineSyncButton: { minHeight: layoutTokens.minimumTouchSize, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: '#2D6A4F', marginTop: 12 },
  offlineSyncButtonDisabled: { opacity: 0.5 },
  offlineSyncButtonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
  offlineModeOption: { minHeight: 62, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#E0E5E2', borderRadius: 15, backgroundColor: '#FFFFFF', paddingHorizontal: 14, paddingVertical: 10, marginTop: 10 },
  offlineModeOptionActive: { borderColor: '#5B8C73', backgroundColor: '#EEF6F1' },
  offlineModeCopy: { flex: 1, minWidth: 0 },
  offlineModeTitle: { color: '#244E3E', fontSize: 12, fontWeight: '900' },
  offlineModeText: { color: '#748078', fontSize: 10, lineHeight: 15, marginTop: 2 },
  offlineModeCheck: { width: 22, color: '#2D6A4F', fontSize: 16, fontWeight: '900', textAlign: 'center' },
  filterPickerHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 15 },
  filterPickerTitle: { color: colors.ink, fontSize: 18, fontWeight: '900' },
  filterPickerSubtitle: { color: colors.muted, fontSize: 9, marginTop: 4 },
  filterPickerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  filterPickerOption: { width: '48%', minHeight: 46, flexGrow: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 13, paddingHorizontal: 13 },
  filterPickerOptionActive: { backgroundColor: colors.greenDark, borderColor: colors.greenDark },
  filterPickerOptionText: { color: colors.ink, fontSize: 11, fontWeight: '800' },
  filterPickerOptionTextActive: { color: colors.white },
  filterPickerCheck: { color: colors.white, fontSize: 13, fontWeight: '900' },
  recordDateNavigator: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.white, borderRadius: 19, borderWidth: 1, borderColor: colors.line, padding: 9 },
  recordDateNavigatorExpanded: { borderColor: colors.green },
  recordDateArrow: { width: 43, height: 43, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.mint },
  recordDateArrowDisabled: { backgroundColor: '#F1F2F0' },
  recordDateArrowText: { color: colors.green, fontSize: 29, lineHeight: 31, fontWeight: '500' },
  recordDateArrowTextDisabled: { color: '#B9C1BC' },
  recordDateCenter: { flex: 1, alignItems: 'center' },
  recordDateTitle: { color: colors.ink, fontSize: 16, fontWeight: '900' },
  recordDateValue: { color: colors.muted, fontSize: 9, marginTop: 3 },
  recordDateValueRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  recordDateCalendarIcon: { fontSize: 10, marginTop: 3 },
  recordDateExpandIcon: { color: colors.green, fontSize: 11, fontWeight: '900', marginTop: 2 },
  healthTrendCard: { backgroundColor: colors.greenDark, borderRadius: 23, padding: 17, marginBottom: 20 },
  healthTrendHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  healthTrendHeading: { flex: 1, paddingRight: 10 },
  healthTrendKicker: { color: '#AFC7BB', fontSize: 9, fontWeight: '800' },
  healthTrendTitle: { color: colors.white, fontSize: 16, fontWeight: '900', marginTop: 3 },
  trendRangeControl: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.09)', borderRadius: 11, padding: 3 },
  trendRangeButton: { minHeight: 30, minWidth: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 9, paddingHorizontal: 8 },
  trendRangeButtonActive: { backgroundColor: colors.white },
  trendRangeButtonText: { color: '#BCD1C6', fontSize: 9, fontWeight: '900' },
  trendRangeButtonTextActive: { color: colors.greenDark },
  trendOverview: { gap: 8, marginBottom: 13 },
  trendMiniRow: { minHeight: 51, flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 13, paddingHorizontal: 11, paddingVertical: 7 },
  trendMiniLabelWrap: { width: 68 },
  trendMiniLabel: { color: colors.white, fontSize: 10, fontWeight: '900' },
  trendMiniValue: { color: '#AFC7BB', fontSize: 8, marginTop: 3 },
  trendMiniChart: { flex: 1, height: 37, flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  trendMiniSlot: { flex: 1, height: 37, alignItems: 'center', justifyContent: 'flex-end' },
  trendMiniBar: { width: '72%', minWidth: 2, maxWidth: 10, borderRadius: 3, backgroundColor: '#8FD0AC' },
  trendMiniBarAlert: { backgroundColor: '#FFB36B' },
  trendInsightRow: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 13, padding: 11, marginTop: 10 },
  trendInsightIcon: { width: 20, height: 20, borderRadius: 10, textAlign: 'center', textAlignVertical: 'center', color: colors.greenDark, backgroundColor: '#BDE3CB', fontSize: 10, fontWeight: '900', marginRight: 8 },
  trendInsightText: { flex: 1, color: colors.white, fontSize: 10, lineHeight: 16 },
  trendDisclaimer: { color: '#9DB9AC', fontSize: 8, lineHeight: 12, marginTop: 9 },
  preventiveTimeline: { minHeight: 118, justifyContent: 'center', marginHorizontal: 4, marginBottom: 5 },
  preventiveTimelineLine: { position: 'absolute', left: '5%', right: '5%', top: 48, height: 2, backgroundColor: 'rgba(255,255,255,0.22)' },
  preventiveTimelineEvent: { position: 'absolute', top: 38, width: 58, marginLeft: -29, alignItems: 'center' },
  preventiveTimelineDot: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#8FD0AC', borderWidth: 4, borderColor: colors.greenDark },
  preventiveTimelineDate: { color: colors.white, fontSize: 8, fontWeight: '900', marginTop: 6 },
  preventiveTimelineLabel: { color: '#AFC7BB', fontSize: 8, marginTop: 2 },
  preventiveTimelineEmpty: { color: '#BCD1C6', fontSize: 11, textAlign: 'center' },
  todayButton: { backgroundColor: '#347357', borderRadius: 11, paddingHorizontal: 10, paddingVertical: 7, borderWidth: 1, borderColor: '#4D896B' },
  todayButtonText: { color: '#E2EEE7', fontSize: 9, fontWeight: '900' },
  recordListHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  recordCount: { color: colors.muted, fontSize: 10, fontWeight: '700', marginBottom: 10 },
  recordEmptyCard: { alignItems: 'center', backgroundColor: colors.white, borderRadius: 22, borderWidth: 1, borderColor: colors.line, paddingVertical: 30, paddingHorizontal: 18, marginBottom: 22 },
  recordEmptyIcon: { color: '#9AA9A1', fontSize: 24, fontWeight: '800' },
  recordEmptyTitle: { color: colors.ink, fontSize: 13, fontWeight: '900', marginTop: 9 },
  recordEmptyText: { color: colors.muted, fontSize: 9, marginTop: 4 },
  smartBinResumeCard: { minHeight: 92, flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF3D9', borderRadius: 21, borderWidth: 1, borderColor: '#E8D5A8', padding: 14, marginBottom: 14 },
  smartBinResumeIcon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E2F1E8', marginRight: 12 },
  smartBinResumeIconText: { color: colors.green, fontSize: 24, fontWeight: '900' },
  smartBinResumeCopy: { flex: 1, minWidth: 0 },
  smartBinResumeLabel: { color: '#805B18', fontSize: 9, fontWeight: '900' },
  smartBinResumeTitle: { color: colors.ink, fontSize: 14, fontWeight: '900', marginTop: 3 },
  smartBinResumeText: { color: colors.muted, fontSize: 9, lineHeight: 14, marginTop: 3 },
  weekCard: { backgroundColor: '#E8F1EB', borderRadius: 22, padding: 18, marginBottom: 22 },
  weekTitle: { color: colors.ink, fontSize: 17, fontWeight: '800' },
  weekBars: { height: 58, flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: 16 },
  barTrack: { flex: 1, height: '100%', borderRadius: 6, backgroundColor: 'rgba(45,106,79,0.12)', overflow: 'hidden', justifyContent: 'flex-end' },
  barFill: { width: '100%', borderRadius: 6, backgroundColor: '#65A47F' },
  dateHeading: { color: colors.ink, fontSize: 13, fontWeight: '800', marginBottom: 10 },
  chevronRight: { color: '#96A29C', fontSize: 24, fontWeight: '300' },
  cameraHeaderLeft: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' },
  cameraBackButton: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.mint, marginRight: 11 },
  cameraBackButtonText: { color: colors.green, fontSize: 32, lineHeight: 34, fontWeight: '500' },
  cameraHeaderCopy: { flex: 1, minWidth: 0 },
  cameraTabBody: { flex: 1, minHeight: 0, overflow: 'hidden' },
  cameraLoading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cream },
  permissionScreen: { flex: 1, paddingHorizontal: 35, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cream },
  permissionIcon: { width: 82, height: 82, borderRadius: 30, backgroundColor: colors.mint, alignItems: 'center', justifyContent: 'center', marginBottom: 22 },
  permissionEmoji: { fontSize: 38 },
  permissionTitle: { color: colors.ink, fontSize: 23, fontWeight: '900', marginBottom: 10 },
  permissionText: { color: colors.muted, textAlign: 'center', fontSize: 13, lineHeight: 21, marginBottom: 24 },
  primaryButton: { width: '100%', backgroundColor: colors.green, borderRadius: 16, paddingVertical: 15, alignItems: 'center' },
  primaryButtonText: { color: colors.white, fontSize: 14, fontWeight: '800' },
  secondaryButton: { width: '100%', paddingVertical: 13, alignItems: 'center', marginTop: 4 },
  secondaryButtonText: { color: colors.green, fontSize: 13, fontWeight: '800' },
  cameraPage: { flex: 1, backgroundColor: '#08100C', overflow: 'hidden' },
  capturedImage: { position: 'absolute', inset: 0, width: '100%', height: '100%', resizeMode: 'contain' },
  cameraShadeTop: { position: 'absolute', top: 0, left: 0, right: 0, paddingTop: 14, paddingHorizontal: 20, paddingBottom: 24, backgroundColor: 'rgba(5,15,10,0.52)' },
  cameraInstructionText: { color: '#F0F6F3', fontSize: 12, fontWeight: '700', textAlign: 'center' },
  guideFrame: { position: 'absolute' },
  guideCorner: { position: 'absolute', width: 36, height: 36, borderColor: colors.white },
  guideTopLeft: { left: 0, top: 0, borderLeftWidth: 3, borderTopWidth: 3, borderTopLeftRadius: 13 },
  guideTopRight: { right: 0, top: 0, borderRightWidth: 3, borderTopWidth: 3, borderTopRightRadius: 13 },
  guideBottomLeft: { left: 0, bottom: 0, borderLeftWidth: 3, borderBottomWidth: 3, borderBottomLeftRadius: 13 },
  guideBottomRight: { right: 0, bottom: 0, borderRightWidth: 3, borderBottomWidth: 3, borderBottomRightRadius: 13 },
  cameraBottom: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center' },
  liveOnlyPill: { backgroundColor: 'rgba(5,15,10,0.48)', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 15, marginBottom: 8 },
  liveOnlyText: { color: colors.white, fontSize: 10, fontWeight: '700' },
  cameraControlsShade: { width: '100%', alignItems: 'center', paddingTop: 12, paddingBottom: 28, backgroundColor: 'rgba(5,15,10,0.67)' },
  cameraZoomControls: { flexDirection: 'row', gap: 8, padding: 5, borderRadius: 18, backgroundColor: 'rgba(5,15,10,0.58)', marginBottom: 5 },
  cameraZoomButton: { minWidth: 56, minHeight: 44, paddingHorizontal: 10, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  cameraZoomButtonActive: { backgroundColor: colors.white },
  cameraZoomButtonText: { color: '#D8E4DE', fontSize: 11, fontWeight: '800' },
  cameraZoomButtonTextActive: { color: colors.green, fontWeight: '900' },
  cameraZoomHint: { color: '#CAD4CF', fontSize: 8, marginBottom: 14 },
  cameraCaptureControls: { width: '100%', paddingHorizontal: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  torchButton: { width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.16)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)', alignItems: 'center', justifyContent: 'center' },
  torchButtonActive: { backgroundColor: '#FFE8A3', borderColor: '#FFE8A3' },
  torchButtonText: { color: colors.white, fontSize: 22 },
  torchButtonTextActive: { color: '#6B4D00' },
  cameraControlSpacer: { width: 48, height: 48 },
  shutterOuter: { width: 72, height: 72, borderRadius: 40, borderWidth: 4, borderColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  shutterInner: { width: 56, height: 56, borderRadius: 30, backgroundColor: colors.white },
  cameraHint: { color: '#CAD4CF', fontSize: 9, marginTop: 14 },
  captureReview: { position: 'absolute', left: 14, right: 14, bottom: 16, backgroundColor: colors.white, borderRadius: 24, padding: 19 },
  reviewTitle: { color: colors.ink, fontSize: 18, fontWeight: '900' },
  reviewText: { color: colors.muted, fontSize: 11, lineHeight: 17, marginTop: 5, marginBottom: 16 },
  reviewActions: { flexDirection: 'row', gap: 10 },
  reviewSecondary: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: 14, backgroundColor: '#EEF1EE' },
  reviewSecondaryText: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  reviewPrimary: { flex: 2, alignItems: 'center', paddingVertical: 13, borderRadius: 14, backgroundColor: colors.green },
  reviewPrimaryText: { color: colors.white, fontSize: 12, fontWeight: '800' },
  analysisOverlay: { position: 'absolute', inset: 0, backgroundColor: 'rgba(5,15,10,0.58)', alignItems: 'center', justifyContent: 'center' },
  analysisCard: { width: '72%', alignItems: 'center', backgroundColor: colors.white, borderRadius: 24, padding: 26 },
  analysisTitle: { color: colors.ink, fontSize: 17, fontWeight: '900', marginTop: 14 },
  analysisText: { color: colors.muted, fontSize: 11, marginTop: 5 },
  resultSheet: { position: 'absolute', left: 14, right: 14, bottom: 15, backgroundColor: colors.white, borderRadius: 25, padding: 19 },
  successIcon: { position: 'absolute', right: 18, top: 18, width: 36, height: 36, borderRadius: 18, backgroundColor: '#DFF2E6', alignItems: 'center', justifyContent: 'center' },
  successMark: { color: colors.green, fontSize: 20, fontWeight: '900' },
  resultHeading: { marginBottom: 8 },
  resultTitle: { color: colors.ink, fontSize: 19, fontWeight: '900' },
  resultConfidence: { color: colors.green, fontSize: 10, fontWeight: '700', marginTop: 3 },
  resultText: { color: colors.muted, fontSize: 11, marginBottom: 12 },
  resultNotice: { backgroundColor: colors.mint, borderRadius: 13, padding: 11, marginBottom: 12 },
  resultNoticeText: { color: '#3E6553', fontSize: 10, lineHeight: 16 },
  analysisTraceCard: { backgroundColor: '#F4F6F4', borderRadius: 13, padding: 11, marginBottom: 8, borderWidth: 1, borderColor: colors.line },
  analysisTraceTitle: { color: colors.ink, fontSize: 10, fontWeight: '900', marginBottom: 5 },
  analysisTraceText: { color: colors.muted, fontSize: 9, lineHeight: 14 },
  analysisTraceWarning: { color: '#7A5820', fontSize: 9, lineHeight: 14, marginTop: 4 },
  userAvatar: { width: 45, height: 45, borderRadius: 16, backgroundColor: '#DDECE3', alignItems: 'center', justifyContent: 'center' },
  userAvatarText: { color: colors.green, fontWeight: '900', fontSize: 17 },
  profilePetCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.white, borderRadius: 21, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: colors.line },
  profilePetAvatar: { width: 48, height: 48, borderRadius: 16, backgroundColor: '#FFF0D9', alignItems: 'center', justifyContent: 'center', marginRight: 12, overflow: 'hidden' },
  profilePetInfo: { flex: 1 },
  profilePetName: { color: colors.ink, fontSize: 15, fontWeight: '900' },
  profilePetMeta: { color: colors.muted, fontSize: 9, lineHeight: 14, marginTop: 4 },
  editPill: { backgroundColor: colors.mint, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 11 },
  editPillText: { color: colors.green, fontSize: 9, fontWeight: '800' },
  creditCard: { backgroundColor: colors.greenDark, borderRadius: 27, padding: 21, marginBottom: 13, overflow: 'hidden' },
  creditGlow: { position: 'absolute', width: 170, height: 170, borderRadius: 90, backgroundColor: '#3D7A5D', right: -65, top: -70, opacity: 0.65 },
  creditOverline: { color: '#A9C5B7', fontSize: 11, fontWeight: '700', letterSpacing: 0.7 },
  creditScoreRow: { flexDirection: 'row', alignItems: 'flex-end', marginTop: 7 },
  creditScore: { color: colors.white, fontSize: 48, lineHeight: 53, fontWeight: '900', letterSpacing: -1.5 },
  creditUnit: { color: '#B8CEC3', fontSize: 12, marginLeft: 5, marginBottom: 8 },
  creditLevel: { color: '#E3EEE8', fontSize: 12, fontWeight: '700', marginTop: 3 },
  creditProgress: { height: 7, borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.13)', marginTop: 20, overflow: 'hidden' },
  creditProgressFill: { width: '68%', height: '100%', backgroundColor: '#8FC6A5', borderRadius: 6 },
  creditHint: { color: '#A9C5B7', fontSize: 9, marginTop: 8 },
  statRow: { flexDirection: 'row', gap: 9, marginBottom: 20 },
  statCard: { flex: 1, backgroundColor: colors.white, borderRadius: 18, paddingVertical: 15, alignItems: 'center', borderWidth: 1, borderColor: colors.line },
  statValue: { color: colors.ink, fontSize: 20, fontWeight: '900' },
  statLabel: { color: colors.muted, fontSize: 9, marginTop: 4 },
  rulesCard: { backgroundColor: colors.white, borderRadius: 22, padding: 18, borderWidth: 1, borderColor: colors.line, marginBottom: 14 },
  rulesTitle: { color: colors.ink, fontSize: 15, fontWeight: '900', marginBottom: 14 },
  ruleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 11 },
  ruleNumber: { width: 25, height: 25, borderRadius: 10, backgroundColor: colors.mint, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  ruleNumberText: { color: colors.green, fontSize: 10, fontWeight: '900' },
  ruleText: { flex: 1, color: '#4B6258', fontSize: 10, lineHeight: 15 },
  rulesFootnote: { color: '#96A29C', fontSize: 8, lineHeight: 13, marginTop: 4 },
  lostPetCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF2E5', borderRadius: 20, padding: 15, borderWidth: 1, borderColor: '#F5E2CE', marginBottom: 14 },
  lostPetIcon: { width: 46, height: 46, borderRadius: 15, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  lostPetEmoji: { fontSize: 22 },
  lostPetContent: { flex: 1 },
  comingPill: { alignSelf: 'flex-start', backgroundColor: '#F1D7B9', borderRadius: 7, paddingHorizontal: 7, paddingVertical: 3, marginBottom: 4 },
  comingPillText: { color: '#8A592C', fontSize: 8, fontWeight: '800' },
  lostPetTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' },
  lostPetText: { color: colors.muted, fontSize: 9, lineHeight: 14, marginTop: 3 },
  menuCard: { backgroundColor: colors.white, borderRadius: 22, paddingHorizontal: 16, borderWidth: 1, borderColor: colors.line },
  menuRow: { minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  menuRowBorder: { borderBottomWidth: 1, borderBottomColor: colors.line },
  menuText: { color: colors.ink, fontSize: 11, fontWeight: '600' },
  tabBar: { flexDirection: 'row', backgroundColor: colors.white, borderTopWidth: 1, borderTopColor: colors.line, paddingHorizontal: 12 },
  tabItem: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  tabIconWrap: { width: 35, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  tabIconWrapActive: { backgroundColor: colors.mint },
  tabIcon: { color: '#8C9A93', fontSize: 19, fontWeight: '600' },
  tabIconActive: { color: colors.green, fontWeight: '900' },
  tabLabel: { color: '#8C9A93', fontSize: 9, fontWeight: '600', marginTop: 2 },
  tabLabelActive: { color: colors.green, fontWeight: '800' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(15,30,23,0.42)', justifyContent: 'flex-end' },
  modalSheet: { width: '100%', maxWidth: layoutTokens.contentMaxWidth, maxHeight: '88%', alignSelf: 'center', backgroundColor: colors.cream, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 18 },
  stoolMethodSheet: { maxHeight: '90%' },
  stoolPetContext: { minHeight: 68, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 18, padding: 10, marginBottom: 13 },
  stoolPetAvatar: { width: 46, height: 46, borderRadius: 15, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: '#FFF0D9', marginRight: 11 },
  stoolPetCopy: { flex: 1, minWidth: 0 },
  stoolPetLabel: { color: colors.muted, fontSize: 10, lineHeight: 15, fontWeight: '800' },
  stoolPetName: { color: colors.ink, fontSize: 15, lineHeight: 21, fontWeight: '900', marginTop: 1 },
  stoolMethodCard: { minHeight: 88, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 19, padding: 13, marginBottom: 10 },
  stoolMethodIcon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  stoolMethodCameraIcon: { backgroundColor: '#E7F1F7' },
  stoolMethodGalleryIcon: { backgroundColor: '#EEEAF8' },
  stoolMethodManualIcon: { backgroundColor: '#F2E9E2' },
  stoolMethodEmoji: { color: colors.greenDark, fontSize: 22, lineHeight: 28, fontWeight: '900' },
  stoolMethodCopy: { flex: 1, minWidth: 0 },
  stoolMethodTitle: { color: colors.ink, fontSize: 14, lineHeight: 20, fontWeight: '900' },
  stoolMethodText: { color: colors.muted, fontSize: 10, lineHeight: 16, marginTop: 3 },
  stoolMethodArrow: { color: colors.green, fontSize: 25, lineHeight: 30, fontWeight: '600', marginLeft: 8 },
  preventiveCareSheet: { maxHeight: '92%' },
  preventiveCareTabs: { flexDirection: 'row', gap: 9, marginBottom: 17 },
  preventiveCareTab: { flex: 1, minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: 15, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white },
  preventiveCareTabActive: { borderColor: colors.green, backgroundColor: colors.mint },
  preventiveCareTabEmoji: { fontSize: 17 },
  preventiveCareTabText: { color: colors.muted, fontSize: 12, fontWeight: '800' },
  preventiveCareTabTextActive: { color: colors.greenDark, fontWeight: '900' },
  petSettingsSheet: { maxHeight: '94%' },
  medicationManagerSheet: { maxHeight: '94%' },
  medicationAddView: { flex: 1, minHeight: 0 },
  medicationAddStickyHeader: { flexShrink: 0, backgroundColor: colors.cream, borderBottomWidth: 1, borderBottomColor: colors.line, paddingBottom: 12, marginBottom: 0 },
  medicationAddScroll: { flex: 1, minHeight: 0 },
  medicationAddScrollContent: { paddingTop: 16, paddingBottom: 16 },
  medicationAddFooter: { flexShrink: 0, backgroundColor: colors.cream, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 12 },
  medicationAddFooterHint: { marginBottom: 10 },
  medicationSubmitErrorCard: { backgroundColor: '#FFF0EF', borderRadius: 14, borderWidth: 1, borderColor: '#E9C4C1', paddingHorizontal: 12, paddingVertical: 10, marginBottom: 10 },
  medicationSubmitErrorText: { color: '#9D413B', fontSize: 10, lineHeight: 15, fontWeight: '700' },
  modalHandle: { width: 38, height: 4, borderRadius: 3, backgroundColor: '#C7CECA', alignSelf: 'center', marginBottom: 18 },
  modalTitle: { color: colors.ink, fontSize: 21, fontWeight: '900' },
  modalSubtitle: { color: colors.muted, fontSize: 11, marginTop: 5, marginBottom: 17 },
  medicationManagerHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  medicationManagerHeading: { flex: 1 },
  medicationAddButton: { minHeight: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.green, borderRadius: 12, paddingHorizontal: 12, marginTop: 2 },
  medicationAddButtonText: { color: colors.white, fontSize: 10, fontWeight: '900' },
  medicationPlanCard: { backgroundColor: colors.white, borderRadius: 19, borderWidth: 1, borderColor: colors.line, padding: 14, marginBottom: 11 },
  medicationPlanHeader: { flexDirection: 'row', alignItems: 'center' },
  medicationPlanIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF2DE', marginRight: 10 },
  medicationPlanEmoji: { fontSize: 21 },
  medicationPlanTitleWrap: { flex: 1 },
  medicationPlanTitle: { color: colors.ink, fontSize: 14, fontWeight: '900' },
  medicationPlanDose: { color: colors.muted, fontSize: 9, marginTop: 3 },
  medicationPlanStatus: { backgroundColor: colors.mint, borderRadius: 9, paddingHorizontal: 8, paddingVertical: 5 },
  medicationPlanStatusPaused: { backgroundColor: '#F0F1EE' },
  medicationPlanStatusText: { color: colors.green, fontSize: 8, fontWeight: '900' },
  medicationPlanStatusTextPaused: { color: colors.muted },
  medicationPlanSchedule: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  medicationPlanScheduleLabel: { color: colors.ink, fontSize: 10, fontWeight: '800', marginRight: 9 },
  medicationPlanScheduleValue: { color: colors.green, fontSize: 10, fontWeight: '900' },
  medicationPlanDates: { color: colors.muted, fontSize: 9, marginTop: 5 },
  medicationPlanNote: { color: '#53675E', fontSize: 9, lineHeight: 14, marginTop: 7, paddingTop: 7, borderTopWidth: 1, borderTopColor: '#EEF0EE' },
  medicationPlanToggle: { minHeight: 34, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F7F4EE', borderRadius: 11, marginTop: 11 },
  medicationPlanToggleResume: { backgroundColor: colors.mint },
  medicationPlanToggleText: { color: '#8A6B43', fontSize: 9, fontWeight: '900' },
  medicationPlanToggleTextResume: { color: colors.green },
  medicationEmptyCard: { alignItems: 'center', backgroundColor: colors.white, borderRadius: 19, borderWidth: 1, borderColor: colors.line, paddingVertical: 28, paddingHorizontal: 18 },
  medicationEmptyIcon: { fontSize: 27 },
  medicationEmptyTitle: { color: colors.ink, fontSize: 13, fontWeight: '900', marginTop: 8 },
  medicationEmptyText: { color: colors.muted, fontSize: 9, marginTop: 4, textAlign: 'center' },
  medicationTimesRow: { flexDirection: 'row', gap: 8 },
  medicationTimeField: { flex: 1 },
  medicationDoseRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
  medicationDoseAmount: { flex: 1 },
  medicationDoseUnit: { flex: 1.15 },
  medicationTimeButton: { minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.white, borderRadius: 15, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 12 },
  medicationTimeValue: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  medicationTimeChevron: { color: colors.green, fontSize: 16, fontWeight: '900', marginLeft: 5 },
  medicationTimePickerSheet: { maxHeight: '76%' },
  timeWheelRowWrap: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  timeWheelColumn: { flex: 1 },
  timeWheelLabel: { color: colors.muted, fontSize: 10, fontWeight: '800', textAlign: 'center', marginBottom: 7 },
  timeWheelViewport: { height: timeWheelRowHeight * 3, borderRadius: 16, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, overflow: 'hidden' },
  timeWheelFocus: { position: 'absolute', left: 6, right: 6, top: timeWheelRowHeight, height: timeWheelRowHeight, borderRadius: 12, borderWidth: 1, borderColor: '#8AB59C', backgroundColor: colors.mint, zIndex: 0 },
  timeWheelContent: { paddingVertical: timeWheelRowHeight },
  timeWheelRow: { height: timeWheelRowHeight, alignItems: 'center', justifyContent: 'center' },
  timeWheelText: { color: '#91A099', fontSize: 15, fontWeight: '600' },
  timeWheelTextSelected: { color: colors.greenDark, fontSize: 20, fontWeight: '900' },
  timeWheelColon: { color: colors.ink, fontSize: 24, fontWeight: '900', marginTop: 22 },
  modalGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  modalAction: { width: '48.5%', minHeight: 75, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.white, borderRadius: 18, padding: 11, borderWidth: 1, borderColor: colors.line },
  modalActionIcon: { width: 39, height: 39, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginRight: 9 },
  modalActionEmoji: { fontSize: 18 },
  modalActionLabel: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  modalActionDetail: { color: colors.muted, fontSize: 8, marginTop: 3 },
  entryHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 5 },
  backButton: { width: 34, height: 40, alignItems: 'flex-start', justifyContent: 'center' },
  backButtonText: { color: colors.green, fontSize: 31, lineHeight: 32, fontWeight: '400' },
  entryIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  entryIconText: { fontSize: 21 },
  entryHeadingText: { flex: 1 },
  formField: { marginBottom: 13 },
  formLabel: { color: colors.ink, fontSize: 11, fontWeight: '800', marginBottom: 7 },
  formControlText: { color: colors.ink, fontSize: 13, lineHeight: 19, fontWeight: '700', letterSpacing: 0.1 },
  formInput: { minHeight: 50, backgroundColor: colors.white, borderRadius: 15, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 14 },
  formInputMultiline: { minHeight: 82, paddingTop: 13, paddingBottom: 13 },
  formNoticeCard: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: '#F0EEF9', borderRadius: 14, padding: 12, marginBottom: 13, borderWidth: 1, borderColor: '#E3DFF2' },
  formNoticeIcon: { color: '#7565B0', fontSize: 13, fontWeight: '900', marginRight: 8 },
  formNoticeText: { flex: 1, color: '#625985', fontSize: 9, lineHeight: 15 },
  selectButton: { minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.white, borderRadius: 15, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 14 },
  selectButtonExpanded: { borderColor: '#8AB59C', borderBottomLeftRadius: 10, borderBottomRightRadius: 10 },
  selectValueRow: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  selectValue: { color: colors.ink, fontSize: 13, lineHeight: 19, fontWeight: '700', letterSpacing: 0.1 },
  selectChevron: { color: colors.green, fontSize: 16, fontWeight: '900', marginLeft: 10 },
  selectOverlayBackdrop: { backgroundColor: 'rgba(15,30,23,0.18)' },
  selectMenu: { position: 'absolute', backgroundColor: colors.white, borderRadius: 15, borderWidth: 1, borderColor: colors.line, overflow: 'hidden', elevation: 12, shadowColor: '#0F1E17', shadowOpacity: 0.18, shadowRadius: 14, shadowOffset: { width: 0, height: 6 } },
  selectOption: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 13 },
  selectOptionBorder: { borderBottomWidth: 1, borderBottomColor: '#EEF0EE' },
  selectOptionSelected: { backgroundColor: colors.mint },
  selectOptionText: { color: colors.ink, fontSize: 12 },
  selectOptionTextSelected: { color: colors.green, fontWeight: '900' },
  selectCheck: { color: colors.green, fontSize: 13, fontWeight: '900', marginLeft: 9 },
  colorSwatch: { width: 17, height: 17, borderRadius: 6, marginRight: 9, borderWidth: 1, borderColor: 'rgba(25,53,43,0.14)' },
  selectHelper: { color: colors.muted, fontSize: 8, lineHeight: 13, marginTop: 6, paddingHorizontal: 2 },
  calendarFieldIcon: { fontSize: 16, marginRight: 9 },
  calendarPlaceholder: { color: '#A5AFAA', fontWeight: '500' },
  calendarCard: { marginTop: 7, backgroundColor: colors.white, borderRadius: 18, borderWidth: 1, borderColor: colors.line, padding: 12 },
  calendarHeader: { marginBottom: 10 },
  calendarPeriodSelector: { width: '100%', flexDirection: 'row', gap: 9 },
  calendarPeriodButton: { flex: 1, minHeight: 58, justifyContent: 'center', backgroundColor: '#F3F8F5', borderRadius: 14, paddingHorizontal: 13, paddingVertical: 9, borderWidth: 1, borderColor: '#DCE8E0' },
  calendarPeriodButtonActive: { backgroundColor: colors.green, borderColor: colors.green },
  calendarPeriodLabel: { color: colors.muted, fontSize: 9, lineHeight: 12, fontWeight: '800', marginBottom: 3 },
  calendarPeriodLabelActive: { color: '#C9DED2' },
  calendarPeriodValueRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  calendarPeriodButtonText: { color: colors.ink, fontSize: 14, lineHeight: 19, fontWeight: '900' },
  calendarPeriodButtonTextActive: { color: colors.white },
  calendarPeriodChevron: { color: colors.green, fontSize: 11, fontWeight: '900', marginLeft: 8 },
  calendarPeriodPanel: { backgroundColor: '#F7F9F7', borderRadius: 14, padding: 10, borderWidth: 1, borderColor: '#E6ECE8' },
  calendarPeriodPanelTitle: { color: colors.muted, fontSize: 9, fontWeight: '800', letterSpacing: 0.5, marginBottom: 7, paddingHorizontal: 2 },
  calendarPeriodScroll: { maxHeight: 196 },
  calendarPeriodGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, paddingVertical: 2 },
  calendarPeriodOption: { width: '31.5%', minHeight: 39, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  calendarPeriodOptionSelected: { backgroundColor: colors.green, borderColor: colors.green },
  calendarPeriodOptionDisabled: { backgroundColor: '#F0F2F0', borderColor: '#EBEEEC' },
  calendarPeriodOptionText: { color: colors.ink, fontSize: 11, fontWeight: '800' },
  calendarPeriodOptionTextSelected: { color: colors.white },
  calendarPeriodOptionTextDisabled: { color: '#BEC6C1' },
  calendarWeekRow: { flexDirection: 'row', marginBottom: 3 },
  calendarWeekday: { width: '14.2857%', textAlign: 'center', color: colors.muted, fontSize: 9, fontWeight: '800', paddingVertical: 5 },
  calendarDaysGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calendarDayCell: { width: '14.2857%', height: 39, alignItems: 'center', justifyContent: 'center' },
  calendarDayCircle: { width: 31, height: 31, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  calendarToday: { borderWidth: 1, borderColor: '#8AB59C' },
  calendarDaySelected: { backgroundColor: colors.green },
  calendarDayText: { color: colors.ink, fontSize: 11, fontWeight: '700' },
  calendarDayTextDisabled: { color: '#CBD1CD' },
  calendarDayTextSelected: { color: colors.white, fontWeight: '900' },
  calendarHint: { textAlign: 'center', color: colors.muted, fontSize: 8, marginTop: 8 },
  formSaveButton: { backgroundColor: colors.green, borderRadius: 16, minHeight: 50, alignItems: 'center', justifyContent: 'center', marginTop: 5 },
  formSaveButtonDisabled: { opacity: 0.55 },
  preventiveCareCompleteButton: { backgroundColor: '#FFF1E1', borderRadius: 16, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 9, borderWidth: 1, borderColor: '#EDCFAE' },
  preventiveCareCompleteButtonText: { color: '#9A5A24', fontSize: 12, fontWeight: '900' },
  preventiveCareCompleteButtonDisabled: { backgroundColor: '#ECEDEB', borderColor: '#D9DDDA' },
  preventiveCareCompleteButtonTextDisabled: { color: '#9BA49F' },
  preventiveCareLockedHint: { color: '#8B9690', fontSize: 9, textAlign: 'center', marginTop: 6 },
  preventiveCareFixedCycle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.white, borderRadius: 15, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 14, minHeight: 49, marginBottom: 13 },
  preventiveCareFixedCycleLabel: { color: colors.ink, fontSize: 11, fontWeight: '800' },
  preventiveCareFixedCycleValue: { color: colors.green, fontSize: 11, fontWeight: '900' },
  preventiveCareConfirmBox: { marginTop: 9, backgroundColor: '#FFF6EB', borderRadius: 16, borderWidth: 1, borderColor: '#EDCFAE', padding: 13 },
  preventiveCareConfirmText: { color: '#745238', fontSize: 10, lineHeight: 16 },
  preventiveCareConfirmActions: { flexDirection: 'row', gap: 8, marginTop: 11 },
  preventiveCareConfirmCancel: { flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: colors.white, borderWidth: 1, borderColor: '#E7D5C3' },
  preventiveCareConfirmCancelText: { color: colors.muted, fontSize: 11, fontWeight: '800' },
  preventiveCareConfirmSubmit: { flex: 1.4, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: '#C77738' },
  preventiveCareConfirmSubmitText: { color: colors.white, fontSize: 11, fontWeight: '900' },
  formSaveButtonText: { color: colors.white, fontSize: 13, fontWeight: '900' },
  formCancelButton: { minHeight: 43, alignItems: 'center', justifyContent: 'center' },
  formCancelButtonText: { color: colors.muted, fontSize: 11, fontWeight: '700' },
  lockedTimeCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.white, borderRadius: 16, borderWidth: 1, borderColor: colors.line, padding: 13, marginBottom: 15 },
  lockedTimeLabel: { color: colors.muted, fontSize: 9, fontWeight: '700' },
  lockedTimeValue: { color: colors.ink, fontSize: 13, fontWeight: '900', marginTop: 3 },
  lockedTimePill: { backgroundColor: '#EEF0EE', borderRadius: 10, paddingHorizontal: 9, paddingVertical: 6 },
  lockedTimePillText: { color: '#65736C', fontSize: 8, fontWeight: '900' },
  deleteRecordButton: { minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 14, borderWidth: 1, borderColor: '#E7C9C9', backgroundColor: '#FFF5F5', marginBottom: 7 },
  deleteRecordButtonText: { color: '#A64B4B', fontSize: 11, fontWeight: '900' },
  deleteConfirmCard: { backgroundColor: '#FFF2F2', borderRadius: 15, borderWidth: 1, borderColor: '#EBCFCF', padding: 12, marginBottom: 8 },
  deleteConfirmTitle: { color: '#883F3F', fontSize: 12, fontWeight: '900' },
  deleteConfirmText: { color: '#986868', fontSize: 9, marginTop: 3 },
  deleteConfirmActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  deleteCancelButton: { flex: 1, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 11, backgroundColor: colors.white },
  deleteCancelButtonText: { color: colors.muted, fontSize: 10, fontWeight: '800' },
  deleteConfirmButton: { flex: 1, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 11, backgroundColor: '#B45454' },
  deleteConfirmButtonText: { color: colors.white, fontSize: 10, fontWeight: '900' },
  formSectionTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  formSectionTitle: { color: colors.ink, fontSize: 14, fontWeight: '900' },
  avatarEditorCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.white, borderRadius: 18, borderWidth: 1, borderColor: colors.line, padding: 13, marginBottom: 11 },
  avatarEditorPreview: { width: 70, height: 70, borderRadius: 23, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginRight: 13 },
  avatarEditorContent: { flex: 1 },
  avatarEditorTitle: { color: colors.ink, fontSize: 13, lineHeight: 18, fontWeight: '900' },
  avatarEditorHint: { color: colors.muted, fontSize: 9, lineHeight: 14, marginTop: 2 },
  avatarPhotoActions: { flexDirection: 'row', gap: 7, marginTop: 8 },
  avatarPhotoButton: { minHeight: 32, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.mint, borderRadius: 10, paddingHorizontal: 10, borderWidth: 1, borderColor: '#D9EADF' },
  avatarPhotoButtonIcon: { color: colors.green, fontSize: 12, marginRight: 5 },
  avatarPhotoButtonText: { color: colors.green, fontSize: 10, fontWeight: '900' },
  avatarChoiceLabel: { color: colors.ink, fontSize: 11, fontWeight: '800', marginBottom: 7 },
  avatarChoicesScroll: { marginBottom: 14 },
  avatarChoices: { gap: 8, paddingRight: 4 },
  avatarChoice: { width: 60, alignItems: 'center', paddingVertical: 7, borderRadius: 13, borderWidth: 1, borderColor: 'transparent' },
  avatarChoiceSelected: { backgroundColor: colors.mint, borderColor: '#BFD9C8' },
  avatarChoiceIcon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  avatarChoiceEmoji: { fontSize: 20, lineHeight: 25 },
  avatarChoiceText: { color: colors.muted, fontSize: 8, fontWeight: '700' },
  avatarChoiceTextSelected: { color: colors.green, fontWeight: '900' },
  localPill: { backgroundColor: colors.mint, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  localPillText: { color: colors.green, fontSize: 8, fontWeight: '800' },
  segmentRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  segmentButton: { flex: 1, minHeight: 50, borderRadius: 14, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  segmentButtonActive: { backgroundColor: colors.green, borderColor: colors.green },
  segmentText: { color: colors.ink, fontSize: 13, lineHeight: 19, fontWeight: '700', letterSpacing: 0.1 },
  segmentTextActive: { color: colors.white },
  goalSectionTitle: { marginTop: 5, marginBottom: 12 },
  goalInputsRow: { flexDirection: 'row', gap: 10 },
  goalInputCell: { flex: 1 },
  goalHintCard: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: colors.mint, borderRadius: 14, padding: 12, marginBottom: 10 },
  goalHintIcon: { color: colors.green, fontSize: 13, fontWeight: '900', marginRight: 8 },
  goalHintText: { flex: 1, color: '#4D6D5D', fontSize: 9, lineHeight: 15 },
  prototypeNote: { color: '#8C9992', fontSize: 9, lineHeight: 14, textAlign: 'center', marginTop: 16, paddingHorizontal: 18 },
  accountCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.white, borderRadius: 18, borderWidth: 1, borderColor: colors.line, padding: 12, marginBottom: 13 },
  accountIcon: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.mint, marginRight: 10 },
  accountIconText: { color: colors.green, fontSize: 20, fontWeight: '800' },
  accountInfo: { flex: 1, minWidth: 0 },
  accountLabel: { color: colors.muted, fontSize: 8, fontWeight: '800', marginBottom: 3 },
  accountDisplayName: { color: colors.ink, fontSize: 13, fontWeight: '900' },
  accountEmail: { color: colors.muted, fontSize: 9, marginTop: 2 },
  cloudPill: { backgroundColor: colors.mint, borderRadius: 9, paddingHorizontal: 8, paddingVertical: 5, marginLeft: 8 },
  cloudPillText: { color: colors.green, fontSize: 8, fontWeight: '900' },
  accountSettingsEmailCard: { backgroundColor: colors.white, borderRadius: 14, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 14, paddingVertical: 11, marginTop: 16, marginBottom: 4 },
  accountSettingsEmailLabel: { color: colors.muted, fontSize: 8, fontWeight: '800', marginBottom: 4 },
  accountSettingsEmail: { color: colors.ink, fontSize: 11, fontWeight: '700' },
  signOutButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 15, borderWidth: 1, borderColor: '#E4CACA', backgroundColor: '#FFF8F7', marginTop: 14 },
  signOutButtonText: { color: '#A34D47', fontSize: 11, fontWeight: '900' },
  petDataErrorScreen: { flex: 1, width: '100%', maxWidth: layoutTokens.contentMaxWidth, alignSelf: 'center', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
  petDataErrorIcon: { width: 56, height: 56, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF0EF', marginBottom: 16 },
  petDataErrorIconText: { color: '#B64D46', fontSize: 24, fontWeight: '900' },
  petDataErrorTitle: { color: colors.ink, fontSize: 19, fontWeight: '900' },
  petDataErrorText: { color: colors.muted, fontSize: 10, lineHeight: 17, textAlign: 'center', marginTop: 7, marginBottom: 18 },
  petDataRetryButton: { width: '100%', minHeight: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 15, backgroundColor: colors.green },
  petDataRetryButtonText: { color: colors.white, fontSize: 12, fontWeight: '900' },
  petDataSignOutButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, marginTop: 6 },
  petDataSignOutButtonText: { color: colors.muted, fontSize: 10, fontWeight: '800' },
  recentEmptyCard: { alignItems: 'center', justifyContent: 'center', minHeight: 148, backgroundColor: colors.white, borderRadius: 22, borderWidth: 1, borderColor: colors.line, marginBottom: 22, paddingHorizontal: 24 },
  recentEmptyIcon: { color: '#94AA9E', fontSize: 25, marginBottom: 9 },
  recentEmptyTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' },
  recentEmptyText: { color: colors.muted, fontSize: 9, lineHeight: 15, textAlign: 'center', marginTop: 5 },
  petSwitcherSheet: { paddingBottom: 28 },
  petSwitcherRow: { flexDirection: 'row', alignItems: 'center', minHeight: 70, padding: 11, marginTop: 9, borderRadius: 17, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  petSwitcherRowActive: { borderColor: '#7BA58F', backgroundColor: '#EEF6F0' },
  petSwitcherAvatar: { width: 46, height: 46, borderRadius: 15, backgroundColor: '#FFF0D9', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginRight: 12 },
  petSwitcherInfo: { flex: 1 },
  petSwitcherName: { color: colors.ink, fontSize: 15, fontWeight: '900' },
  petSwitcherMeta: { color: colors.muted, fontSize: 9, marginTop: 3 },
  petSwitcherCheck: { color: colors.green, fontSize: 20, fontWeight: '900', paddingHorizontal: 8 },
  petSwitcherAdd: { minHeight: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 15, backgroundColor: colors.green, marginTop: 14 },
  petSwitcherAddText: { color: colors.white, fontSize: 12, fontWeight: '900' },
  invitationGate: { flex: 1, width: '100%', maxWidth: layoutTokens.contentMaxWidth, alignSelf: 'center', justifyContent: 'center', padding: 24 },
  invitationGateIcon: { fontSize: 42, textAlign: 'center', marginBottom: 12 },
  invitationGateTitle: { color: colors.ink, fontSize: 23, fontWeight: '900', textAlign: 'center' },
  invitationGateText: { color: colors.muted, fontSize: 11, lineHeight: 18, textAlign: 'center', marginTop: 7, marginBottom: 20 },
  invitationGateCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 18, padding: 15, marginBottom: 10 },
  invitationGateCardTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' },
  invitationGateCardMeta: { color: colors.muted, fontSize: 9, marginTop: 4 },
  invitationGateAccept: { backgroundColor: colors.green, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, marginLeft: 10 },
  invitationGateAcceptText: { color: colors.white, fontSize: 10, fontWeight: '900' },
  invitationGateSecondary: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: colors.mint, marginTop: 8 },
  invitationGateSecondaryText: { color: colors.greenDark, fontSize: 11, fontWeight: '900' },
  entryFlowSafeArea: { flex: 1, backgroundColor: colors.cream },
  entryFlowContent: { width: '100%', maxWidth: layoutTokens.contentMaxWidth, minHeight: '100%', alignSelf: 'center', paddingHorizontal: 20, paddingTop: 22, paddingBottom: 36 },
  entryFlowNavigation: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.cream, zIndex: 2 },
  entryFlowBack: { minHeight: 34, justifyContent: 'center', paddingRight: 12 },
  entryFlowBackText: { color: colors.green, fontSize: 12, fontWeight: '900' },
  entryFlowStep: { color: '#819088', fontSize: 9, fontWeight: '800' },
  entryFlowProgress: { height: 5, borderRadius: 3, backgroundColor: '#DDE6E0', overflow: 'hidden', marginBottom: 30 },
  entryFlowProgressFill: { width: '100%', height: '100%', borderRadius: 3, backgroundColor: colors.green },
  entryFlowEyebrow: { color: colors.green, fontSize: 10, fontWeight: '900', letterSpacing: 0.7, marginBottom: 7 },
  entryFlowTitle: { color: colors.ink, fontSize: 28, fontWeight: '900', letterSpacing: -0.6 },
  entryFlowSubtitle: { color: colors.muted, fontSize: 11, lineHeight: 18, marginTop: 8, marginBottom: 22 },
  entryChoiceCard: { minHeight: 104, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.white, borderRadius: 22, borderWidth: 1, borderColor: colors.line, padding: 16, marginBottom: 12 },
  entryChoiceIcon: { width: 50, height: 50, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginRight: 13 },
  entryChoiceEmoji: { fontSize: 24 },
  entryChoiceBody: { flex: 1 },
  entryChoiceTitle: { color: colors.ink, fontSize: 14, fontWeight: '900' },
  entryChoiceText: { color: colors.muted, fontSize: 10, lineHeight: 16, marginTop: 5 },
  entryChoiceArrow: { color: colors.green, fontSize: 24, fontWeight: '600', marginLeft: 8 },
  joinInvitationCard: { backgroundColor: '#EDF7F0', borderRadius: 20, borderWidth: 1, borderColor: '#CFE3D5', padding: 15, marginBottom: 12 },
  joinSectionTitle: { color: colors.ink, fontSize: 13, fontWeight: '900', marginBottom: 11 },
  joinInvitationRow: { flexDirection: 'row', alignItems: 'center' },
  joinInvitationInfo: { flex: 1 },
  joinInvitationTitle: { color: colors.ink, fontSize: 11, fontWeight: '900' },
  joinInvitationMeta: { color: colors.muted, fontSize: 9, lineHeight: 14, marginTop: 3 },
  joinInvitationAccept: { minHeight: 38, justifyContent: 'center', backgroundColor: colors.green, borderRadius: 11, paddingHorizontal: 14, marginLeft: 10 },
  joinInvitationAcceptText: { color: colors.white, fontSize: 10, fontWeight: '900' },
  joinMethodCard: { backgroundColor: colors.white, borderRadius: 22, borderWidth: 1, borderColor: colors.line, padding: 17 },
  joinScanButton: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, borderRadius: 15, backgroundColor: colors.green },
  joinScanIcon: { color: colors.white, fontSize: 20, fontWeight: '900' },
  joinScanButtonText: { color: colors.white, fontSize: 12, fontWeight: '900' },
  joinScannerWrap: { height: 280, borderRadius: 18, overflow: 'hidden', backgroundColor: '#102018', position: 'relative' },
  joinScannerGuide: { position: 'absolute', width: 170, height: 170, alignSelf: 'center', top: 45, borderWidth: 3, borderColor: colors.white, borderRadius: 18 },
  joinScannerCancel: { position: 'absolute', bottom: 14, alignSelf: 'center', minHeight: 35, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 12, backgroundColor: 'rgba(15,30,23,0.72)' },
  joinScannerCancelText: { color: colors.white, fontSize: 10, fontWeight: '900' },
  joinDivider: { flexDirection: 'row', alignItems: 'center', gap: 9, marginVertical: 17 },
  joinDividerLine: { flex: 1, height: 1, backgroundColor: colors.line },
  joinDividerText: { color: '#89958F', fontSize: 9, fontWeight: '700' },
  joinCodeInput: { minHeight: 54, borderRadius: 15, borderWidth: 1, borderColor: colors.line, backgroundColor: '#FAFCFA', color: colors.ink, fontSize: 17, fontWeight: '900', letterSpacing: 2.5, textAlign: 'center', paddingHorizontal: 13 },
  joinCodeHint: { color: colors.muted, fontSize: 9, lineHeight: 15, marginTop: 9 },
  joinErrorCard: { backgroundColor: '#FFF0EF', borderRadius: 12, padding: 10, marginTop: 12 },
  joinErrorText: { color: '#9D3D37', fontSize: 10, lineHeight: 16, fontWeight: '700' },
  joinSubmitButton: { minHeight: 52, alignItems: 'center', justifyContent: 'center', borderRadius: 15, backgroundColor: colors.green, marginTop: 15 },
  joinSubmitButtonDisabled: { opacity: 0.65 },
  joinSubmitButtonText: { color: colors.white, fontSize: 12, fontWeight: '900' },
  messagesSheet: { minHeight: 300, paddingBottom: 28 },
  messagesHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 },
  messageEmpty: { alignItems: 'center', justifyContent: 'center', minHeight: 150 },
  messageEmptyIcon: { color: '#91A49A', fontSize: 28 },
  messageEmptyTitle: { color: colors.muted, fontSize: 11, fontWeight: '800', marginTop: 8 },
  messageCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 18, padding: 13, marginBottom: 9 },
  messageIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: colors.mint, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  messageContent: { flex: 1 }, messageTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' }, messageText: { color: colors.muted, fontSize: 9, lineHeight: 14, marginTop: 3 },
  messageAccept: { backgroundColor: colors.green, borderRadius: 11, paddingHorizontal: 11, paddingVertical: 9, marginLeft: 8 }, messageAcceptText: { color: colors.white, fontSize: 9, fontWeight: '900' },
});

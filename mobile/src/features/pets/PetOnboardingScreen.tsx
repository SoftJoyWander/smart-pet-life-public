import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppConfirmDialog } from '../AppConfirmDialog';

export type PetOnboardingValue = {
  name: string;
  breed: string;
  avatarIcon: string;
  sex: '公' | '母' | '未知';
  sterilizationStatus: '已絕育' | '未絕育' | '未知';
  birthday: string;
  weightKg: string;
  mealsPerDay: number;
  waterGoalMl: number;
};

type PetOnboardingScreenProps = {
  isPreview?: boolean;
  progressLabel?: string;
  onCreate: (value: PetOnboardingValue) => Promise<void>;
  onBack?: () => void;
};

const breeds = [
  '米克斯', '柴犬', '柯基犬', '貴賓犬', '比熊犬', '博美犬', '吉娃娃', '臘腸犬',
  '馬爾濟斯', '雪納瑞', '西施犬', '巴哥犬', '蝴蝶犬', '約克夏㹴', '法國鬥牛犬',
  '英國鬥牛犬', '黃金獵犬', '拉布拉多犬', '邊境牧羊犬', '喜樂蒂牧羊犬', '薩摩耶犬',
  '哈士奇', '秋田犬', '澳洲牧羊犬', '其他非禁養犬種',
];

const avatarOptions = ['🐕', '🐶', '🐕‍🦺', '🦮', '🐩'];
const currentYear = new Date().getFullYear();

export function PetOnboardingScreen({ isPreview = false, progressLabel = '步驟 2/2', onCreate, onBack }: PetOnboardingScreenProps) {
  const [name, setName] = useState('');
  const [breed, setBreed] = useState('');
  const [avatarIcon, setAvatarIcon] = useState('🐕');
  const [sex, setSex] = useState<PetOnboardingValue['sex']>('未知');
  const [sterilizationStatus, setSterilizationStatus] = useState<PetOnboardingValue['sterilizationStatus']>('未知');
  const [year, setYear] = useState(currentYear - 3);
  const [month, setMonth] = useState(1);
  const [day, setDay] = useState(1);
  const [weightKg, setWeightKg] = useState('');
  const [mealsPerDay, setMealsPerDay] = useState('2');
  const [waterGoalMl, setWaterGoalMl] = useState('500');
  const [expandedField, setExpandedField] = useState<'breed' | 'sterilization' | 'year' | 'month' | 'day' | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [pendingProfile, setPendingProfile] = useState<PetOnboardingValue | null>(null);

  const daysInSelectedMonth = new Date(year, month, 0).getDate();
  const years = useMemo(() => Array.from({ length: 26 }, (_, index) => currentYear - index), []);
  const months = useMemo(() => Array.from({ length: 12 }, (_, index) => index + 1), []);
  const days = useMemo(
    () => Array.from({ length: daysInSelectedMonth }, (_, index) => index + 1),
    [daysInSelectedMonth],
  );

  const createProfile = async (value: PetOnboardingValue) => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      await onCreate(value);
    } catch (error) {
      setPendingProfile(null);
      setErrorMessage(error instanceof Error ? error.message : '建立失敗，請稍後再試。');
    } finally {
      setIsSaving(false);
    }
  };

  const submit = () => {
    setErrorMessage('');
    const numericWeight = Number(weightKg);
    const numericMeals = Number(mealsPerDay);
    const numericWater = Number(waterGoalMl);
    const birthday = `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, daysInSelectedMonth)).padStart(2, '0')}`;

    if (!name.trim()) return setErrorMessage('請輸入狗狗名字。');
    if (!breed) return setErrorMessage('請選擇狗狗品種。');
    if (!Number.isFinite(numericWeight) || numericWeight <= 0 || numericWeight > 150) return setErrorMessage('請輸入正確的體重。');
    if (!Number.isInteger(numericMeals) || numericMeals < 1 || numericMeals > 10) return setErrorMessage('每日餐數需介於 1 到 10 餐。');
    if (!Number.isInteger(numericWater) || numericWater < 50 || numericWater > 10000) return setErrorMessage('每日飲水目標需介於 50 到 10000 ml。');
    if (new Date(`${birthday}T00:00:00`).getTime() > Date.now()) return setErrorMessage('生日不能晚於今天。');

    const value: PetOnboardingValue = {
      name: name.trim(), breed, avatarIcon, sex, sterilizationStatus, birthday,
      weightKg: numericWeight.toFixed(1), mealsPerDay: numericMeals, waterGoalMl: numericWater,
    };
    setPendingProfile(value);
  };

  return (
    <>
      <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.safeArea}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.keyboardView}>
          <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} stickyHeaderIndices={onBack ? [0] : undefined}>
          {onBack ? (
            <View style={styles.navigationRow}>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="返回上一步" style={styles.backButton} onPress={onBack}>
                <Text style={styles.backButtonText}>‹ 上一步</Text>
              </TouchableOpacity>
              <Text style={styles.navigationStep}>{progressLabel}</Text>
            </View>
          ) : null}
          <View style={styles.progressRow}>
            <View style={styles.brandMark}><Text style={styles.brandMarkText}>🐾</Text></View>
            <View style={styles.progressTrack}><View style={styles.progressFill} /></View>
            <Text style={styles.progressText}>帳號完成</Text>
          </View>

          <Text style={styles.eyebrow}>歡迎加入 Smart Pet Life</Text>
          <Text style={styles.title}>先建立狗狗資料</Text>
          <Text style={styles.subtitle}>照護紀錄都會綁定特定寵物，完成這一步後才能開始使用 App。</Text>

          {isPreview ? (
            <View style={styles.previewNotice}>
              <Text style={styles.previewNoticeText}>開發測試模式：這次建立的資料不會上傳雲端。</Text>
            </View>
          ) : null}

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>選擇頭像</Text>
            <View style={styles.avatarRow}>
              {avatarOptions.map((icon) => (
                <TouchableOpacity
                  accessibilityLabel={`選擇 ${icon} 頭像`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: icon === avatarIcon }}
                  key={icon}
                  onPress={() => setAvatarIcon(icon)}
                  style={[styles.avatarButton, icon === avatarIcon && styles.avatarButtonActive]}
                >
                  <Text style={styles.avatarEmoji}>{icon}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <FieldLabel text="狗狗名字" />
            <TextInput
              accessibilityLabel="狗狗名字"
              maxLength={40}
              onChangeText={setName}
              placeholder="例如：麻糬"
              placeholderTextColor="#9AA7A0"
              style={styles.input}
              value={name}
            />

            <FieldLabel text="品種" />
            <DropdownButton label="品種" value={breed || '請選擇品種'} expanded={expandedField === 'breed'} onPress={() => setExpandedField(expandedField === 'breed' ? null : 'breed')} placeholder={!breed} />
            {expandedField === 'breed' ? (
              <OptionPanel>
                {breeds.map((option) => <Option key={option} label={option} selected={breed === option} onPress={() => { setBreed(option); setExpandedField(null); }} />)}
              </OptionPanel>
            ) : null}

            <FieldLabel text="性別" />
            <View style={styles.segmentRow}>
              {(['公', '母', '未知'] as const).map((option) => (
                <TouchableOpacity key={option} onPress={() => setSex(option)} style={[styles.segmentButton, sex === option && styles.segmentButtonActive]}>
                  <Text style={[styles.segmentText, sex === option && styles.segmentTextActive]}>{option}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <FieldLabel text="絕育狀態" />
            <DropdownButton label="絕育狀態" value={sterilizationStatus} expanded={expandedField === 'sterilization'} onPress={() => setExpandedField(expandedField === 'sterilization' ? null : 'sterilization')} />
            {expandedField === 'sterilization' ? (
              <OptionPanel>
                {(['已絕育', '未絕育', '未知'] as const).map((option) => <Option key={option} label={option} selected={sterilizationStatus === option} onPress={() => { setSterilizationStatus(option); setExpandedField(null); }} />)}
              </OptionPanel>
            ) : null}

            <FieldLabel text="生日" />
            <View style={styles.dateRow}>
              <DateSelect label="年份" value={`${year} 年`} expanded={expandedField === 'year'} onPress={() => setExpandedField(expandedField === 'year' ? null : 'year')} />
              <DateSelect label="月份" value={`${month} 月`} expanded={expandedField === 'month'} onPress={() => setExpandedField(expandedField === 'month' ? null : 'month')} />
              <DateSelect label="日期" value={`${Math.min(day, daysInSelectedMonth)} 日`} expanded={expandedField === 'day'} onPress={() => setExpandedField(expandedField === 'day' ? null : 'day')} />
            </View>
            {expandedField === 'year' ? <NumberOptions values={years} selected={year} suffix="年" onSelect={(value) => { setYear(value); setExpandedField(null); }} /> : null}
            {expandedField === 'month' ? <NumberOptions values={months} selected={month} suffix="月" onSelect={(value) => { setMonth(value); setExpandedField(null); }} /> : null}
            {expandedField === 'day' ? <NumberOptions values={days} selected={Math.min(day, daysInSelectedMonth)} suffix="日" onSelect={(value) => { setDay(value); setExpandedField(null); }} /> : null}

            <View style={styles.twoColumnRow}>
              <View style={styles.column}>
                <FieldLabel text="體重（kg）" />
                <TextInput accessibilityLabel="體重" keyboardType="decimal-pad" onChangeText={(value) => setWeightKg(value.replace(/[^0-9.]/g, ''))} placeholder="10.5" placeholderTextColor="#9AA7A0" style={styles.input} value={weightKg} />
              </View>
              <View style={styles.column}>
                <FieldLabel text="每日餐數" />
                <TextInput accessibilityLabel="每日餐數" keyboardType="number-pad" onChangeText={(value) => setMealsPerDay(value.replace(/[^0-9]/g, ''))} placeholder="2" placeholderTextColor="#9AA7A0" style={styles.input} value={mealsPerDay} />
              </View>
            </View>

            <FieldLabel text="每日飲水目標（ml）" />
            <TextInput accessibilityLabel="每日飲水目標" keyboardType="number-pad" onChangeText={(value) => setWaterGoalMl(value.replace(/[^0-9]/g, ''))} placeholder="500" placeholderTextColor="#9AA7A0" style={styles.input} value={waterGoalMl} />

            {errorMessage ? <View accessibilityRole="alert" style={styles.errorCard}><Text style={styles.errorText}>{errorMessage}</Text></View> : null}

            <TouchableOpacity accessibilityRole="button" disabled={isSaving} onPress={submit} style={[styles.submitButton, isSaving && styles.submitButtonDisabled]}>
              {isSaving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.submitButtonText}>建立狗狗資料並開始使用</Text>}
            </TouchableOpacity>
          </View>

          <Text style={styles.lockNote}>此步驟無法略過。下次登入若仍沒有寵物資料，會再次回到這裡。</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
      <AppConfirmDialog
        visible={pendingProfile !== null}
        title="請確認生日"
        message={pendingProfile ? `${pendingProfile.name} 的生日為 ${year} 年 ${month} 月 ${Math.min(day, daysInSelectedMonth)} 日。建立後無法在 App 內修改，請確認資料正確。` : ''}
        icon="🐾"
        confirmLabel="確認並建立"
        cancelLabel="返回修改"
        loading={isSaving}
        loadingLabel="建立中…"
        dismissOnBackdropPress={false}
        onCancel={() => setPendingProfile(null)}
        onConfirm={() => { if (pendingProfile) void createProfile(pendingProfile); }}
      />
    </>
  );
}

function FieldLabel({ text }: { text: string }) {
  return <Text style={styles.fieldLabel}>{text}</Text>;
}

function DropdownButton({ label, value, expanded, onPress, placeholder = false }: { label: string; value: string; expanded: boolean; onPress: () => void; placeholder?: boolean }) {
  return (
    <TouchableOpacity accessibilityLabel={`${label}：${value}`} accessibilityRole="button" accessibilityState={{ expanded }} onPress={onPress} style={[styles.dropdownButton, expanded && styles.dropdownButtonActive]}>
      <Text style={[styles.dropdownValue, placeholder && styles.placeholder]}>{value}</Text>
      <Text style={styles.chevron}>{expanded ? '⌃' : '⌄'}</Text>
    </TouchableOpacity>
  );
}

function OptionPanel({ children }: { children: React.ReactNode }) {
  return <ScrollView nestedScrollEnabled style={styles.optionPanel}>{children}</ScrollView>;
}

function Option({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={[styles.option, selected && styles.optionSelected]}>
      <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{label}</Text>
      {selected ? <Text style={styles.optionCheck}>✓</Text> : null}
    </TouchableOpacity>
  );
}

function DateSelect({ label, value, expanded, onPress }: { label: string; value: string; expanded: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity accessibilityLabel={`${label}：${value}`} accessibilityRole="button" accessibilityState={{ expanded }} onPress={onPress} style={[styles.dateSelect, expanded && styles.dateSelectActive]}>
      <Text style={styles.dateSelectLabel}>{label}</Text>
      <Text style={[styles.dateSelectValue, expanded && styles.dateSelectValueActive]}>{value}</Text>
    </TouchableOpacity>
  );
}

function NumberOptions({ values, selected, suffix, onSelect }: { values: number[]; selected: number; suffix: string; onSelect: (value: number) => void }) {
  return (
    <ScrollView nestedScrollEnabled style={styles.numberPanel}>
      <View style={styles.numberGrid}>
        {values.map((value) => (
          <TouchableOpacity key={value} onPress={() => onSelect(value)} style={[styles.numberOption, value === selected && styles.numberOptionActive]}>
            <Text style={[styles.numberOptionText, value === selected && styles.numberOptionTextActive]}>{value} {suffix}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

const colors = { ink: '#19352B', muted: '#6C7E76', green: '#2D6A4F', greenDark: '#1F513C', mint: '#E8F4EC', cream: '#F7F6F0', white: '#FFFFFF', line: '#E2E8E3' };

const styles = StyleSheet.create({
  navigationRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.cream, zIndex: 2 },
  backButton: { minHeight: 34, justifyContent: 'center', paddingRight: 12 },
  backButtonText: { color: '#2D6A4F', fontSize: 12, fontWeight: '900' },
  navigationStep: { color: '#819088', fontSize: 9, fontWeight: '800' },
  safeArea: { flex: 1, backgroundColor: colors.cream },
  keyboardView: { flex: 1 },
  scrollContent: { width: '100%', maxWidth: 520, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 22, paddingBottom: 36 },
  progressRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 28 },
  brandMark: { width: 42, height: 42, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.green },
  brandMarkText: { fontSize: 20 },
  progressTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: '#DDE6E0', marginHorizontal: 12, overflow: 'hidden' },
  progressFill: { width: '100%', height: '100%', backgroundColor: colors.green },
  progressText: { color: colors.muted, fontSize: 9, fontWeight: '800' },
  eyebrow: { color: colors.green, fontSize: 10, fontWeight: '900', letterSpacing: 0.7, marginBottom: 7 },
  title: { color: colors.ink, fontSize: 28, fontWeight: '900', letterSpacing: -0.6 },
  subtitle: { color: colors.muted, fontSize: 11, lineHeight: 18, marginTop: 7, marginBottom: 18 },
  previewNotice: { backgroundColor: '#FFF3D9', borderRadius: 13, padding: 11, marginBottom: 13, borderWidth: 1, borderColor: '#F0DBAA' },
  previewNoticeText: { color: '#8A651F', fontSize: 9, lineHeight: 15, fontWeight: '700' },
  card: { backgroundColor: colors.white, borderRadius: 24, borderWidth: 1, borderColor: colors.line, padding: 18 },
  sectionTitle: { color: colors.ink, fontSize: 12, fontWeight: '900', marginBottom: 10 },
  avatarRow: { flexDirection: 'row', gap: 8, marginBottom: 19 },
  avatarButton: { flex: 1, minHeight: 53, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: '#F5F6F3', borderWidth: 1, borderColor: 'transparent' },
  avatarButtonActive: { backgroundColor: colors.mint, borderColor: '#9FC4AC' },
  avatarEmoji: { fontSize: 24 },
  fieldLabel: { color: colors.ink, fontSize: 10, fontWeight: '900', marginBottom: 7, marginTop: 2 },
  input: { minHeight: 50, borderRadius: 15, borderWidth: 1, borderColor: colors.line, backgroundColor: '#FCFDFC', color: colors.ink, fontSize: 13, fontWeight: '700', paddingHorizontal: 13, marginBottom: 14 },
  dropdownButton: { minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: 15, borderWidth: 1, borderColor: colors.line, backgroundColor: '#FCFDFC', paddingHorizontal: 13, marginBottom: 14 },
  dropdownButtonActive: { borderColor: '#8EB69C', marginBottom: 6 },
  dropdownValue: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  placeholder: { color: '#9AA7A0', fontWeight: '600' },
  chevron: { color: colors.green, fontSize: 14, fontWeight: '900' },
  optionPanel: { maxHeight: 210, borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, marginBottom: 14 },
  option: { minHeight: 43, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 13, borderBottomWidth: 1, borderBottomColor: '#EEF1EE' },
  optionSelected: { backgroundColor: colors.mint },
  optionText: { color: colors.ink, fontSize: 11, fontWeight: '700' },
  optionTextSelected: { color: colors.green, fontWeight: '900' },
  optionCheck: { color: colors.green, fontWeight: '900' },
  segmentRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  segmentButton: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: '#FCFDFC' },
  segmentButtonActive: { backgroundColor: colors.green, borderColor: colors.green },
  segmentText: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  segmentTextActive: { color: colors.white },
  dateRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  dateSelect: { flex: 1, minHeight: 57, justifyContent: 'center', borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: '#F7FAF8', paddingHorizontal: 10 },
  dateSelectActive: { backgroundColor: colors.green, borderColor: colors.green },
  dateSelectLabel: { color: '#809087', fontSize: 8, fontWeight: '800', marginBottom: 3 },
  dateSelectValue: { color: colors.ink, fontSize: 12, fontWeight: '900' },
  dateSelectValueActive: { color: colors.white },
  numberPanel: { maxHeight: 180, borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: '#F8FAF8', marginBottom: 14 },
  numberGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, padding: 9 },
  numberOption: { width: '31.5%', minHeight: 37, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: colors.white },
  numberOptionActive: { backgroundColor: colors.green },
  numberOptionText: { color: colors.ink, fontSize: 10, fontWeight: '800' },
  numberOptionTextActive: { color: colors.white },
  twoColumnRow: { flexDirection: 'row', gap: 10 },
  column: { flex: 1 },
  errorCard: { backgroundColor: '#FFF0EF', borderRadius: 12, padding: 10, marginBottom: 12 },
  errorText: { color: '#9D3D37', fontSize: 10, lineHeight: 16, fontWeight: '700' },
  submitButton: { minHeight: 54, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: colors.green, marginTop: 2 },
  submitButtonDisabled: { opacity: 0.65 },
  submitButtonText: { color: colors.white, fontSize: 13, fontWeight: '900' },
  lockNote: { color: '#819088', fontSize: 9, lineHeight: 15, textAlign: 'center', paddingHorizontal: 20, marginTop: 15 },
});

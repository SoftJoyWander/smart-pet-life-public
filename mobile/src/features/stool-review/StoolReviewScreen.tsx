import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  claimNextStoolReview,
  submitStoolHumanReview,
  type StoolReviewItem,
} from '../../services/stoolAnalysis';

type ReviewLabel = 'present' | 'absent' | 'not_assessable';

type StoolReviewScreenProps = {
  onClose: () => void;
};

const labelOptions: Array<{ value: ReviewLabel; title: string; detail: string }> = [
  { value: 'present', title: '有便便', detail: '照片中可清楚看到一處或多處便便' },
  { value: 'absent', title: '沒有便便', detail: '照片可判讀，但沒有看到便便' },
  { value: 'not_assessable', title: '無法判斷', detail: '模糊、太暗、遮擋或內容不完整' },
];

export function StoolReviewScreen({ onClose }: StoolReviewScreenProps) {
  const [review, setReview] = useState<StoolReviewItem | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'empty' | 'error' | 'submitting'>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [note, setNote] = useState('');
  const [reviewedCount, setReviewedCount] = useState(0);

  const loadNext = useCallback(async () => {
    setPhase('loading');
    setErrorMessage('');
    setNote('');
    try {
      const next = await claimNextStoolReview();
      setReview(next);
      setPhase(next ? 'ready' : 'empty');
    } catch (error) {
      setReview(null);
      setErrorMessage(error instanceof Error ? error.message : '目前無法載入人工審核工作。');
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    void loadNext();
  }, [loadNext]);

  const submit = async (label: ReviewLabel) => {
    if (!review || phase === 'submitting') return;
    setPhase('submitting');
    setErrorMessage('');
    try {
      await submitStoolHumanReview({ observationId: review.observationId, label, note });
      setReviewedCount((current) => current + 1);
      await loadNext();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '人工審核送出失敗。');
      setPhase('ready');
    }
  };

  return (
    <View testID="stool-review-screen" style={styles.screen}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="返回我的足跡"
          hitSlop={8}
          onPress={onClose}
          style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        >
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>REVIEWER ONLY</Text>
          <Text style={styles.title}>便便 AI 人工審核</Text>
        </View>
        <View style={styles.countPill}>
          <Text style={styles.countText}>已審 {reviewedCount}</Text>
        </View>
      </View>

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.blindNotice}>
          <Text style={styles.blindNoticeTitle}>盲審模式</Text>
          <Text style={styles.blindNoticeText}>提交前不顯示模型答案或分數；人工標籤會獨立保存，不會覆寫模型輸出。</Text>
        </View>

        {phase === 'loading' ? (
          <View style={styles.stateCard}>
            <ActivityIndicator color="#2D6A4F" size="large" />
            <Text style={styles.stateTitle}>正在領取下一張照片</Text>
          </View>
        ) : null}

        {phase === 'empty' ? (
          <View style={styles.stateCard}>
            <Text style={styles.stateIcon}>✓</Text>
            <Text style={styles.stateTitle}>目前沒有待審照片</Text>
            <Text style={styles.stateText}>新的 App 實驗照片完成模型辨識後，會自動出現在這裡。</Text>
            <Pressable accessibilityRole="button" onPress={() => void loadNext()} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>重新整理</Text>
            </Pressable>
          </View>
        ) : null}

        {phase === 'error' ? (
          <View style={styles.stateCard}>
            <Text selectable style={styles.errorText}>{errorMessage}</Text>
            <Pressable accessibilityRole="button" onPress={() => void loadNext()} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>重試</Text>
            </Pressable>
          </View>
        ) : null}

        {review && (phase === 'ready' || phase === 'submitting') ? (
          <>
            <View style={styles.imageCard}>
              <Image
                accessibilityLabel="待人工審核的便便辨識照片"
                resizeMode="contain"
                source={{ uri: review.signedImageUrl }}
                style={styles.reviewImage}
              />
            </View>

            <View style={styles.metadataCard}>
              <Text selectable style={styles.metadataText}>
                來源：{review.captureMethod === 'gallery_upload' ? '相簿上傳' : '即時拍攝'}
              </Text>
              <Text selectable style={styles.metadataText}>拍攝時間：{new Date(review.capturedAt).toLocaleString()}</Text>
              <Text selectable numberOfLines={1} style={styles.metadataText}>工作編號：{review.observationId}</Text>
            </View>

            <View style={styles.formCard}>
              <Text style={styles.sectionTitle}>照片中是否有便便？</Text>
              <Text style={styles.sectionHint}>只判斷可見物體，不判斷健康狀態或疾病。</Text>
              <TextInput
                accessibilityLabel="人工審核備註"
                editable={phase !== 'submitting'}
                maxLength={500}
                multiline
                onChangeText={setNote}
                placeholder="備註（選填，例如：影像太暗或疑似泥土）"
                placeholderTextColor="#829087"
                style={styles.noteInput}
                textAlignVertical="top"
                value={note}
              />

              <View style={styles.actions}>
                {labelOptions.map((option) => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={option.title}
                    disabled={phase === 'submitting'}
                    key={option.value}
                    onPress={() => void submit(option.value)}
                    style={({ pressed }) => [
                      styles.reviewAction,
                      option.value === 'present' && styles.presentAction,
                      option.value === 'absent' && styles.absentAction,
                      option.value === 'not_assessable' && styles.unknownAction,
                      pressed && styles.pressed,
                      phase === 'submitting' && styles.disabled,
                    ]}
                  >
                    <View style={styles.actionCopy}>
                      <Text style={styles.actionTitle}>{option.title}</Text>
                      <Text style={styles.actionDetail}>{option.detail}</Text>
                    </View>
                    <Text style={styles.actionArrow}>›</Text>
                  </Pressable>
                ))}
              </View>

              {phase === 'submitting' ? (
                <View style={styles.submittingRow}>
                  <ActivityIndicator color="#2D6A4F" />
                  <Text style={styles.submittingText}>正在保存人工答案…</Text>
                </View>
              ) : null}
              {errorMessage ? <Text selectable style={styles.errorText}>{errorMessage}</Text> : null}
            </View>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F7F4ED' },
  header: { minHeight: 76, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 12, borderBottomWidth: 1, borderBottomColor: '#E2E5DF', backgroundColor: '#FFFDF8' },
  backButton: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EDF3EF' },
  backText: { color: '#275B46', fontSize: 34, lineHeight: 38, fontWeight: '600' },
  headerCopy: { flex: 1, minWidth: 0 },
  eyebrow: { color: '#648071', fontSize: 9, lineHeight: 13, fontWeight: '900', letterSpacing: 1.2 },
  title: { color: '#173C2D', fontSize: 20, lineHeight: 28, fontWeight: '900' },
  countPill: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 10, borderRadius: 16, backgroundColor: '#E8F2EC' },
  countText: { color: '#2D6A4F', fontSize: 11, fontWeight: '800', fontVariant: ['tabular-nums'] },
  content: { padding: 16, paddingBottom: 36, gap: 14 },
  blindNotice: { padding: 14, borderRadius: 18, borderWidth: 1, borderColor: '#C9DDD1', backgroundColor: '#EFF7F2' },
  blindNoticeTitle: { color: '#275B46', fontSize: 13, fontWeight: '900' },
  blindNoticeText: { color: '#587065', fontSize: 11, lineHeight: 18, marginTop: 4 },
  stateCard: { minHeight: 230, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 22, borderRadius: 22, borderWidth: 1, borderColor: '#E0E3DD', backgroundColor: '#FFF' },
  stateIcon: { color: '#2D6A4F', fontSize: 38, fontWeight: '900' },
  stateTitle: { color: '#173C2D', fontSize: 17, fontWeight: '900', textAlign: 'center' },
  stateText: { color: '#66766E', fontSize: 12, lineHeight: 19, textAlign: 'center' },
  imageCard: { overflow: 'hidden', borderRadius: 22, borderWidth: 1, borderColor: '#DDE2DC', backgroundColor: '#18201C' },
  reviewImage: { width: '100%', height: 330, backgroundColor: '#18201C' },
  metadataCard: { gap: 5, padding: 13, borderRadius: 16, backgroundColor: '#F0EEE8' },
  metadataText: { color: '#5F6F67', fontSize: 10, lineHeight: 16 },
  formCard: { padding: 16, borderRadius: 22, borderWidth: 1, borderColor: '#E0E3DD', backgroundColor: '#FFF' },
  sectionTitle: { color: '#173C2D', fontSize: 18, lineHeight: 25, fontWeight: '900' },
  sectionHint: { color: '#66766E', fontSize: 11, lineHeight: 18, marginTop: 4 },
  noteInput: { minHeight: 88, marginTop: 14, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: '#D8DED8', color: '#173C2D', backgroundColor: '#FBFCFA', fontSize: 12, lineHeight: 18 },
  actions: { gap: 10, marginTop: 14 },
  reviewAction: { minHeight: 68, flexDirection: 'row', alignItems: 'center', padding: 13, borderRadius: 17, borderWidth: 1 },
  presentAction: { borderColor: '#A9D0B9', backgroundColor: '#EDF8F1' },
  absentAction: { borderColor: '#BFCFDB', backgroundColor: '#EFF5F8' },
  unknownAction: { borderColor: '#D6CCB3', backgroundColor: '#F8F4E9' },
  actionCopy: { flex: 1 },
  actionTitle: { color: '#173C2D', fontSize: 14, fontWeight: '900' },
  actionDetail: { color: '#66766E', fontSize: 10, lineHeight: 16, marginTop: 3 },
  actionArrow: { color: '#2D6A4F', fontSize: 25, fontWeight: '600' },
  primaryButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, borderRadius: 15, backgroundColor: '#2D6A4F' },
  primaryButtonText: { color: '#FFF', fontSize: 12, fontWeight: '900' },
  submittingRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, marginTop: 12 },
  submittingText: { color: '#2D6A4F', fontSize: 11, fontWeight: '800' },
  errorText: { color: '#A1473D', fontSize: 11, lineHeight: 18, textAlign: 'center', marginTop: 10 },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
});

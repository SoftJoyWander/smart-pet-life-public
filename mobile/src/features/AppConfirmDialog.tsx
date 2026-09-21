import { useEffect, useRef } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { layoutTokens } from '../lib/layout';

export type AppConfirmDialogTone = 'brand' | 'warning' | 'danger';

type AppConfirmDialogProps = {
  visible: boolean;
  title: string;
  message: string;
  icon?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  loadingLabel?: string;
  tone?: AppConfirmDialogTone;
  loading?: boolean;
  dismissOnBackdropPress?: boolean;
  testID?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function AppConfirmDialog({
  visible,
  title,
  message,
  icon = '✓',
  confirmLabel = '確認',
  cancelLabel = '取消',
  loadingLabel = '處理中…',
  tone = 'brand',
  loading = false,
  dismissOnBackdropPress = true,
  testID,
  onConfirm,
  onCancel,
}: AppConfirmDialogProps) {
  const confirmLockRef = useRef(false);
  const wasLoadingRef = useRef(false);

  useEffect(() => {
    if (!visible || (wasLoadingRef.current && !loading)) {
      confirmLockRef.current = false;
    }
    wasLoadingRef.current = loading;
  }, [loading, visible]);

  const close = () => {
    if (!loading) onCancel();
  };
  const confirm = () => {
    if (loading || confirmLockRef.current) return;
    confirmLockRef.current = true;
    onConfirm();
  };
  const selectedTone = toneStyles[tone];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      presentationStyle="overFullScreen"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={close}
    >
      <SafeAreaView style={styles.backdrop} edges={['top', 'bottom', 'left', 'right']}>
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={StyleSheet.absoluteFill}
          disabled={loading || !dismissOnBackdropPress}
          onPress={close}
        />
        <View
          accessibilityViewIsModal
          accessibilityRole="alert"
          accessibilityLabel={`${title}。${message}`}
          style={styles.dialog}
          testID={testID}
        >
          <View style={[styles.icon, selectedTone.icon]}>
            <Text accessibilityElementsHidden style={styles.iconText}>{icon}</Text>
          </View>
          <Text style={styles.title}>{title}</Text>
          <ScrollView
            bounces={false}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.messageWrap}
          >
            <Text style={styles.message}>{message}</Text>
          </ScrollView>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={cancelLabel}
              disabled={loading}
              style={({ pressed }) => [styles.button, styles.cancelButton, pressed && !loading && styles.buttonPressed]}
              onPress={close}
            >
              <Text style={styles.cancelText}>{cancelLabel}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={loading ? loadingLabel : confirmLabel}
              accessibilityState={{ disabled: loading, busy: loading }}
              disabled={loading}
              style={({ pressed }) => [styles.button, styles.confirmButton, selectedTone.confirm, pressed && !loading && styles.buttonPressed, loading && styles.buttonDisabled]}
              onPress={confirm}
            >
              <Text style={styles.confirmText}>{loading ? loadingLabel : confirmLabel}</Text>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(15, 30, 23, 0.56)',
    padding: 24,
  },
  dialog: {
    width: '100%',
    maxWidth: layoutTokens.dialogMaxWidth,
    maxHeight: '88%',
    alignItems: 'center',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#E2E7E3',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 18,
    shadowColor: '#10271E',
    shadowOpacity: 0.22,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 16,
  },
  icon: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
  },
  iconBrand: { backgroundColor: '#E7F2EC' },
  iconWarning: { backgroundColor: '#FFF0DF' },
  iconDanger: { backgroundColor: '#FCE9E6' },
  iconText: { color: '#244E3E', fontSize: 24 },
  title: {
    color: '#19352B',
    fontSize: 20,
    lineHeight: 27,
    fontWeight: '900',
    textAlign: 'center',
    marginTop: 14,
  },
  messageWrap: { paddingTop: 8, paddingBottom: 2 },
  message: {
    color: '#66776F',
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  actions: {
    width: '100%',
    flexDirection: 'row',
    gap: 10,
    marginTop: 20,
  },
  button: {
    flex: 1,
    minHeight: layoutTokens.minimumTouchSize,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    paddingHorizontal: 12,
  },
  cancelButton: {
    borderWidth: 1,
    borderColor: '#D8DEDA',
    backgroundColor: '#FFFFFF',
  },
  confirmButton: { backgroundColor: '#2D6A4F' },
  confirmBrand: { backgroundColor: '#2D6A4F' },
  confirmWarning: { backgroundColor: '#A9632E' },
  confirmDanger: { backgroundColor: '#B65348' },
  cancelText: { color: '#52645C', fontSize: 13, fontWeight: '900' },
  confirmText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
  buttonPressed: { opacity: 0.78 },
  buttonDisabled: { opacity: 0.58 },
});

const toneStyles = {
  brand: {
    icon: styles.iconBrand,
    confirm: styles.confirmBrand,
  },
  warning: {
    icon: styles.iconWarning,
    confirm: styles.confirmWarning,
  },
  danger: {
    icon: styles.iconDanger,
    confirm: styles.confirmDanger,
  },
} as const;

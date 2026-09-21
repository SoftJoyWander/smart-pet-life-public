import type { Session } from '@supabase/supabase-js';
import { useState } from 'react';
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

import { isSupabaseConfigured, requireSupabase } from '../../lib/supabase';

type AuthMode = 'signIn' | 'signUp';

type AuthScreenProps = {
  onAuthenticated: (session: Session) => void;
  onPreview?: () => void;
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AuthScreen({ onAuthenticated, onPreview }: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>('signIn');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [noticeMessage, setNoticeMessage] = useState('');

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setErrorMessage('');
    setNoticeMessage('');
    setPassword('');
    setConfirmPassword('');
  };

  const validate = () => {
    if (mode === 'signUp' && !displayName.trim()) return '請輸入你的暱稱。';
    if (!emailPattern.test(email.trim())) return '請輸入正確的 Email 格式。';
    if (password.length < 8) return '密碼至少需要 8 個字元。';
    if (mode === 'signUp' && password !== confirmPassword) return '兩次輸入的密碼不一致。';
    return null;
  };

  const submit = async () => {
    setErrorMessage('');
    setNoticeMessage('');

    if (!isSupabaseConfigured) {
      setErrorMessage('尚未連接 Supabase，請先完成 mobile/.env 設定。');
      return;
    }

    const validationError = validate();
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    setIsSubmitting(true);
    try {
      const client = requireSupabase();
      const normalizedEmail = email.trim().toLowerCase();

      if (mode === 'signIn') {
        const { data, error } = await client.auth.signInWithPassword({ email: normalizedEmail, password });
        if (error) throw error;
        if (!data.session) throw new Error('登入未完成，請稍後再試。');
        onAuthenticated(data.session);
        return;
      }

      const { data, error } = await client.auth.signUp({
        email: normalizedEmail,
        password,
        options: { data: { display_name: displayName.trim() } },
      });
      if (error) throw error;

      if (data.session) {
        onAuthenticated(data.session);
      } else {
        setNoticeMessage(`驗證信已寄到 ${normalizedEmail}，請完成驗證後再登入。`);
        setMode('signIn');
        setPassword('');
        setConfirmPassword('');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '操作失敗，請稍後再試。';
      setErrorMessage(toFriendlyAuthMessage(message));
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetPassword = async () => {
    setErrorMessage('');
    setNoticeMessage('');
    if (!emailPattern.test(email.trim())) {
      setErrorMessage('先輸入註冊時使用的 Email，才能寄送重設信。');
      return;
    }
    if (!isSupabaseConfigured) {
      setErrorMessage('尚未連接 Supabase。');
      return;
    }

    setIsSubmitting(true);
    try {
      const { error } = await requireSupabase().auth.resetPasswordForEmail(email.trim().toLowerCase());
      if (error) throw error;
      setNoticeMessage('密碼重設信已寄出，請到信箱查看。');
    } catch (error) {
      const message = error instanceof Error ? error.message : '無法寄送重設信。';
      setErrorMessage(toFriendlyAuthMessage(message));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.safeArea}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.keyboardView}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.hero}>
            <View style={styles.logoWrap}><Text style={styles.logoPaw}>🐾</Text></View>
            <Text style={styles.brand}>Smart Pet Life</Text>
            <Text style={styles.tagline}>每一份日常照護，都值得被好好記住</Text>
          </View>

          <View style={styles.authCard}>
            <View style={styles.modeTabs}>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityState={{ selected: mode === 'signIn' }}
                style={[styles.modeTab, mode === 'signIn' && styles.modeTabActive]}
                onPress={() => switchMode('signIn')}
              >
                <Text style={[styles.modeTabText, mode === 'signIn' && styles.modeTabTextActive]}>登入</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityState={{ selected: mode === 'signUp' }}
                style={[styles.modeTab, mode === 'signUp' && styles.modeTabActive]}
                onPress={() => switchMode('signUp')}
              >
                <Text style={[styles.modeTabText, mode === 'signUp' && styles.modeTabTextActive]}>註冊</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.cardTitle}>{mode === 'signIn' ? '歡迎回來' : '建立飼主帳號'}</Text>
            <Text style={styles.cardSubtitle}>
              {mode === 'signIn' ? '登入後繼續查看寵物的生活紀錄' : '開始為你的毛孩建立完整照護日誌'}
            </Text>

            {mode === 'signUp' ? (
              <AuthInput
                label="你的暱稱"
                value={displayName}
                placeholder="例如：麻糬爸"
                onChangeText={setDisplayName}
                textContentType="name"
              />
            ) : null}

            <AuthInput
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              label="Email"
              value={email}
              placeholder="name@example.com"
              onChangeText={setEmail}
              textContentType="emailAddress"
            />

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>密碼</Text>
              <View style={styles.passwordControl}>
                <TextInput
                  accessibilityLabel="密碼"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!isSubmitting}
                  onChangeText={setPassword}
                  placeholder="至少 8 個字元"
                  placeholderTextColor="#9AA7A0"
                  secureTextEntry={!showPassword}
                  style={styles.passwordInput}
                  textContentType={mode === 'signIn' ? 'password' : 'newPassword'}
                  value={password}
                />
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? '隱藏密碼' : '顯示密碼'}
                  onPress={() => setShowPassword((current) => !current)}
                  style={styles.passwordToggle}
                >
                  <Text style={styles.passwordToggleText}>{showPassword ? '隱藏' : '顯示'}</Text>
                </TouchableOpacity>
              </View>
            </View>

            {mode === 'signUp' ? (
              <AuthInput
                autoCapitalize="none"
                autoCorrect={false}
                label="確認密碼"
                value={confirmPassword}
                placeholder="再次輸入密碼"
                onChangeText={setConfirmPassword}
                secureTextEntry={!showPassword}
                textContentType="newPassword"
              />
            ) : (
              <TouchableOpacity accessibilityRole="button" onPress={resetPassword} style={styles.forgotButton}>
                <Text style={styles.forgotText}>忘記密碼？</Text>
              </TouchableOpacity>
            )}

            {errorMessage ? (
              <View accessibilityRole="alert" style={styles.errorBanner}>
                <Text style={styles.errorIcon}>!</Text>
                <Text style={styles.errorText}>{errorMessage}</Text>
              </View>
            ) : null}

            {noticeMessage ? (
              <View style={styles.noticeBanner}>
                <Text style={styles.noticeIcon}>✓</Text>
                <Text style={styles.noticeText}>{noticeMessage}</Text>
              </View>
            ) : null}

            <TouchableOpacity
              accessibilityRole="button"
              disabled={isSubmitting}
              onPress={submit}
              style={[styles.submitButton, isSubmitting && styles.submitButtonDisabled]}
            >
              {isSubmitting ? <ActivityIndicator color="#FFFFFF" /> : (
                <Text style={styles.submitButtonText}>{mode === 'signIn' ? '登入' : '建立帳號'}</Text>
              )}
            </TouchableOpacity>

            {mode === 'signUp' ? (
              <Text style={styles.termsText}>建立帳號即表示你同意服務條款與隱私權政策</Text>
            ) : null}
          </View>

          {onPreview ? (
            <TouchableOpacity accessibilityRole="button" onPress={onPreview} style={styles.previewButton}>
              <Text style={styles.previewButtonText}>預覽首次設定（不連接雲端）</Text>
              <Text style={styles.previewButtonArrow}>→</Text>
            </TouchableOpacity>
          ) : null}

          <View style={styles.cloudNote}>
            <Text style={styles.cloudNoteIcon}>☁</Text>
            <Text style={styles.cloudNoteText}>照護資料將安全儲存在雲端，不保存在這台裝置。</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function AuthLoadingScreen() {
  return (
    <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.loadingSafeArea}>
      <View style={styles.loadingContent}>
        <View style={styles.loadingLogo}><Text style={styles.loadingPaw}>🐾</Text></View>
        <Text style={styles.loadingBrand}>Smart Pet Life</Text>
        <ActivityIndicator color="#2D6A4F" style={styles.loadingSpinner} />
      </View>
    </SafeAreaView>
  );
}

type AuthInputProps = React.ComponentProps<typeof TextInput> & { label: string };

function AuthInput({ label, style, ...props }: AuthInputProps) {
  return (
    <View style={styles.inputGroup}>
      <Text style={styles.inputLabel}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor="#9AA7A0" style={[styles.input, style]} {...props} />
    </View>
  );
}

function toFriendlyAuthMessage(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes('invalid login credentials')) return 'Email 或密碼不正確。';
  if (normalized.includes('email not confirmed')) return '請先到信箱完成 Email 驗證。';
  if (normalized.includes('user already registered')) return '這個 Email 已經註冊，請直接登入。';
  if (normalized.includes('password should be')) return '密碼強度不足，請使用至少 8 個字元。';
  if (normalized.includes('rate limit')) return '操作次數過多，請稍後再試。';
  if (normalized.includes('network') || normalized.includes('fetch')) return '目前無法連線，請檢查網路後再試。';
  return message;
}

const colors = {
  ink: '#19352B', muted: '#6C7E76', green: '#2D6A4F', greenDark: '#1F513C',
  mint: '#E8F4EC', cream: '#F7F6F0', white: '#FFFFFF', line: '#E2E8E3',
};

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.cream },
  keyboardView: { flex: 1 },
  scrollContent: { flexGrow: 1, width: '100%', maxWidth: 520, alignSelf: 'center', paddingHorizontal: 22, paddingTop: Platform.OS === 'web' ? 40 : 28, paddingBottom: 32 },
  hero: { alignItems: 'center', marginBottom: 26 },
  logoWrap: { width: 78, height: 78, borderRadius: 27, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.green, shadowColor: '#214936', shadowOffset: { width: 0, height: 9 }, shadowOpacity: 0.18, shadowRadius: 16, elevation: 5 },
  logoPaw: { fontSize: 37 },
  brand: { color: colors.ink, fontSize: 27, fontWeight: '900', letterSpacing: -0.6, marginTop: 16 },
  tagline: { color: colors.muted, fontSize: 12, lineHeight: 19, marginTop: 6 },
  authCard: { backgroundColor: colors.white, borderRadius: 26, borderWidth: 1, borderColor: colors.line, padding: 20, shadowColor: '#284C3B', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.07, shadowRadius: 22, elevation: 3 },
  modeTabs: { flexDirection: 'row', backgroundColor: '#F1F4F1', borderRadius: 14, padding: 4, marginBottom: 22 },
  modeTab: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 11 },
  modeTabActive: { backgroundColor: colors.white, shadowColor: '#294E3D', shadowOpacity: 0.08, shadowRadius: 7, elevation: 2 },
  modeTabText: { color: colors.muted, fontSize: 13, fontWeight: '800' },
  modeTabTextActive: { color: colors.greenDark },
  cardTitle: { color: colors.ink, fontSize: 21, fontWeight: '900', letterSpacing: -0.3 },
  cardSubtitle: { color: colors.muted, fontSize: 11, lineHeight: 18, marginTop: 5, marginBottom: 19 },
  inputGroup: { marginBottom: 14 },
  inputLabel: { color: colors.ink, fontSize: 11, fontWeight: '800', marginBottom: 7 },
  input: { minHeight: 52, borderRadius: 15, borderWidth: 1, borderColor: colors.line, backgroundColor: '#FCFDFC', color: colors.ink, fontSize: 13, fontWeight: '600', paddingHorizontal: 14 },
  passwordControl: { minHeight: 52, flexDirection: 'row', alignItems: 'center', borderRadius: 15, borderWidth: 1, borderColor: colors.line, backgroundColor: '#FCFDFC' },
  passwordInput: { flex: 1, minHeight: 50, color: colors.ink, fontSize: 13, fontWeight: '600', paddingHorizontal: 14 },
  passwordToggle: { minHeight: 50, justifyContent: 'center', paddingHorizontal: 14 },
  passwordToggleText: { color: colors.green, fontSize: 11, fontWeight: '900' },
  forgotButton: { alignSelf: 'flex-end', marginTop: -4, marginBottom: 15, paddingVertical: 4 },
  forgotText: { color: colors.green, fontSize: 11, fontWeight: '800' },
  errorBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF0EF', borderRadius: 13, padding: 11, marginBottom: 13 },
  errorIcon: { width: 20, height: 20, borderRadius: 10, textAlign: 'center', lineHeight: 20, backgroundColor: '#D4544A', color: colors.white, fontSize: 11, fontWeight: '900', marginRight: 8 },
  errorText: { flex: 1, color: '#9D3D37', fontSize: 10, lineHeight: 16, fontWeight: '700' },
  noticeBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.mint, borderRadius: 13, padding: 11, marginBottom: 13 },
  noticeIcon: { color: colors.green, fontSize: 14, fontWeight: '900', marginRight: 8 },
  noticeText: { flex: 1, color: colors.greenDark, fontSize: 10, lineHeight: 16, fontWeight: '700' },
  submitButton: { minHeight: 54, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: colors.green, marginTop: 2 },
  submitButtonDisabled: { opacity: 0.65 },
  submitButtonText: { color: colors.white, fontSize: 14, fontWeight: '900', letterSpacing: 0.4 },
  termsText: { color: '#89958F', fontSize: 9, lineHeight: 15, textAlign: 'center', marginTop: 12 },
  previewButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 14 },
  previewButtonText: { color: colors.green, fontSize: 12, fontWeight: '900' },
  previewButtonArrow: { color: colors.green, fontSize: 17, marginLeft: 7 },
  cloudNote: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginTop: 'auto', paddingTop: 18 },
  cloudNoteIcon: { color: '#799286', fontSize: 15, marginRight: 7 },
  cloudNoteText: { color: '#819088', fontSize: 9, lineHeight: 15 },
  loadingSafeArea: { flex: 1, backgroundColor: colors.cream },
  loadingContent: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingLogo: { width: 74, height: 74, borderRadius: 26, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center' },
  loadingPaw: { fontSize: 35 },
  loadingBrand: { color: colors.ink, fontSize: 23, fontWeight: '900', marginTop: 16 },
  loadingSpinner: { marginTop: 24 },
});

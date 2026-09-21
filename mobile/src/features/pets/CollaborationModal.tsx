import { useEffect, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import {
  acceptPetInvitation,
  createPetInvitation,
  listMyPendingInvitations,
  listPetInvitations,
  listPetMemberships,
  removePetMembership,
  revokePetInvitation,
} from '../../services/petData';
import type { PetInvitationRow, PetMemberRole, PetMembershipRow } from '../../types/database';

type Props = {
  visible: boolean;
  currentUserId: string;
  currentUserEmail: string;
  petId: string;
  petName: string;
  ownerId: string;
  onClose: () => void;
  onAccessChanged: () => void;
};

type InviteFeedback = { title: string; message: string } | null;

// 資料庫錯誤到使用者文案的對應集中在 createPetInvitation，這裡只負責取出訊息。
// 先前兩處各有一份英文比對，UI 這份實際上比對不到任何已轉譯的錯誤，靠
// fallthrough 才顯示正確內容。
function invitationErrorMessage(error: unknown) {
  const rawMessage = typeof error === 'object' && error !== null && 'message' in error
    ? String(error.message)
    : error instanceof Error
      ? error.message
      : String(error ?? '');

  return rawMessage.trim() || '無法建立邀請，請稍後再試。';
}

export function CollaborationModal(props: Props) {
  const isOwner = props.currentUserId === props.ownerId;
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<PetMemberRole>('editor');
  const [invitations, setInvitations] = useState<PetInvitationRow[]>([]);
  const [memberships, setMemberships] = useState<PetMembershipRow[]>([]);
  const [myInvitations, setMyInvitations] = useState<PetInvitationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [inviteFeedback, setInviteFeedback] = useState<InviteFeedback>(null);

  const reload = async () => {
    setLoading(true);
    try {
      const pending = props.currentUserEmail
        ? await listMyPendingInvitations(props.currentUserEmail)
        : [];
      setMyInvitations(pending);
      if (isOwner) {
        const [petInvitations, petMemberships] = await Promise.all([
          listPetInvitations(props.petId),
          listPetMemberships(props.ownerId, props.petId),
        ]);
        setInvitations(petInvitations);
        setMemberships(petMemberships);
      }
    } catch (error) {
      Alert.alert('載入失敗', error instanceof Error ? error.message : '無法載入共同照護資料。');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (props.visible) void reload();
  }, [props.visible, props.petId]);

  const invite = async () => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
      setInviteFeedback({ title: 'Email 格式不正確', message: '請輸入共同照護者註冊 Smart Pet Life 使用的 Email。' });
      return;
    }
    if (memberships.some((item) => item.member_email === normalizedEmail)) {
      setInviteFeedback({ title: '無法建立邀請', message: '此 Email 已經是這隻狗狗的共同照護者。' });
      return;
    }
    if (invitations.some((item) => item.status === 'pending' && item.invited_email === normalizedEmail && new Date(item.expires_at).getTime() > Date.now())) {
      setInviteFeedback({ title: '已有待接受邀請', message: '此 Email 已經邀請過了，請直接使用下方原本的 QR code 或邀請碼。' });
      return;
    }
    setLoading(true);
    try {
      const invitation = await createPetInvitation({
        petId: props.petId,
        ownerId: props.ownerId,
        invitedBy: props.currentUserId,
        email: normalizedEmail,
        role,
      });
      setEmail('');
      await reload();
      setInviteFeedback({ title: '邀請已建立', message: `請對方登入相同 Email 後掃描 QR code，或輸入邀請碼 ${invitation.invite_code}。` });
    } catch (error) {
      setInviteFeedback({ title: '無法建立邀請', message: invitationErrorMessage(error) });
    } finally {
      setLoading(false);
    }
  };

  // 回饋對話框刻意畫在這個 Modal 內部，而不是第二個並存的 Modal。
  // iOS 的 RN Modal 是原生 presented view controller，同時呈現兩個並不可靠，
  // 會造成提示時有時無。
  return (
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={props.onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={props.onClose} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View><Text style={styles.title}>共同照護</Text><Text style={styles.subtitle}>{props.petName} 的存取權限</Text></View>
            <TouchableOpacity onPress={props.onClose}><Text style={styles.close}>完成</Text></TouchableOpacity>
          </View>
          <ScrollView showsVerticalScrollIndicator={false}>
            {isOwner && <View style={styles.card}>
              <Text style={styles.sectionTitle}>邀請照護者</Text>
              <Text style={styles.sectionDescription}>輸入對方註冊 Smart Pet Life 的 Email。建立後，QR code 和 10 位邀請碼會立即顯示在下方。</Text>
              <TextInput value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder="caregiver@example.com" style={styles.input} />
              <View style={styles.roles}>
                {(['editor', 'viewer'] as PetMemberRole[]).map((value) => <TouchableOpacity key={value} onPress={() => setRole(value)} style={[styles.role, role === value && styles.roleActive]}><Text style={[styles.roleText, role === value && styles.roleTextActive]}>{value === 'editor' ? '可新增與編輯' : '僅查看'}</Text></TouchableOpacity>)}
              </View>
              <TouchableOpacity disabled={loading} onPress={invite} style={styles.primary}><Text style={styles.primaryText}>{loading ? '處理中…' : '建立邀請'}</Text></TouchableOpacity>
            </View>}

            {isOwner && invitations.some((item) => item.status === 'pending') ? (
              <View style={[styles.card, styles.shareSectionCard]}>
                <Text style={styles.sectionTitle}>分享邀請</Text>
                <Text style={styles.sectionDescription}>請讓受邀者掃描 QR code，或把邀請碼交給對方手動輸入。</Text>
                {invitations.filter((item) => item.status === 'pending').map((item) => (
                  <View key={item.id} style={styles.invitationShareCard}>
                    <View style={styles.invitationShareHeader}>
                      <View style={styles.rowInfo}><Text style={styles.rowTitle}>{item.invited_email}</Text><Text style={styles.rowMeta}>{item.role === 'editor' ? '可新增與編輯' : '僅查看'}・7 天內有效</Text></View>
                      <TouchableOpacity onPress={() => void (async () => { await revokePetInvitation(props.ownerId, item.id); await reload(); })()}><Text style={styles.danger}>撤銷</Text></TouchableOpacity>
                    </View>
                    <View style={styles.invitationShareBody}>
                      <View style={styles.qrWrap}><QRCode size={118} value={`smartpet://invite/${item.invite_code}`} backgroundColor="#FFFFFF" color="#19352B" /></View>
                      <View style={styles.invitationCodeBlock}>
                        <Text style={styles.invitationCodeLabel}>10 位邀請碼</Text>
                        <Text selectable style={styles.invitationCode}>{item.invite_code}</Text>
                        <Text style={styles.invitationCodeHint}>長按可選取複製{`\n`}僅限受邀 Email 使用</Text>
                      </View>
                    </View>
                  </View>
                ))}
              </View>
            ) : isOwner ? (
              <View style={styles.shareEmptyCard}>
                <Text style={styles.shareEmptyIcon}>▦</Text>
                <View style={styles.rowInfo}><Text style={styles.shareEmptyTitle}>QR code 會顯示在這裡</Text><Text style={styles.shareEmptyText}>先在上方輸入對方 Email 並建立邀請。</Text></View>
              </View>
            ) : null}

            {myInvitations.length > 0 && <View style={styles.card}>
              <Text style={styles.sectionTitle}>等待你接受的邀請</Text>
              {myInvitations.map((item) => <View key={item.id} style={styles.row}><View style={styles.rowInfo}><Text style={styles.rowTitle}>寵物共同照護邀請</Text><Text style={styles.rowMeta}>{item.role === 'editor' ? '可新增與編輯' : '僅查看'}・7 天內有效</Text></View><TouchableOpacity style={styles.accept} onPress={() => void (async () => { try { await acceptPetInvitation(item.id); await reload(); props.onAccessChanged(); } catch (error) { Alert.alert('接受失敗', error instanceof Error ? error.message : '無法接受邀請。'); } })()}><Text style={styles.acceptText}>接受</Text></TouchableOpacity></View>)}
            </View>}

            {isOwner && <View style={styles.card}>
              <Text style={styles.sectionTitle}>目前照護者</Text>
              {memberships.length === 0 ? <Text style={styles.empty}>尚未有共同照護者</Text> : memberships.map((item) => <View key={item.id} style={styles.row}><View style={styles.rowInfo}><Text style={styles.rowTitle}>{item.member_email || '共同照護者'}</Text><Text style={styles.rowMeta}>{item.role === 'editor' ? '可新增與編輯照護紀錄' : '僅查看照護紀錄'}</Text></View><TouchableOpacity onPress={() => void (async () => { await removePetMembership(props.ownerId, item.id); await reload(); })()}><Text style={styles.danger}>移除</Text></TouchableOpacity></View>)}
            </View>}
          </ScrollView>
        </View>
      {inviteFeedback === null ? null : (
        <View style={styles.feedbackOverlay}>
          {/* 攔截觸控，避免點到暗處時穿透到底下關閉整個面板的 Pressable。 */}
          <Pressable
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={StyleSheet.absoluteFill}
            onPress={() => setInviteFeedback(null)}
          />
          <View
            accessibilityViewIsModal
            accessibilityRole="alert"
            accessibilityLabel={`${inviteFeedback.title}。${inviteFeedback.message}`}
            style={styles.feedbackDialog}
          >
            <Text style={styles.feedbackTitle}>{inviteFeedback.title}</Text>
            <Text style={styles.feedbackMessage}>{inviteFeedback.message}</Text>
            <TouchableOpacity accessibilityRole="button" style={styles.feedbackButton} onPress={() => setInviteFeedback(null)}>
              <Text style={styles.feedbackButtonText}>確定</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(12,30,23,0.42)', justifyContent: 'flex-end' },
  sheet: { width: '100%', maxWidth: 520, maxHeight: '90%', alignSelf: 'center', backgroundColor: '#F7F6F0', borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 18 },
  handle: { width: 42, height: 5, borderRadius: 4, backgroundColor: '#C8CEC9', alignSelf: 'center', marginBottom: 18 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 },
  title: { color: '#19352B', fontSize: 23, fontWeight: '900' }, subtitle: { color: '#6C7E76', fontSize: 11, marginTop: 3 }, close: { color: '#2D6A4F', fontWeight: '900' },
  card: { backgroundColor: '#FFF', borderRadius: 20, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: '#E6EAE6' },
  sectionTitle: { color: '#19352B', fontSize: 14, fontWeight: '900', marginBottom: 12 },
  sectionDescription: { color: '#6C7E76', fontSize: 9, lineHeight: 15, marginTop: -5, marginBottom: 12 },
  input: { minHeight: 48, borderWidth: 1, borderColor: '#DDE3DE', borderRadius: 14, paddingHorizontal: 13, color: '#19352B', backgroundColor: '#FAFBF9' },
  roles: { flexDirection: 'row', gap: 8, marginTop: 10 }, role: { flex: 1, padding: 10, borderRadius: 12, alignItems: 'center', backgroundColor: '#EEF1EE' }, roleActive: { backgroundColor: '#DDEFE4' }, roleText: { color: '#6C7E76', fontSize: 10, fontWeight: '800' }, roleTextActive: { color: '#1F513C' },
  primary: { minHeight: 46, backgroundColor: '#2D6A4F', borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 12 }, primaryText: { color: '#FFF', fontWeight: '900' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#EEF1EE' }, rowInfo: { flex: 1 }, rowTitle: { color: '#19352B', fontSize: 12, fontWeight: '800' }, rowMeta: { color: '#6C7E76', fontSize: 9, marginTop: 3 },
  accept: { backgroundColor: '#DDEFE4', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 }, acceptText: { color: '#1F513C', fontSize: 10, fontWeight: '900' }, danger: { color: '#A64B4B', fontSize: 10, fontWeight: '900', padding: 8 }, empty: { color: '#87958E', fontSize: 10 },
  shareSectionCard: { borderColor: '#CFE3D5', backgroundColor: '#F8FCF9' },
  shareEmptyCard: { minHeight: 72, flexDirection: 'row', alignItems: 'center', backgroundColor: '#EDF7F0', borderRadius: 18, borderWidth: 1, borderColor: '#D5E8DB', padding: 14, marginBottom: 12 },
  shareEmptyIcon: { color: '#2D6A4F', fontSize: 23, fontWeight: '900', marginRight: 12 },
  shareEmptyTitle: { color: '#19352B', fontSize: 11, fontWeight: '900' },
  shareEmptyText: { color: '#6C7E76', fontSize: 9, marginTop: 4 },
  invitationShareCard: { paddingTop: 3, paddingBottom: 4 },
  invitationShareHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  invitationShareBody: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 1, borderColor: '#E2EAE4', padding: 12 },
  qrWrap: { padding: 7, borderRadius: 10, backgroundColor: '#FFFFFF' },
  invitationCodeBlock: { flex: 1 },
  invitationCodeLabel: { color: '#6C7E76', fontSize: 9, fontWeight: '800' },
  invitationCode: { color: '#19352B', fontSize: 17, fontWeight: '900', letterSpacing: 1.7, marginTop: 5 },
  invitationCodeHint: { color: '#84928B', fontSize: 8, lineHeight: 13, marginTop: 6 },
  feedbackOverlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(12,30,23,0.52)', padding: 24 },
  feedbackDialog: { width: '100%', maxWidth: 360, borderRadius: 20, backgroundColor: '#FFFFFF', padding: 20 },
  feedbackTitle: { color: '#19352B', fontSize: 18, fontWeight: '900' },
  feedbackMessage: { color: '#52655D', fontSize: 12, lineHeight: 19, marginTop: 9 },
  feedbackButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: '#2D6A4F', marginTop: 18 },
  feedbackButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
});

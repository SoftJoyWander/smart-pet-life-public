import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  createMedicalDocumentSignedUrl,
  getMedicalViewerAccess,
  listDiagnosticReports,
  listDiagnosticResults,
  listMedicalDocuments,
  listMedicalVisits,
  listVeterinaryOrganizations,
  type MedicalViewerAccess,
} from '../../services/medicalData';
import type {
  DiagnosticFlag,
  DiagnosticReportRow,
  DiagnosticResultRow,
  MedicalDocumentRow,
  MedicalSourceType,
  MedicalVisitRow,
  VeterinaryOrganizationRow,
} from '../../types/database';

type MedicalSection = 'documents' | 'results';

export type MedicalPetContext = {
  id: string;
  ownerId: string;
  name: string;
  avatarIcon: string;
};

type MedicalCenterScreenProps = {
  pet: MedicalPetContext;
  avatarUri: string;
  currentProfileId: string;
  isPreview: boolean;
  canSwitchPet: boolean;
  embeddedInTab?: boolean;
  onClose?: () => void;
  onSwitchPet: () => void;
};

type SectionErrors = {
  documents?: string;
  results?: string;
  organizations?: string;
};

type DocumentGroup = {
  key: string;
  visit: MedicalVisitRow | null;
  documents: MedicalDocumentRow[];
};

const medicalColors = {
  background: '#F7F6F0',
  surface: '#FFFFFF',
  surfaceMuted: '#EEF5F0',
  textPrimary: '#23352C',
  textSecondary: '#68776F',
  border: '#DCE5DF',
  brand: '#2D6A4F',
  brandDark: '#1F503B',
  info: '#3E6E8A',
  infoSurface: '#EAF3F8',
  warning: '#8A5A19',
  warningSurface: '#FFF3D9',
  danger: '#A54444',
  dangerSurface: '#FFF0EF',
  success: '#2F7656',
  successSurface: '#E7F4EC',
};

const sourceLabels: Record<MedicalSourceType, string> = {
  owner_reported: '飼主紀錄',
  caregiver_reported: '照護者紀錄',
  owner_uploaded_unverified: '飼主上傳・未經院方確認',
  clinic_submitted: '醫院提供',
  veterinarian_reviewed: '獸醫師覆核',
  system_derived: '系統整理',
  device_measured: '裝置量測',
};

const flagLabels: Record<DiagnosticFlag, string> = {
  normal: '✓ 正常',
  low: '↓ 偏低',
  high: '↑ 偏高',
  critical_low: '↓ 嚴重偏低',
  critical_high: '↑ 嚴重偏高',
  abnormal: '! 異常',
  indeterminate: '? 無法判定',
  not_provided: '— 院方未提供',
};

const noAccess: MedicalViewerAccess = {
  viewVisit: false,
  viewDocument: false,
  viewDiagnosticResult: false,
};

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'object' && error && 'message' in error && typeof error.message === 'string') return error.message;
  return fallback;
}

function formatDateTime(value: string | null, timezone?: string | null) {
  if (!value) return '未提供';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  if (timezone) options.timeZone = timezone;
  try {
    return new Intl.DateTimeFormat('zh-TW', options).format(date);
  } catch {
    delete options.timeZone;
    return `${new Intl.DateTimeFormat('zh-TW', options).format(date)}（裝置時區）`;
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function documentTypeLabel(type: string) {
  const labels: Record<string, string> = {
    prescription: '處方／藥袋',
    discharge_summary: '出院摘要',
    imaging: '影像檢查',
    laboratory_report: '檢驗報告',
    visit_summary: '就醫摘要',
  };
  return labels[type] ?? type;
}

function reportTypeLabel(type: string) {
  const labels: Record<string, string> = {
    blood_test: '血液檢查',
    urine_test: '尿液檢查',
    stool_test: '糞便檢查',
    imaging: '影像檢查',
    pathology: '病理檢查',
  };
  return labels[type] ?? type;
}

function organizationName(
  organizationId: string | null,
  organizations: Map<string, VeterinaryOrganizationRow>,
) {
  if (!organizationId) return '未指定院方';
  return organizations.get(organizationId)?.name ?? `院方名稱目前無法顯示（${organizationId}）`;
}

function ResultFlag({ flag }: { flag: DiagnosticFlag }) {
  const isNormal = flag === 'normal';
  const isUnknown = flag === 'indeterminate' || flag === 'not_provided';
  return (
    <View style={[
      styles.flagBadge,
      isNormal && styles.flagBadgeNormal,
      isUnknown && styles.flagBadgeUnknown,
      !isNormal && !isUnknown && styles.flagBadgeAttention,
    ]}>
      <Text style={[
        styles.flagBadgeText,
        isNormal && styles.flagBadgeTextNormal,
        isUnknown && styles.flagBadgeTextUnknown,
      ]}>{flagLabels[flag]}</Text>
    </View>
  );
}

function EmptyState({ icon, title, detail }: { icon: string; title: string; detail: string }) {
  return (
    <View style={styles.emptyCard}>
      <Text accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.emptyIcon}>{icon}</Text>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyText}>{detail}</Text>
    </View>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View accessibilityRole="alert" style={styles.errorBanner}>
      <View style={styles.errorBannerCopy}>
        <Text style={styles.errorBannerTitle}>部分資料載入失敗</Text>
        <Text style={styles.errorBannerText}>{message}</Text>
      </View>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="重試載入醫療資料" style={styles.retryButton} onPress={onRetry}>
        <Text style={styles.retryButtonText}>重試</Text>
      </TouchableOpacity>
    </View>
  );
}

export function MedicalCenterScreen({
  pet,
  avatarUri,
  currentProfileId,
  isPreview,
  canSwitchPet,
  embeddedInTab = false,
  onClose,
  onSwitchPet,
}: MedicalCenterScreenProps) {
  const [section, setSection] = useState<MedicalSection>('documents');
  const [access, setAccess] = useState<MedicalViewerAccess | null>(null);
  const [visits, setVisits] = useState<MedicalVisitRow[]>([]);
  const [documents, setDocuments] = useState<MedicalDocumentRow[]>([]);
  const [reports, setReports] = useState<DiagnosticReportRow[]>([]);
  const [results, setResults] = useState<DiagnosticResultRow[]>([]);
  const [organizations, setOrganizations] = useState<VeterinaryOrganizationRow[]>([]);
  const [errors, setErrors] = useState<SectionErrors>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [openingDocumentId, setOpeningDocumentId] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setIsRefreshing(true);
    else setIsLoading(true);
    setErrors({});

    if (isPreview) {
      setAccess({ ...noAccess, viewVisit: true, viewDocument: true, viewDiagnosticResult: true });
      setVisits([]);
      setDocuments([]);
      setReports([]);
      setResults([]);
      setOrganizations([]);
      setLastRefreshedAt(new Date());
      setIsLoading(false);
      setIsRefreshing(false);
      return;
    }

    try {
      const nextAccess = await getMedicalViewerAccess({
        petId: pet.id,
        ownerId: pet.ownerId,
        currentProfileId,
      });
      setAccess(nextAccess);

      const visitPromise = nextAccess.viewVisit
        ? listMedicalVisits(pet.id)
        : Promise.resolve<MedicalVisitRow[]>([]);
      const documentPromise = nextAccess.viewDocument
        ? listMedicalDocuments(pet.id)
        : Promise.resolve<MedicalDocumentRow[]>([]);
      const reportPromise = nextAccess.viewDiagnosticResult
        ? listDiagnosticReports(pet.id)
        : Promise.resolve<DiagnosticReportRow[]>([]);

      const [visitResult, documentResult, reportResult] = await Promise.allSettled([
        visitPromise,
        documentPromise,
        reportPromise,
      ]);

      const nextErrors: SectionErrors = {};
      const nextVisits = visitResult.status === 'fulfilled' ? visitResult.value : [];
      const nextDocuments = documentResult.status === 'fulfilled' ? documentResult.value : [];
      const nextReports = reportResult.status === 'fulfilled' ? reportResult.value : [];

      if (visitResult.status === 'rejected' && nextAccess.viewVisit) {
        nextErrors.documents = errorMessage(visitResult.reason, '無法載入就醫事件。');
      }
      if (documentResult.status === 'rejected' && nextAccess.viewDocument) {
        nextErrors.documents = errorMessage(documentResult.reason, '無法載入就醫檔案。');
      }
      if (reportResult.status === 'rejected' && nextAccess.viewDiagnosticResult) {
        nextErrors.results = errorMessage(reportResult.reason, '無法載入檢查報告。');
      }

      setVisits(nextVisits);
      setDocuments(nextDocuments);
      setReports(nextReports);

      let nextResults: DiagnosticResultRow[] = [];
      if (reportResult.status === 'fulfilled' && nextReports.length > 0) {
        try {
          nextResults = await listDiagnosticResults(nextReports.map((report) => report.id));
        } catch (error) {
          nextErrors.results = errorMessage(error, '檢查報告已載入，但項目數據暫時無法顯示。');
        }
      }
      setResults(nextResults);

      const organizationIds = [
        ...nextVisits.map((visit) => visit.organization_id),
        ...nextDocuments.map((document) => document.organization_id),
        ...nextReports.map((report) => report.organization_id),
      ].filter((id): id is string => Boolean(id));
      try {
        setOrganizations(await listVeterinaryOrganizations(organizationIds));
      } catch (error) {
        setOrganizations([]);
        nextErrors.organizations = errorMessage(error, '院方名稱暫時無法載入。');
      }

      setErrors(nextErrors);
      const completedAuthorizedRead = (
        (nextAccess.viewVisit && visitResult.status === 'fulfilled')
        || (nextAccess.viewDocument && documentResult.status === 'fulfilled')
        || (nextAccess.viewDiagnosticResult && reportResult.status === 'fulfilled')
      );
      if (completedAuthorizedRead) setLastRefreshedAt(new Date());
    } catch (error) {
      setAccess(null);
      setErrors({
        documents: errorMessage(error, '無法確認醫療資料權限，請稍後再試。'),
        results: errorMessage(error, '無法確認醫療資料權限，請稍後再試。'),
      });
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [currentProfileId, isPreview, pet.id, pet.ownerId]);

  useEffect(() => {
    setSection('documents');
    setAccess(null);
    setVisits([]);
    setDocuments([]);
    setReports([]);
    setResults([]);
    setOrganizations([]);
    setLastRefreshedAt(null);
    void load(false);
  }, [load, pet.id]);

  const organizationMap = useMemo(
    () => new Map(organizations.map((organization) => [organization.id, organization])),
    [organizations],
  );

  const documentGroups = useMemo<DocumentGroup[]>(() => {
    const documentsByVisit = new Map<string, MedicalDocumentRow[]>();
    documents.forEach((document) => {
      documentsByVisit.set(document.visit_id, [...(documentsByVisit.get(document.visit_id) ?? []), document]);
    });

    const groups: DocumentGroup[] = visits.map((visit) => ({
      key: visit.id,
      visit,
      documents: documentsByVisit.get(visit.id) ?? [],
    }));
    const knownVisitIds = new Set(visits.map((visit) => visit.id));
    documents.forEach((document) => {
      if (!knownVisitIds.has(document.visit_id)) {
        const existing = groups.find((group) => group.key === document.visit_id);
        if (existing) existing.documents.push(document);
        else groups.push({ key: document.visit_id, visit: null, documents: [document] });
      }
    });
    return groups.sort((left, right) => {
      const leftTime = left.visit?.occurred_at ?? left.documents[0]?.published_at ?? '';
      const rightTime = right.visit?.occurred_at ?? right.documents[0]?.published_at ?? '';
      return Date.parse(rightTime) - Date.parse(leftTime);
    });
  }, [documents, visits]);

  const resultsByReport = useMemo(() => {
    const map = new Map<string, DiagnosticResultRow[]>();
    results.forEach((result) => map.set(result.report_id, [...(map.get(result.report_id) ?? []), result]));
    return map;
  }, [results]);

  const openDocument = async (document: MedicalDocumentRow) => {
    setOpeningDocumentId(document.id);
    try {
      const url = await createMedicalDocumentSignedUrl(document.storage_path);
      await Linking.openURL(url);
    } catch (error) {
      Alert.alert('無法開啟檔案', errorMessage(error, '短效連結建立失敗，請確認網路後重試。'));
    } finally {
      setOpeningDocumentId(null);
    }
  };

  const anyAccess = Boolean(access && (access.viewVisit || access.viewDocument || access.viewDiagnosticResult));
  const activeError = section === 'documents' ? errors.documents : errors.results;
  const activeHasAccess = section === 'documents'
    ? Boolean(access?.viewVisit || access?.viewDocument)
    : Boolean(access?.viewDiagnosticResult);

  const header = (
    <View>
      <View style={styles.petContextCard}>
        <View style={styles.avatar}>
          {avatarUri ? <Image source={{ uri: avatarUri }} style={styles.avatarImage} /> : <Text style={styles.avatarIcon}>{pet.avatarIcon}</Text>}
        </View>
        <View style={styles.petContextCopy}>
          <Text style={styles.petContextLabel}>目前查看的寵物</Text>
          <Text numberOfLines={2} style={styles.petName}>{pet.name}</Text>
          <Text style={styles.petContextMeta}>醫療資料與生活紀錄分開保存</Text>
        </View>
        {canSwitchPet ? (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={`切換目前寵物，現在是${pet.name}`} style={styles.switchPetButton} onPress={onSwitchPet}>
            <Text style={styles.switchPetButtonText}>切換</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {lastRefreshedAt ? (
        <Text style={styles.freshnessText}>最後更新：{formatDateTime(lastRefreshedAt.toISOString())}</Text>
      ) : null}

      {isPreview ? (
        <View style={styles.previewBanner}>
          <Text style={styles.previewBannerTitle}>開發預覽模式</Text>
          <Text style={styles.previewBannerText}>不載入或建立示範醫療資料，登入後才會依 RLS 顯示真實內容。</Text>
        </View>
      ) : null}

      {errors.organizations ? (
        <View style={styles.noticeBanner}>
          <Text style={styles.noticeText}>ⓘ {errors.organizations} 其他醫療內容仍可查看。</Text>
        </View>
      ) : null}

      <View accessibilityRole="tablist" style={styles.segmentControl}>
        <TouchableOpacity
          accessibilityRole="tab"
          accessibilityState={{ selected: section === 'documents' }}
          style={[styles.segmentButton, section === 'documents' && styles.segmentButtonActive]}
          onPress={() => setSection('documents')}
        >
          <Text style={[styles.segmentButtonText, section === 'documents' && styles.segmentButtonTextActive]}>就醫檔案</Text>
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityRole="tab"
          accessibilityState={{ selected: section === 'results' }}
          style={[styles.segmentButton, section === 'results' && styles.segmentButtonActive]}
          onPress={() => setSection('results')}
        >
          <Text style={[styles.segmentButtonText, section === 'results' && styles.segmentButtonTextActive]}>檢查數據</Text>
        </TouchableOpacity>
      </View>

      {activeError ? <ErrorBanner message={activeError} onRetry={() => void load(true)} /> : null}
    </View>
  );

  const renderDocumentGroup = ({ item }: { item: DocumentGroup }) => {
    const visitTimezone = item.visit?.timezone;
    const groupOrganizationId = item.visit?.organization_id ?? item.documents[0]?.organization_id ?? null;
    return (
      <View style={styles.groupCard}>
        <View style={styles.groupHeader}>
          <View style={styles.groupHeaderCopy}>
            <Text style={styles.groupEyebrow}>{item.visit ? formatDateTime(item.visit.occurred_at, visitTimezone) : '就醫事件資料受限'}</Text>
            <Text style={styles.groupTitle}>{item.visit?.title ?? '院方就醫檔案'}</Text>
            <Text style={styles.organizationText}>{organizationName(groupOrganizationId, organizationMap)}</Text>
          </View>
          {item.visit ? <View style={styles.sourceBadge}><Text style={styles.sourceBadgeText}>{sourceLabels[item.visit.source_type]}</Text></View> : null}
        </View>
        {item.visit?.status === 'corrected' ? <Text style={styles.correctionText}>此就醫事件已有修正版</Text> : null}
        {item.visit?.status === 'cancelled' ? <Text style={styles.cancelledText}>此就醫事件已由資料提供方取消</Text> : null}
        {item.visit?.summary ? <Text style={styles.visitSummary}>{item.visit.summary}</Text> : null}

        {item.documents.length > 0 ? item.documents.map((document) => (
          <View key={document.id} style={styles.documentRow}>
            <View style={styles.documentIcon}><Text style={styles.documentIconText}>{document.mime_type === 'application/pdf' ? 'PDF' : 'IMG'}</Text></View>
            <View style={styles.documentCopy}>
              <Text style={styles.documentType}>{documentTypeLabel(document.document_type)}</Text>
              <Text numberOfLines={3} style={styles.documentName}>{document.original_filename}</Text>
              <Text style={styles.documentMeta}>{formatBytes(document.size_bytes)}・版本 {document.version}</Text>
              <Text style={styles.documentMeta}>發布：{formatDateTime(document.published_at)}（依裝置時區）</Text>
              <Text style={styles.documentSource}>{sourceLabels[document.source_type]}</Text>
              {document.status === 'superseded' ? <Text style={styles.supersededText}>已被新版取代</Text> : null}
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`開啟醫療檔案${document.original_filename}`}
                accessibilityHint="將建立五分鐘有效的私有連結"
                disabled={openingDocumentId != null}
                style={[styles.openButton, openingDocumentId != null && styles.buttonDisabled]}
                onPress={() => void openDocument(document)}
              >
                <Text style={styles.openButtonText}>{openingDocumentId === document.id ? '建立短效連結中…' : '開啟檔案'}</Text>
              </TouchableOpacity>
              <Text style={styles.privateLinkText}>私人短效連結，建立後 5 分鐘失效</Text>
            </View>
          </View>
        )) : <Text style={styles.noAttachmentText}>這次就醫目前沒有已發布附件。</Text>}
      </View>
    );
  };

  const renderReport = ({ item }: { item: DiagnosticReportRow }) => {
    const reportResults = resultsByReport.get(item.id) ?? [];
    return (
      <View style={styles.groupCard}>
        <View style={styles.groupHeader}>
          <View style={styles.groupHeaderCopy}>
            <Text style={styles.groupEyebrow}>{item.reported_at ? `報告 ${formatDateTime(item.reported_at, item.timezone)}` : '報告時間未提供'}</Text>
            <Text style={styles.groupTitle}>{reportTypeLabel(item.report_type)}</Text>
            <Text style={styles.organizationText}>{organizationName(item.organization_id, organizationMap)}</Text>
          </View>
          <View style={styles.sourceBadge}><Text style={styles.sourceBadgeText}>{sourceLabels[item.source_type]}</Text></View>
        </View>
        <View style={styles.reportMetaCard}>
          <Text style={styles.reportMetaText}>採檢：{formatDateTime(item.collected_at, item.timezone)}</Text>
          <Text style={styles.reportMetaText}>紀錄：{formatDateTime(item.recorded_at, item.timezone)}</Text>
          <Text style={styles.reportMetaText}>時區：{item.timezone}</Text>
          {item.status === 'corrected' ? <Text style={styles.correctionText}>此報告為修正版</Text> : null}
        </View>

        {reportResults.length > 0 ? reportResults.map((result) => {
          const originalValue = result.value_text ?? String(result.value_numeric);
          const reference = result.reference_text
            ?? (result.reference_low != null || result.reference_high != null
              ? `${result.reference_low ?? '—'} – ${result.reference_high ?? '—'}`
              : '院方未提供');
          return (
            <View key={result.id} style={styles.resultRow}>
              <View style={styles.resultHeading}>
                <View style={styles.resultNameWrap}>
                  <Text style={styles.resultName}>{result.item_name}</Text>
                  {result.item_code ? <Text style={styles.resultCode}>{result.item_code}</Text> : null}
                </View>
                <ResultFlag flag={result.flag} />
              </View>
              <Text style={styles.resultValue}>{originalValue}{result.original_unit ? ` ${result.original_unit}` : ''}</Text>
              <Text style={styles.resultReference}>院方參考範圍：{reference}</Text>
              {result.canonical_value != null && result.canonical_unit ? (
                <Text style={styles.canonicalValue}>系統標準化：{result.canonical_value} {result.canonical_unit}</Text>
              ) : null}
              {result.specimen ? <Text style={styles.resultDetail}>檢體：{result.specimen}</Text> : null}
              {result.method ? <Text style={styles.resultDetail}>方法：{result.method}</Text> : null}
            </View>
          );
        }) : <Text style={styles.noAttachmentText}>{errors.results ? '檢查項目暫時無法載入。' : '院方尚未提供結構化檢查項目。'}</Text>}
      </View>
    );
  };

  let content;
  if (isLoading) {
    content = (
      <View style={styles.centerState}>
        <ActivityIndicator size="large" color={medicalColors.brand} />
        <Text style={styles.centerStateTitle}>正在載入醫療資料</Text>
        <Text style={styles.centerStateText}>僅讀取目前寵物與帳號獲授權的內容。</Text>
      </View>
    );
  } else if (access == null) {
    content = (
      <View style={styles.contentPadding}>
        {header}
        <EmptyState icon="!" title="無法載入醫療資料" detail="目前無法確認帳號的醫療查看權限，請檢查網路後重試。" />
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="重新載入醫療資料" style={styles.fullRetryButton} onPress={() => void load(true)}>
          <Text style={styles.fullRetryButtonText}>重新載入</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (!anyAccess) {
    content = (
      <View style={styles.contentPadding}>
        {header}
        <EmptyState icon="🔒" title="目前沒有醫療查看權限" detail={`你目前無法查看${pet.name}的就醫檔案或檢查數據，請由飼主另行授權。`} />
        {activeError ? <TouchableOpacity style={styles.fullRetryButton} onPress={() => void load(true)}><Text style={styles.fullRetryButtonText}>重新確認權限</Text></TouchableOpacity> : null}
      </View>
    );
  } else if (!activeHasAccess) {
    content = (
      <View style={styles.contentPadding}>
        {header}
        <EmptyState icon="🔒" title="此區沒有查看權限" detail="目前授權範圍不包含這一類醫療資料。" />
      </View>
    );
  } else if (section === 'documents') {
    content = (
      <FlatList
        data={documentGroups}
        keyExtractor={(item) => item.key}
        renderItem={renderDocumentGroup}
        ListHeaderComponent={header}
        ListEmptyComponent={<EmptyState icon="▤" title="目前沒有院方發布的就醫檔案" detail="醫院發布資料後，會依就醫日期顯示在這裡。" />}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        refreshing={isRefreshing}
        onRefresh={() => void load(true)}
      />
    );
  } else {
    content = (
      <FlatList
        data={reports}
        keyExtractor={(item) => item.id}
        renderItem={renderReport}
        ListHeaderComponent={header}
        ListEmptyComponent={<EmptyState icon="⌁" title="目前沒有已確認的檢查數據" detail="院方確認報告後，原始數值、單位、參考範圍與旗標會顯示在這裡。" />}
        ListFooterComponent={reports.length ? (
          <View style={styles.clinicalNotice}>
            <Text style={styles.clinicalNoticeTitle}>資料說明</Text>
            <Text style={styles.clinicalNoticeText}>App 忠實顯示院方提供的數據與旗標，不提供診斷或治療建議。如對結果有疑問，請直接向提供報告的動物醫院確認。</Text>
          </View>
        ) : null}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        refreshing={isRefreshing}
        onRefresh={() => void load(true)}
      />
    );
  }

  const screenContent = (
    <>
      <View style={styles.navigationBar}>
        {!embeddedInTab && onClose ? (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="返回生活紀錄" style={styles.backButton} onPress={onClose}>
            <Text style={styles.backButtonText}>‹</Text>
          </TouchableOpacity>
        ) : null}
        <View style={[styles.navigationCopy, embeddedInTab && styles.navigationCopyEmbedded]}>
          <Text style={styles.navigationEyebrow}>唯讀醫療資料</Text>
          <Text style={styles.navigationTitle}>醫療中心</Text>
        </View>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="刷新醫療資料" disabled={isLoading || isRefreshing} style={styles.refreshButton} onPress={() => void load(true)}>
          <Text style={styles.refreshButtonText}>{isRefreshing ? '更新中' : '↻ 更新'}</Text>
        </TouchableOpacity>
      </View>
      {content}
    </>
  );

  if (embeddedInTab) {
    return <View testID="medical-center-screen" style={styles.safeArea}>{screenContent}</View>;
  }

  return (
    <SafeAreaView testID="medical-center-screen" edges={['top', 'left', 'right', 'bottom']} style={styles.safeArea}>
      {screenContent}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, width: '100%', maxWidth: 520, alignSelf: 'center', backgroundColor: medicalColors.background },
  navigationBar: { minHeight: 68, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: medicalColors.border, backgroundColor: medicalColors.background },
  backButton: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: medicalColors.surfaceMuted },
  backButtonText: { color: medicalColors.brand, fontSize: 32, lineHeight: 34, fontWeight: '500' },
  navigationCopy: { flex: 1, minWidth: 0, paddingHorizontal: 12 },
  navigationCopyEmbedded: { paddingLeft: 4 },
  navigationEyebrow: { color: medicalColors.textSecondary, fontSize: 11, lineHeight: 16, fontWeight: '700' },
  navigationTitle: { color: medicalColors.textPrimary, fontSize: 21, lineHeight: 27, fontWeight: '900' },
  refreshButton: { minWidth: 64, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 14, paddingHorizontal: 8 },
  refreshButtonText: { color: medicalColors.brand, fontSize: 12, lineHeight: 18, fontWeight: '900' },
  listContent: { flexGrow: 1, padding: 16, paddingBottom: 36 },
  contentPadding: { flex: 1, padding: 16 },
  petContextCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: medicalColors.surface, borderWidth: 1, borderColor: medicalColors.border, borderRadius: 20, padding: 14 },
  avatar: { width: 54, height: 54, borderRadius: 18, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF0D9', marginRight: 12 },
  avatarImage: { width: '100%', height: '100%' },
  avatarIcon: { fontSize: 27, lineHeight: 34 },
  petContextCopy: { flex: 1, minWidth: 0 },
  petContextLabel: { color: medicalColors.textSecondary, fontSize: 10, lineHeight: 15, fontWeight: '800' },
  petName: { color: medicalColors.textPrimary, fontSize: 18, lineHeight: 24, fontWeight: '900', marginTop: 1 },
  petContextMeta: { color: medicalColors.textSecondary, fontSize: 10, lineHeight: 15, marginTop: 2 },
  switchPetButton: { minWidth: 54, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: medicalColors.surfaceMuted, marginLeft: 8 },
  switchPetButtonText: { color: medicalColors.brand, fontSize: 12, fontWeight: '900' },
  freshnessText: { color: medicalColors.textSecondary, fontSize: 10, lineHeight: 15, textAlign: 'right', marginTop: 6 },
  previewBanner: { backgroundColor: medicalColors.infoSurface, borderRadius: 14, borderWidth: 1, borderColor: '#C9DEE9', padding: 12, marginTop: 12 },
  previewBannerTitle: { color: medicalColors.info, fontSize: 12, lineHeight: 18, fontWeight: '900' },
  previewBannerText: { color: medicalColors.info, fontSize: 10, lineHeight: 16, marginTop: 2 },
  noticeBanner: { backgroundColor: medicalColors.warningSurface, borderRadius: 14, borderWidth: 1, borderColor: '#EBD7A9', padding: 12, marginTop: 12 },
  noticeText: { color: medicalColors.warning, fontSize: 10, lineHeight: 16, fontWeight: '700' },
  segmentControl: { flexDirection: 'row', backgroundColor: '#E9ECE9', borderRadius: 16, padding: 4, marginTop: 16, marginBottom: 16 },
  segmentButton: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 13, paddingHorizontal: 8 },
  segmentButtonActive: { backgroundColor: medicalColors.brandDark },
  segmentButtonText: { color: medicalColors.textSecondary, fontSize: 13, lineHeight: 19, fontWeight: '900' },
  segmentButtonTextActive: { color: medicalColors.surface },
  errorBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: medicalColors.dangerSurface, borderWidth: 1, borderColor: '#EBC8C5', borderRadius: 15, padding: 12, marginBottom: 14 },
  errorBannerCopy: { flex: 1, minWidth: 0, paddingRight: 8 },
  errorBannerTitle: { color: medicalColors.danger, fontSize: 11, lineHeight: 17, fontWeight: '900' },
  errorBannerText: { color: medicalColors.danger, fontSize: 9, lineHeight: 14, marginTop: 2 },
  retryButton: { minWidth: 54, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: medicalColors.surface },
  retryButtonText: { color: medicalColors.danger, fontSize: 11, fontWeight: '900' },
  groupCard: { backgroundColor: medicalColors.surface, borderWidth: 1, borderColor: medicalColors.border, borderRadius: 20, padding: 15, marginBottom: 13 },
  groupHeader: { flexDirection: 'row', alignItems: 'flex-start' },
  groupHeaderCopy: { flex: 1, minWidth: 0, paddingRight: 8 },
  groupEyebrow: { color: medicalColors.textSecondary, fontSize: 10, lineHeight: 15, fontWeight: '700' },
  groupTitle: { color: medicalColors.textPrimary, fontSize: 16, lineHeight: 22, fontWeight: '900', marginTop: 3 },
  organizationText: { color: medicalColors.textSecondary, fontSize: 10, lineHeight: 16, marginTop: 4 },
  sourceBadge: { maxWidth: '42%', borderRadius: 10, backgroundColor: medicalColors.infoSurface, paddingHorizontal: 9, paddingVertical: 6 },
  sourceBadgeText: { color: medicalColors.info, fontSize: 9, lineHeight: 14, fontWeight: '900', textAlign: 'center' },
  correctionText: { color: medicalColors.warning, fontSize: 10, lineHeight: 16, fontWeight: '800', marginTop: 8 },
  cancelledText: { color: medicalColors.danger, fontSize: 10, lineHeight: 16, fontWeight: '800', marginTop: 8 },
  visitSummary: { color: medicalColors.textPrimary, fontSize: 11, lineHeight: 18, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: medicalColors.border },
  documentRow: { flexDirection: 'row', alignItems: 'flex-start', borderTopWidth: 1, borderTopColor: medicalColors.border, paddingTop: 14, marginTop: 14 },
  documentIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: medicalColors.surfaceMuted, marginRight: 11 },
  documentIconText: { color: medicalColors.brand, fontSize: 10, fontWeight: '900' },
  documentCopy: { flex: 1, minWidth: 0 },
  documentType: { color: medicalColors.brand, fontSize: 10, lineHeight: 15, fontWeight: '900' },
  documentName: { color: medicalColors.textPrimary, fontSize: 13, lineHeight: 20, fontWeight: '900', marginTop: 2 },
  documentMeta: { color: medicalColors.textSecondary, fontSize: 9, lineHeight: 15, marginTop: 3 },
  documentSource: { color: medicalColors.info, fontSize: 9, lineHeight: 15, fontWeight: '800', marginTop: 4 },
  supersededText: { color: medicalColors.warning, fontSize: 10, lineHeight: 16, fontWeight: '900', marginTop: 4 },
  openButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: medicalColors.brand, marginTop: 10, paddingHorizontal: 12 },
  openButtonText: { color: medicalColors.surface, fontSize: 11, lineHeight: 17, fontWeight: '900' },
  privateLinkText: { color: medicalColors.textSecondary, fontSize: 9, lineHeight: 15, textAlign: 'center', marginTop: 5 },
  buttonDisabled: { opacity: 0.55 },
  noAttachmentText: { color: medicalColors.textSecondary, fontSize: 10, lineHeight: 17, textAlign: 'center', borderTopWidth: 1, borderTopColor: medicalColors.border, paddingTop: 14, marginTop: 14 },
  reportMetaCard: { backgroundColor: medicalColors.surfaceMuted, borderRadius: 14, padding: 11, marginTop: 12 },
  reportMetaText: { color: medicalColors.textSecondary, fontSize: 10, lineHeight: 17 },
  resultRow: { borderTopWidth: 1, borderTopColor: medicalColors.border, paddingTop: 14, marginTop: 14 },
  resultHeading: { flexDirection: 'row', alignItems: 'flex-start' },
  resultNameWrap: { flex: 1, minWidth: 0, paddingRight: 8 },
  resultName: { color: medicalColors.textPrimary, fontSize: 13, lineHeight: 20, fontWeight: '900' },
  resultCode: { color: medicalColors.textSecondary, fontSize: 9, lineHeight: 14, marginTop: 1 },
  flagBadge: { maxWidth: '48%', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 5, backgroundColor: medicalColors.warningSurface },
  flagBadgeNormal: { backgroundColor: medicalColors.successSurface },
  flagBadgeUnknown: { backgroundColor: '#EFF1F0' },
  flagBadgeAttention: { backgroundColor: medicalColors.warningSurface },
  flagBadgeText: { color: medicalColors.warning, fontSize: 9, lineHeight: 14, fontWeight: '900', textAlign: 'center' },
  flagBadgeTextNormal: { color: medicalColors.success },
  flagBadgeTextUnknown: { color: medicalColors.textSecondary },
  resultValue: { color: medicalColors.textPrimary, fontSize: 22, lineHeight: 29, fontWeight: '900', marginTop: 10 },
  resultReference: { color: medicalColors.textSecondary, fontSize: 10, lineHeight: 16, marginTop: 4 },
  canonicalValue: { color: medicalColors.info, fontSize: 9, lineHeight: 15, marginTop: 4 },
  resultDetail: { color: medicalColors.textSecondary, fontSize: 9, lineHeight: 15, marginTop: 2 },
  emptyCard: { minHeight: 210, alignItems: 'center', justifyContent: 'center', backgroundColor: medicalColors.surface, borderWidth: 1, borderColor: medicalColors.border, borderRadius: 20, padding: 24 },
  emptyIcon: { fontSize: 30, lineHeight: 38, marginBottom: 10 },
  emptyTitle: { color: medicalColors.textPrimary, fontSize: 15, lineHeight: 22, fontWeight: '900', textAlign: 'center' },
  emptyText: { color: medicalColors.textSecondary, fontSize: 11, lineHeight: 18, textAlign: 'center', marginTop: 6 },
  centerState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  centerStateTitle: { color: medicalColors.textPrimary, fontSize: 16, lineHeight: 23, fontWeight: '900', marginTop: 14 },
  centerStateText: { color: medicalColors.textSecondary, fontSize: 11, lineHeight: 18, textAlign: 'center', marginTop: 5 },
  fullRetryButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: medicalColors.brand, marginTop: 12 },
  fullRetryButtonText: { color: medicalColors.surface, fontSize: 12, fontWeight: '900' },
  clinicalNotice: { backgroundColor: medicalColors.infoSurface, borderWidth: 1, borderColor: '#C9DEE9', borderRadius: 16, padding: 14, marginTop: 2 },
  clinicalNoticeTitle: { color: medicalColors.info, fontSize: 12, lineHeight: 18, fontWeight: '900' },
  clinicalNoticeText: { color: medicalColors.info, fontSize: 10, lineHeight: 17, marginTop: 4 },
});

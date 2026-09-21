import { requireSupabase } from '../lib/supabase';
import type {
  DiagnosticReportRow,
  DiagnosticResultRow,
  MedicalAccessScope,
  MedicalDocumentRow,
  MedicalVisitRow,
  VeterinaryOrganizationRow,
} from '../types/database';

const medicalMediaBucket = 'medical-media';
const medicalDocumentUrlLifetimeSeconds = 5 * 60;

export type MedicalViewerAccess = {
  viewVisit: boolean;
  viewDocument: boolean;
  viewDiagnosticResult: boolean;
};

const ownerAccess: MedicalViewerAccess = {
  viewVisit: true,
  viewDocument: true,
  viewDiagnosticResult: true,
};

export async function getMedicalViewerAccess(input: {
  petId: string;
  ownerId: string;
  currentProfileId: string;
}): Promise<MedicalViewerAccess> {
  if (input.ownerId === input.currentProfileId) return ownerAccess;

  const { data, error } = await requireSupabase()
    .from('medical_access_grants')
    .select('scope, expires_at')
    .eq('pet_id', input.petId)
    .eq('grantee_profile_id', input.currentProfileId)
    .eq('status', 'active')
    .is('revoked_at', null);

  if (error) throw error;

  const now = Date.now();
  const activeScopes = new Set<MedicalAccessScope>();
  data
    .filter((grant) => grant.expires_at == null || Date.parse(grant.expires_at) > now)
    .forEach((grant) => grant.scope.forEach((scope) => activeScopes.add(scope)));

  return {
    viewVisit: activeScopes.has('view_visit'),
    viewDocument: activeScopes.has('view_document'),
    viewDiagnosticResult: activeScopes.has('view_diagnostic_result'),
  };
}

export async function listMedicalVisits(petId: string): Promise<MedicalVisitRow[]> {
  const { data, error } = await requireSupabase()
    .from('medical_visits')
    .select('*')
    .eq('pet_id', petId)
    .in('status', ['published', 'corrected', 'cancelled'])
    .order('occurred_at', { ascending: false });

  if (error) throw error;
  return data;
}

export async function listMedicalDocuments(petId: string): Promise<MedicalDocumentRow[]> {
  const { data, error } = await requireSupabase()
    .from('medical_documents')
    .select('*')
    .eq('pet_id', petId)
    .in('status', ['published', 'superseded'])
    .order('published_at', { ascending: false, nullsFirst: false });

  if (error) throw error;
  return data;
}

export async function listDiagnosticReports(petId: string): Promise<DiagnosticReportRow[]> {
  const { data, error } = await requireSupabase()
    .from('diagnostic_reports')
    .select('*')
    .eq('pet_id', petId)
    .in('status', ['confirmed', 'corrected'])
    .order('reported_at', { ascending: false, nullsFirst: false })
    .order('recorded_at', { ascending: false });

  if (error) throw error;
  return data;
}

export async function listDiagnosticResults(reportIds: string[]): Promise<DiagnosticResultRow[]> {
  if (reportIds.length === 0) return [];

  const { data, error } = await requireSupabase()
    .from('diagnostic_results')
    .select('*')
    .in('report_id', reportIds)
    .order('display_order', { ascending: true })
    .order('id', { ascending: true });

  if (error) throw error;
  return data;
}

export async function listVeterinaryOrganizations(
  organizationIds: string[],
): Promise<VeterinaryOrganizationRow[]> {
  const uniqueIds = [...new Set(organizationIds.filter(Boolean))];
  if (uniqueIds.length === 0) return [];

  const { data, error } = await requireSupabase()
    .from('veterinary_organizations')
    .select('*')
    .in('id', uniqueIds)
    .order('name', { ascending: true });

  if (error) throw error;
  return data;
}

export async function createMedicalDocumentSignedUrl(storagePath: string): Promise<string> {
  const { data, error } = await requireSupabase().storage
    .from(medicalMediaBucket)
    .createSignedUrl(storagePath, medicalDocumentUrlLifetimeSeconds);

  if (error) throw error;
  return data.signedUrl;
}

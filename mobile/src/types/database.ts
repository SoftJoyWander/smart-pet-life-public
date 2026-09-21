export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type CareRecordKind = 'meal' | 'water' | 'medication' | 'stool' | 'urine' | 'vaccine' | 'medical';
export type RecordSource = 'manual' | 'medication_reminder' | 'ai_verification' | 'walk_tracking';
export type MedicationReminderStatus = 'pending' | 'overdue' | 'completed' | 'skipped' | 'cancelled';
export type MedicationDoseUnit = 'mcg' | 'mg' | 'g' | 'ml' | 'tablet' | 'capsule' | 'packet' | 'drop' | 'spray' | 'iu' | 'other';
export type PetMemberRole = 'viewer' | 'editor';
export type PetInvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';
export type PreventiveCareKind = 'deworming' | 'vaccine';
export type MedicalSourceType = 'owner_reported' | 'caregiver_reported' | 'owner_uploaded_unverified' | 'clinic_submitted' | 'veterinarian_reviewed' | 'system_derived' | 'device_measured';
export type OrganizationVerificationStatus = 'pending' | 'verified' | 'suspended' | 'rejected' | 'archived';
export type VeterinaryStaffRole = 'clinic_admin' | 'clinic_staff' | 'veterinarian';
export type VeterinaryStaffStatus = 'invited' | 'active' | 'suspended' | 'revoked';
export type AuthorizationStatus = 'active' | 'expired' | 'revoked';
export type ClinicAuthorizationScope = 'view_records' | 'create_visit' | 'upload_document' | 'write_diagnostic_result';
export type MedicalAccessScope = 'view_visit' | 'view_document' | 'view_diagnostic_result';
export type MedicalVisitStatus = 'draft' | 'published' | 'corrected' | 'cancelled';
export type MedicalDocumentStatus = 'uploading' | 'processing' | 'draft' | 'published' | 'rejected' | 'superseded';
export type DiagnosticReportStatus = 'draft' | 'confirmed' | 'corrected' | 'cancelled';
export type DiagnosticFlag = 'low' | 'high' | 'critical_low' | 'critical_high' | 'abnormal' | 'normal' | 'indeterminate' | 'not_provided';
export type MedicalEntityType = 'medical_visit' | 'medical_document' | 'diagnostic_report' | 'diagnostic_result';
export type StoolAnalysisStatus = 'awaiting_upload' | 'queued' | 'analysing' | 'awaiting_human_review' | 'completed' | 'failed' | 'cancelled' | 'deletion_requested' | 'deleted';
export type StoolPresenceResult = 'present' | 'absent' | 'uncertain' | 'not_assessable';
export type ProfileRow = {
  id: string;
  auth_user_id: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
};

export type PetRow = {
  id: string;
  owner_id: string;
  name: string;
  species: 'dog';
  breed: string;
  sex: 'male' | 'female' | 'unknown';
  sterilization_status: 'sterilized' | 'not_sterilized' | 'unknown';
  birthday: string | null;
  weight_kg: number | null;
  meals_per_day: number;
  water_goal_ml: number;
  avatar_icon: string | null;
  avatar_path: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CareRecordRow = {
  id: string;
  owner_id: string;
  pet_id: string;
  kind: CareRecordKind;
  occurred_at: string;
  source: RecordSource;
  amount: number | null;
  unit: string | null;
  food_type: 'dry' | 'wet' | 'canned' | null;
  medication_name: string | null;
  medication_dose: string | null;
  stool_texture: 'hard' | 'normal' | 'soft' | 'watery' | null;
  stool_color: 'chocolate_brown' | 'black_tarry' | 'fresh_red' | 'yellow_orange' | 'gray_white' | 'green' | null;
  stool_status: 'normal' | 'soft_stool' | 'diarrhea' | 'constipation' | null;
  urine_color: 'unknown' | 'clear' | 'light_yellow' | 'dark_yellow' | 'brown' | 'red' | null;
  title: string | null;
  note: string | null;
  image_path: string | null;
  walk_session_id: string | null;
  recorded_by: string | null;
  client_request_key: string | null;
  recorded_timezone: string | null;
  received_at: string;
  capture_mode: 'online' | 'offline';
  medical_file_paths: string[];
  metadata: Json;
  created_at: string;
  updated_at: string;
};

export type StoolObservationRow = {
  id: string;
  owner_id: string;
  pet_id: string;
  captured_by: string;
  client_request_key: string;
  captured_at: string;
  captured_timezone: string;
  received_at: string;
  capture_method: 'live_camera' | 'gallery_upload';
  media_path: string | null;
  content_type: string | null;
  byte_size: number | null;
  analysis_status: StoolAnalysisStatus;
  owner_visible_result: StoolPresenceResult | null;
  latest_confidence: number | null;
  failure_code: string | null;
  schema_version: string;
  created_at: string;
  updated_at: string;
};

export type WalkSessionRow = {
  id: string;
  owner_id: string;
  pet_id: string;
  recorded_by: string;
  client_request_key: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  distance_m: number;
  average_speed_mps: number;
  weight_kg_snapshot: number | null;
  energy_kcal_low: number | null;
  energy_kcal_high: number | null;
  energy_model_version: string | null;
  stool_count: number;
  urine_count: number;
  created_at: string;
};

export type MedicationPlanRow = {
  id: string;
  owner_id: string;
  pet_id: string;
  title: string;
  dose: string;
  dose_amount: number | null;
  dose_unit: MedicationDoseUnit | null;
  times: string[];
  start_date: string;
  end_date: string;
  instruction: string | null;
  timezone: string;
  client_request_key: string | null;
  note: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type MedicationReminderRow = {
  id: string;
  owner_id: string;
  pet_id: string;
  medication_plan_id: string;
  scheduled_at: string;
  status: MedicationReminderStatus;
  completed_at: string | null;
  administered_at: string | null;
  overdue_at: string | null;
  skipped_at: string | null;
  resolved_by: string | null;
  care_record_id: string | null;
  created_at: string;
  updated_at: string;
};

export type PetMembershipRow = {
  id: string;
  pet_id: string;
  owner_id: string;
  user_id: string;
  member_email: string | null;
  role: PetMemberRole;
  invited_by: string;
  created_at: string;
  updated_at: string;
};

export type PetInvitationRow = {
  id: string;
  invite_code: string;
  pet_id: string;
  owner_id: string;
  invited_email: string;
  role: PetMemberRole;
  status: PetInvitationStatus;
  invited_by: string;
  accepted_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PreventiveCareScheduleRow = {
  id: string;
  owner_id: string;
  pet_id: string;
  kind: PreventiveCareKind;
  title: string;
  interval_months: number;
  last_completed_on: string;
  next_due_on: string;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type VeterinaryOrganizationRow = {
  id: string;
  name: string;
  region: string;
  verification_status: OrganizationVerificationStatus;
  verified_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type VeterinaryStaffRow = {
  id: string;
  organization_id: string;
  profile_id: string;
  role: VeterinaryStaffRole;
  status: VeterinaryStaffStatus;
  activated_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PetClinicAuthorizationRow = {
  id: string;
  owner_id: string;
  pet_id: string;
  organization_id: string;
  scope: ClinicAuthorizationScope[];
  status: AuthorizationStatus;
  policy_version: string;
  locale: string;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MedicalAccessGrantRow = {
  id: string;
  owner_id: string;
  pet_id: string;
  grantee_profile_id: string;
  scope: MedicalAccessScope[];
  status: AuthorizationStatus;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MedicalVisitRow = {
  id: string;
  owner_id: string;
  pet_id: string;
  organization_id: string | null;
  occurred_at: string;
  recorded_at: string;
  received_at: string;
  timezone: string;
  source_type: MedicalSourceType;
  status: MedicalVisitStatus;
  title: string;
  summary: string | null;
  created_by_profile_id: string | null;
  created_by_staff_id: string | null;
  reviewed_by_staff_id: string | null;
  reviewed_at: string | null;
  schema_version: number;
  supersedes_id: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MedicalDocumentRow = {
  id: string;
  visit_id: string;
  owner_id: string;
  pet_id: string;
  organization_id: string | null;
  document_type: string;
  storage_path: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string | null;
  source_type: MedicalSourceType;
  status: MedicalDocumentStatus;
  version: number;
  supersedes_id: string | null;
  uploaded_by_profile_id: string | null;
  uploaded_by_staff_id: string | null;
  recorded_at: string;
  received_at: string;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DiagnosticReportRow = {
  id: string;
  visit_id: string;
  document_id: string | null;
  owner_id: string;
  pet_id: string;
  organization_id: string | null;
  report_type: string;
  collected_at: string | null;
  reported_at: string | null;
  recorded_at: string;
  timezone: string;
  source_type: MedicalSourceType;
  status: DiagnosticReportStatus;
  created_by_profile_id: string | null;
  created_by_staff_id: string | null;
  confirmed_by_staff_id: string | null;
  confirmed_at: string | null;
  schema_version: number;
  supersedes_id: string | null;
  created_at: string;
  updated_at: string;
};

export type DiagnosticResultRow = {
  id: string;
  report_id: string;
  owner_id: string;
  pet_id: string;
  organization_id: string | null;
  item_code: string | null;
  item_name: string;
  value_numeric: number | null;
  value_text: string | null;
  original_unit: string | null;
  canonical_value: number | null;
  canonical_unit: string | null;
  reference_low: number | null;
  reference_high: number | null;
  reference_text: string | null;
  flag: DiagnosticFlag;
  method: string | null;
  specimen: string | null;
  display_order: number;
  created_by_profile_id: string | null;
  created_by_staff_id: string | null;
  created_at: string;
  updated_at: string;
};

export type MedicalRecordVersionRow = {
  id: string;
  owner_id: string;
  pet_id: string;
  organization_id: string | null;
  entity_type: MedicalEntityType;
  entity_id: string;
  version: number;
  snapshot: Json;
  changed_by_profile_id: string | null;
  changed_by_staff_id: string | null;
  change_reason: string | null;
  created_at: string;
};

type Insertable<T, Optional extends keyof T> = Omit<T, Optional> & Partial<Pick<T, Optional>>;

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: ProfileRow;
        Insert: Insertable<ProfileRow, 'id' | 'created_at' | 'updated_at' | 'display_name'>;
        Update: Partial<ProfileRow>;
        Relationships: [];
      };
      pets: {
        Row: PetRow;
        Insert: Insertable<PetRow, 'id' | 'species' | 'sterilization_status' | 'birthday' | 'weight_kg' | 'meals_per_day' | 'water_goal_ml' | 'avatar_icon' | 'avatar_path' | 'archived_at' | 'created_at' | 'updated_at'>;
        Update: Partial<PetRow>;
        Relationships: [];
      };
      care_records: {
        Row: CareRecordRow;
        Insert: Insertable<CareRecordRow, 'id' | 'occurred_at' | 'source' | 'amount' | 'unit' | 'food_type' | 'medication_name' | 'medication_dose' | 'stool_texture' | 'stool_color' | 'stool_status' | 'urine_color' | 'title' | 'note' | 'image_path' | 'walk_session_id' | 'recorded_by' | 'client_request_key' | 'recorded_timezone' | 'received_at' | 'capture_mode' | 'medical_file_paths' | 'metadata' | 'created_at' | 'updated_at'>;
        Update: Partial<CareRecordRow>;
        Relationships: [];
      };
      stool_observations: {
        Row: StoolObservationRow;
        Insert: Insertable<StoolObservationRow, 'id' | 'received_at' | 'capture_method' | 'media_path' | 'content_type' | 'byte_size' | 'analysis_status' | 'owner_visible_result' | 'latest_confidence' | 'failure_code' | 'schema_version' | 'created_at' | 'updated_at'>;
        Update: Partial<StoolObservationRow>;
        Relationships: [];
      };
      walk_sessions: {
        Row: WalkSessionRow;
        Insert: Insertable<WalkSessionRow, 'id' | 'average_speed_mps' | 'weight_kg_snapshot' | 'energy_kcal_low' | 'energy_kcal_high' | 'energy_model_version' | 'stool_count' | 'urine_count' | 'created_at'>;
        Update: Partial<WalkSessionRow>;
        Relationships: [];
      };
      medication_plans: {
        Row: MedicationPlanRow;
        Insert: Insertable<MedicationPlanRow, 'id' | 'dose_amount' | 'dose_unit' | 'instruction' | 'note' | 'timezone' | 'client_request_key' | 'is_active' | 'created_at' | 'updated_at'>;
        Update: Partial<MedicationPlanRow>;
        Relationships: [];
      };
      medication_reminders: {
        Row: MedicationReminderRow;
        Insert: Insertable<MedicationReminderRow, 'id' | 'status' | 'completed_at' | 'administered_at' | 'overdue_at' | 'skipped_at' | 'resolved_by' | 'care_record_id' | 'created_at' | 'updated_at'>;
        Update: Partial<MedicationReminderRow>;
        Relationships: [];
      };
      pet_memberships: {
        Row: PetMembershipRow;
        Insert: Insertable<PetMembershipRow, 'id' | 'member_email' | 'role' | 'created_at' | 'updated_at'>;
        Update: Partial<PetMembershipRow>;
        Relationships: [];
      };
      pet_invitations: {
        Row: PetInvitationRow;
        Insert: Insertable<PetInvitationRow, 'id' | 'invite_code' | 'role' | 'status' | 'accepted_by' | 'expires_at' | 'accepted_at' | 'created_at' | 'updated_at'>;
        Update: Partial<PetInvitationRow>;
        Relationships: [];
      };
      preventive_care_schedules: {
        Row: PreventiveCareScheduleRow;
        Insert: Insertable<PreventiveCareScheduleRow, 'id' | 'note' | 'created_at' | 'updated_at'>;
        Update: Partial<PreventiveCareScheduleRow>;
        Relationships: [];
      };
      veterinary_organizations: {
        Row: VeterinaryOrganizationRow;
        Insert: Insertable<VeterinaryOrganizationRow, 'id' | 'verification_status' | 'verified_at' | 'archived_at' | 'created_at' | 'updated_at'>;
        Update: Partial<VeterinaryOrganizationRow>;
        Relationships: [];
      };
      veterinary_staff: {
        Row: VeterinaryStaffRow;
        Insert: Insertable<VeterinaryStaffRow, 'id' | 'status' | 'activated_at' | 'revoked_at' | 'created_at' | 'updated_at'>;
        Update: Partial<VeterinaryStaffRow>;
        Relationships: [];
      };
      pet_clinic_authorizations: {
        Row: PetClinicAuthorizationRow;
        Insert: Insertable<PetClinicAuthorizationRow, 'id' | 'status' | 'locale' | 'granted_at' | 'expires_at' | 'revoked_at' | 'created_at' | 'updated_at'>;
        Update: Partial<PetClinicAuthorizationRow>;
        Relationships: [];
      };
      medical_access_grants: {
        Row: MedicalAccessGrantRow;
        Insert: Insertable<MedicalAccessGrantRow, 'id' | 'status' | 'granted_at' | 'expires_at' | 'revoked_at' | 'created_at' | 'updated_at'>;
        Update: Partial<MedicalAccessGrantRow>;
        Relationships: [];
      };
      medical_visits: {
        Row: MedicalVisitRow;
        Insert: Insertable<MedicalVisitRow, 'id' | 'organization_id' | 'recorded_at' | 'received_at' | 'timezone' | 'status' | 'summary' | 'created_by_profile_id' | 'created_by_staff_id' | 'reviewed_by_staff_id' | 'reviewed_at' | 'schema_version' | 'supersedes_id' | 'published_at' | 'created_at' | 'updated_at'>;
        Update: Partial<MedicalVisitRow>;
        Relationships: [];
      };
      medical_documents: {
        Row: MedicalDocumentRow;
        Insert: Insertable<MedicalDocumentRow, 'id' | 'owner_id' | 'pet_id' | 'organization_id' | 'storage_path' | 'sha256' | 'status' | 'version' | 'supersedes_id' | 'uploaded_by_profile_id' | 'uploaded_by_staff_id' | 'recorded_at' | 'received_at' | 'published_at' | 'created_at' | 'updated_at'>;
        Update: Partial<MedicalDocumentRow>;
        Relationships: [];
      };
      diagnostic_reports: {
        Row: DiagnosticReportRow;
        Insert: Insertable<DiagnosticReportRow, 'id' | 'document_id' | 'owner_id' | 'pet_id' | 'organization_id' | 'collected_at' | 'reported_at' | 'recorded_at' | 'timezone' | 'status' | 'created_by_profile_id' | 'created_by_staff_id' | 'confirmed_by_staff_id' | 'confirmed_at' | 'schema_version' | 'supersedes_id' | 'created_at' | 'updated_at'>;
        Update: Partial<DiagnosticReportRow>;
        Relationships: [];
      };
      diagnostic_results: {
        Row: DiagnosticResultRow;
        Insert: Insertable<DiagnosticResultRow, 'id' | 'owner_id' | 'pet_id' | 'organization_id' | 'item_code' | 'value_numeric' | 'value_text' | 'original_unit' | 'canonical_value' | 'canonical_unit' | 'reference_low' | 'reference_high' | 'reference_text' | 'flag' | 'method' | 'specimen' | 'display_order' | 'created_by_profile_id' | 'created_by_staff_id' | 'created_at' | 'updated_at'>;
        Update: Partial<DiagnosticResultRow>;
        Relationships: [];
      };
      medical_record_versions: {
        Row: MedicalRecordVersionRow;
        Insert: Insertable<MedicalRecordVersionRow, 'id' | 'organization_id' | 'changed_by_profile_id' | 'changed_by_staff_id' | 'change_reason' | 'created_at'>;
        Update: Partial<MedicalRecordVersionRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      create_stool_observation: {
        Args: { stool_pet_id: string; stool_client_request_key: string; stool_captured_at: string; stool_captured_timezone: string; stool_capture_method?: 'live_camera' | 'gallery_upload' };
        Returns: StoolObservationRow;
      };
      queue_stool_observation_analysis: {
        Args: { stool_observation_id: string; stool_media_path: string; stool_content_type: string; stool_byte_size: number };
        Returns: StoolObservationRow;
      };
      begin_stool_observation_analysis: {
        Args: { stool_observation_id: string };
        Returns: StoolObservationRow;
      };
      accept_pet_invitation: {
        Args: { invitation_id: string };
        Returns: PetMembershipRow;
      };
      accept_pet_invitation_code: {
        Args: { join_code: string };
        Returns: PetMembershipRow;
      };
      complete_preventive_care: {
        Args: { schedule_id: string };
        Returns: PreventiveCareScheduleRow;
      };
      sync_offline_care_record: {
        Args: {
          offline_pet_id: string;
          offline_client_request_key: string;
          offline_occurred_at: string;
          offline_timezone: string;
          offline_kind: CareRecordKind;
          offline_title: string;
          offline_note: string | null;
          offline_amount: number | null;
          offline_unit: string | null;
          offline_food_type: string | null;
          offline_stool_texture: string | null;
          offline_stool_color: string | null;
          offline_stool_status: string | null;
          offline_urine_color: string | null;
          offline_metadata: Json;
        };
        Returns: CareRecordRow;
      };
      complete_walk_session: {
        Args: {
          walk_pet_id: string;
          walk_client_request_key: string;
          walk_lease_token: string;
          walk_started_at: string;
          walk_ended_at: string;
          walk_duration_seconds: number;
          walk_distance_m: number;
          walk_weight_kg_snapshot?: number | null;
          walk_energy_kcal_low?: number | null;
          walk_energy_kcal_high?: number | null;
          walk_energy_model_version?: string | null;
          walk_stool_times?: string[];
          walk_urine_times?: string[];
        };
        Returns: WalkSessionRow;
      };
      begin_walk_session: {
        Args: { walk_pet_id: string; walk_client_request_key: string };
        Returns: Json;
      };
      heartbeat_walk_session: {
        Args: { walk_pet_id: string; walk_client_request_key: string; walk_lease_token: string };
        Returns: Json;
      };
      abandon_walk_session: {
        Args: { walk_pet_id: string; walk_client_request_key: string; walk_lease_token: string };
        Returns: boolean;
      };
      create_medication_plan_with_reminders: {
        Args: {
          plan_owner_id: string;
          plan_pet_id: string;
          plan_title: string;
          plan_dose: string;
          plan_dose_amount: number;
          plan_dose_unit: MedicationDoseUnit;
          plan_times: string[];
          plan_start_date: string;
          plan_end_date: string;
          plan_instruction?: string | null;
          plan_note?: string | null;
          plan_timezone?: string;
          plan_request_key?: string | null;
        };
        Returns: MedicationPlanRow;
      };
      sync_medication_plan_reminders: { Args: { target_plan_id: string }; Returns: undefined };
      refresh_medication_reminders: { Args: { target_pet_id: string }; Returns: MedicationReminderRow[] };
      complete_medication_reminder: { Args: { reminder_id: string; actual_administered_at?: string }; Returns: MedicationReminderRow };
      resolve_missed_medication_reminder: { Args: { reminder_id: string; was_administered: boolean; actual_administered_at?: string }; Returns: MedicationReminderRow };
    };
    Enums: {
      care_record_kind: CareRecordKind;
      record_source: RecordSource;
      medication_reminder_status: MedicationReminderStatus;
      pet_member_role: PetMemberRole;
      pet_invitation_status: PetInvitationStatus;
      preventive_care_kind: PreventiveCareKind;
      medical_source_type: MedicalSourceType;
      organization_verification_status: OrganizationVerificationStatus;
      veterinary_staff_role: VeterinaryStaffRole;
      veterinary_staff_status: VeterinaryStaffStatus;
      authorization_status: AuthorizationStatus;
      clinic_authorization_scope: ClinicAuthorizationScope;
      medical_access_scope: MedicalAccessScope;
      medical_visit_status: MedicalVisitStatus;
      medical_document_status: MedicalDocumentStatus;
      diagnostic_report_status: DiagnosticReportStatus;
      diagnostic_flag: DiagnosticFlag;
      medical_entity_type: MedicalEntityType;
    };
    CompositeTypes: Record<string, never>;
  };
};

function envFlag(value: string | undefined, defaultValue: boolean) {
  if (value == null || value.trim() === '') return defaultValue;
  return !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
}

export const featureFlags = {
  recordsTab: envFlag(process.env.EXPO_PUBLIC_ENABLE_RECORDS_TAB, true),
  medicalTab: envFlag(process.env.EXPO_PUBLIC_ENABLE_MEDICAL_TAB, true),
  stoolGalleryUpload: envFlag(process.env.EXPO_PUBLIC_ENABLE_STOOL_GALLERY_UPLOAD, true),
  stoolExperiment: envFlag(process.env.EXPO_PUBLIC_ENABLE_STOOL_EXPERIMENT, true),
  stoolReviewer: envFlag(process.env.EXPO_PUBLIC_ENABLE_STOOL_REVIEWER, true),
} as const;

export const layoutTokens = {
  contentMaxWidth: 520,
  dialogMaxWidth: 360,
  compactPhoneMaxWidth: 359,
  minimumTouchSize: 48,
} as const;

export function isCompactPhone(width: number) {
  return width <= layoutTokens.compactPhoneMaxWidth;
}

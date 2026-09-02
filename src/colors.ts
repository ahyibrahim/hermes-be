export const USER_COLOR_PALETTE = [
  'ember',
  'moss',
  'lake',
  'plum',
  'rust',
  'teal',
  'gold',
  'indigo',
  'rose',
  'slate',
] as const;

export type UserColor = (typeof USER_COLOR_PALETTE)[number];

export function isUserColor(value: string): value is UserColor {
  return (USER_COLOR_PALETTE as readonly string[]).includes(value);
}

export function isoTimestamp(value = new Date()): string {
  return value.toISOString();
}

export function toIsoTimestamp(value: string | null | undefined): string {
  if (!value) {
    return isoTimestamp();
  }
  if (value.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(value)) {
    const parsed = new Date(value.includes('T') ? value : value.replace(' ', 'T'));
    return Number.isNaN(parsed.getTime()) ? isoTimestamp() : parsed.toISOString();
  }
  const naive = value.includes('T') ? value : value.replace(' ', 'T');
  const parsed = new Date(`${naive}Z`);
  return Number.isNaN(parsed.getTime()) ? isoTimestamp() : parsed.toISOString();
}

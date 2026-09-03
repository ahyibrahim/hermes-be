export const SYSTEM_USERNAME = 'hermes';
export const SYSTEM_PASSWORD_PLACEHOLDER = '!';

export function isSystemUsername(name: string): boolean {
  return name.trim().toLowerCase() === SYSTEM_USERNAME;
}

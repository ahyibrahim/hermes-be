/** New usernames and renames. Existing names are left as they are. */
export const USERNAME_PATTERN = /^[a-z0-9_]{2,24}$/;

export function isUsername(value: string): boolean {
  return USERNAME_PATTERN.test(value);
}

/** C0, DEL and C1. Newlines and tabs are controls too. */
export function hasControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/** Message text may contain tab and newline. Every other control is rejected. */
export function messageHasForbiddenControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x09 || code === 0x0a) {
      continue;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

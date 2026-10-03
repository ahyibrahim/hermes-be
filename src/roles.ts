export const USER_ROLES = ['guest', 'member', 'admin', 'master'] as const;

export type UserRole = (typeof USER_ROLES)[number];

const RANK: Record<UserRole, number> = {
  guest: 0,
  member: 1,
  admin: 2,
  master: 3,
};

export function isUserRole(value: string): value is UserRole {
  return Object.prototype.hasOwnProperty.call(RANK, value);
}

/** Unknown roles rank as guest so a new name fails closed. */
export function roleRank(role: string | null | undefined): number {
  if (role && isUserRole(role)) {
    return RANK[role];
  }
  return RANK.guest;
}

export function roleAtLeast(role: string | null | undefined, floor: UserRole): boolean {
  return roleRank(role) >= RANK[floor];
}

export function outranks(actor: string | null | undefined, target: string | null | undefined): boolean {
  return roleRank(actor) > roleRank(target);
}

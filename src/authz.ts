import type { UserRole } from './auth';

/**
 * Single authorization helper for moderation (v0.19) and reserved watch
 * actions (v0.20). Endpoints call `can()` instead of ad-hoc role checks.
 *
 * Watch actions default to admin until a session host exists; v0.20 will
 * pass `isWatchHost` so the host shares control without inventing new roles.
 */
export type AuthzAction =
  | 'role.set'
  | 'room.kick'
  | 'room.delete'
  | 'message.admin_delete'
  | 'user.password_reset'
  | 'watch.start'
  | 'watch.play_pause'
  | 'watch.seek'
  | 'watch.end';

export type AuthzActor = {
  id: number;
  role: UserRole;
  system?: boolean;
};

export type AuthzRoom = {
  slug: string;
  type: 'group' | 'dm';
  creator_id?: number | null;
};

export type AuthzContext = {
  room?: AuthzRoom;
  /** True when the actor hosts the active watch session (v0.20). */
  isWatchHost?: boolean;
};

export function can(actor: AuthzActor, action: AuthzAction, context: AuthzContext = {}): boolean {
  if (actor.system) {
    return false;
  }

  switch (action) {
    case 'role.set':
    case 'message.admin_delete':
    case 'user.password_reset':
      return actor.role === 'admin';

    case 'room.kick':
    case 'room.delete': {
      const room = context.room;
      if (!room || room.type !== 'group' || room.slug === 'general') {
        return false;
      }
      if (actor.role === 'admin') {
        return true;
      }
      return room.creator_id != null && room.creator_id === actor.id;
    }

    case 'watch.start':
    case 'watch.play_pause':
    case 'watch.seek':
    case 'watch.end':
      return actor.role === 'admin' || Boolean(context.isWatchHost);

    default:
      return false;
  }
}

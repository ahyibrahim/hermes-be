import type { SessionScope } from './sessions';
import { outranks, roleAtLeast, type UserRole } from './roles';

/**
 * Single authorization helper. Endpoints call `can()` instead of ad-hoc role
 * checks. Rank is master, admin, member, guest. A guest session scope fails
 * closed on every action, including when the account itself outranks guest.
 */
export type AuthzAction =
  | 'role.set'
  | 'room.kick'
  | 'room.delete'
  | 'room.add_member'
  | 'dm.create'
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
  /** Omitted means a member-scoped session. */
  scope?: SessionScope;
};

export type AuthzRoom = {
  slug: string;
  type: 'group' | 'dm';
  creator_id?: number | null;
};

export type AuthzContext = {
  room?: AuthzRoom;
  /** Whether the actor is currently a member of `room`. */
  actorIsMember?: boolean;
  /** The user a kick, reset, or role change would affect. */
  target?: AuthzActor;
  /** Role `role.set` would write. Only `member` and `admin` are writable. */
  nextRole?: 'member' | 'admin';
  /** True when the actor hosts the active watch session. */
  isWatchHost?: boolean;
};

export function can(actor: AuthzActor, action: AuthzAction, context: AuthzContext = {}): boolean {
  if (actor.system || actor.scope === 'guest') {
    return false;
  }

  switch (action) {
    case 'room.add_member':
    case 'dm.create':
      return roleAtLeast(actor.role, 'member');

    case 'role.set': {
      if (!roleAtLeast(actor.role, 'admin') || !context.target || context.target.system) {
        return false;
      }
      if (context.target.role === 'master' || !outranks(actor.role, context.target.role)) {
        return false;
      }
      if (!context.nextRole) {
        return true;
      }
      return outranks(actor.role, context.nextRole);
    }

    case 'user.password_reset': {
      if (!roleAtLeast(actor.role, 'admin') || !context.target || context.target.system) {
        return false;
      }
      if (context.target.role === 'master') {
        return false;
      }
      return outranks(actor.role, context.target.role);
    }

    case 'message.admin_delete':
      return roleAtLeast(actor.role, 'admin');

    case 'room.kick':
    case 'room.delete': {
      const room = context.room;
      if (!room || room.type !== 'group' || room.slug === 'general') {
        return false;
      }
      if (action === 'room.kick' && context.target?.role === 'master') {
        return false;
      }
      if (roleAtLeast(actor.role, 'admin')) {
        return true;
      }
      // A creator moderates only while still in the room, and never admins or master.
      if (room.creator_id == null || room.creator_id !== actor.id || context.actorIsMember !== true) {
        return false;
      }
      if (action === 'room.delete') {
        return true;
      }
      return !roleAtLeast(context.target?.role, 'admin');
    }

    case 'watch.start':
      return roleAtLeast(actor.role, 'member');

    case 'watch.play_pause':
    case 'watch.seek':
    case 'watch.end':
      if (!roleAtLeast(actor.role, 'member')) {
        return false;
      }
      return roleAtLeast(actor.role, 'admin') || Boolean(context.isWatchHost);

    default:
      return false;
  }
}

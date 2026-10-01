import { addUserToGeneralRoom, getUserByUsername } from './rooms';

/** Puts already-registered accounts into #general, the way members from before v0.30 already are. */
export function seatInGeneral(...names: string[]): void {
  for (const name of names) {
    const user = getUserByUsername(name.trim().toLowerCase());
    if (!user) {
      throw new Error(`no user ${name}`);
    }
    addUserToGeneralRoom(user.id);
  }
}

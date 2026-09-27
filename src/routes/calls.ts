import { FastifyInstance } from 'fastify';
import { createMessage } from '../db';
import { SYSTEM_USERNAME } from '../system-user';
import {
  DEFAULT_CALL_ALONE_TIMEOUT_MS,
  DEFAULT_WATCH_ALONE_TIMEOUT_MS,
  DEFAULT_TYPING_TIMEOUT_MS,
  TrackedSocket,
  WatchSession,
} from './common';

export type CallManagerOptions = {
  callAloneTimeoutMs?: number;
  watchAloneTimeoutMs?: number;
  typingTimeoutMs?: number;
};

export function createCallState(fastify: FastifyInstance, options: CallManagerOptions = {}) {
  const callAloneTimeoutMs = options.callAloneTimeoutMs ?? DEFAULT_CALL_ALONE_TIMEOUT_MS;
  const watchAloneTimeoutMs = options.watchAloneTimeoutMs ?? DEFAULT_WATCH_ALONE_TIMEOUT_MS;
  const typingTimeoutMs = options.typingTimeoutMs ?? DEFAULT_TYPING_TIMEOUT_MS;

  const callMembers = new Map<string, Set<string>>();
  const callSharing = new Map<string, string>();
  const watchSessions = new Map<string, WatchSession>();
  const callAloneTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const watchAloneTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const typingTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();

  let sendToUserFn: (username: string, payload: unknown) => void = () => {};
  let broadcastToMembersFn: (room: string, payload: unknown, exceptUser?: string) => void = () => {};

  function setBroadcastHelpers(
    sendToUser: (username: string, payload: unknown) => void,
    broadcastToMembers: (room: string, payload: unknown, exceptUser?: string) => void
  ) {
    sendToUserFn = sendToUser;
    broadcastToMembersFn = broadcastToMembers;
  }

  function clearCallAloneTimer(room: string): void {
    const timer = callAloneTimers.get(room);
    if (timer) {
      clearTimeout(timer);
      callAloneTimers.delete(room);
    }
  }

  function touchCallAloneTimer(room: string): void {
    clearCallAloneTimer(room);
    const members = callMembers.get(room);
    if (!members || members.size !== 1) {
      return;
    }
    const alone = [...members][0];
    callAloneTimers.set(
      room,
      setTimeout(() => {
        callAloneTimers.delete(room);
        const current = callMembers.get(room);
        if (!current || current.size !== 1 || !current.has(alone)) {
          return;
        }
        removeFromCall(room, alone, true);
        fastify.log.info(
          { event: 'call_alone_timeout', user: alone, room },
          'ended alone call after timeout'
        );
      }, callAloneTimeoutMs)
    );
  }

  function clearWatchAloneTimer(room: string): void {
    const timer = watchAloneTimers.get(room);
    if (timer) {
      clearTimeout(timer);
      watchAloneTimers.delete(room);
    }
  }

  function touchWatchAloneTimer(room: string): void {
    clearWatchAloneTimer(room);
    const session = watchSessions.get(room);
    if (!session || session.participants.size !== 1) {
      return;
    }
    const alone = [...session.participants][0];
    watchAloneTimers.set(
      room,
      setTimeout(() => {
        watchAloneTimers.delete(room);
        const current = watchSessions.get(room);
        if (!current || current.participants.size !== 1 || !current.participants.has(alone)) {
          return;
        }
        endWatchSession(room, alone);
        fastify.log.info(
          { event: 'watch_alone_timeout', user: alone, room },
          'ended alone watch after timeout'
        );
      }, watchAloneTimeoutMs)
    );
  }

  function clearTypingTimer(room: string, username: string): void {
    const byUser = typingTimers.get(room);
    const timer = byUser?.get(username);
    if (!byUser || !timer) {
      return;
    }
    clearTimeout(timer);
    byUser.delete(username);
    if (byUser.size === 0) {
      typingTimers.delete(room);
    }
  }

  function stopTyping(room: string, username: string, broadcast = true): void {
    const byUser = typingTimers.get(room);
    if (!byUser?.has(username)) {
      return;
    }
    clearTypingTimer(room, username);
    if (broadcast) {
      broadcastToMembersFn(room, { type: 'typing', room, user: username, active: false }, username);
    }
  }

  function touchTyping(room: string, username: string): void {
    const byUser = typingTimers.get(room) ?? new Map<string, ReturnType<typeof setTimeout>>();
    if (!typingTimers.has(room)) {
      typingTimers.set(room, byUser);
    }
    const wasTyping = byUser.has(username);
    const existing = byUser.get(username);
    if (existing) {
      clearTimeout(existing);
    }
    byUser.set(
      username,
      setTimeout(() => {
        const roomTypers = typingTimers.get(room);
        roomTypers?.delete(username);
        if (roomTypers && roomTypers.size === 0) {
          typingTimers.delete(room);
        }
        broadcastToMembersFn(room, { type: 'typing', room, user: username, active: false }, username);
      }, typingTimeoutMs)
    );
    if (!wasTyping) {
      broadcastToMembersFn(room, { type: 'typing', room, user: username, active: true }, username);
    }
  }

  function clearTypingForUser(username: string): void {
    for (const [room, byUser] of [...typingTimers.entries()]) {
      if (byUser.has(username)) {
        stopTyping(room, username);
      }
    }
  }

  function callRoster(room: string): string[] {
    const members = callMembers.get(room);
    if (!members) {
      return [];
    }
    return [...members].sort((a, b) => a.localeCompare(b));
  }

  function callSharingUser(room: string): string | null {
    return callSharing.get(room) ?? null;
  }

  function releaseShare(room: string, username: string): void {
    if (callSharing.get(room) !== username) {
      return;
    }
    callSharing.delete(room);
    broadcastCall(room, { type: 'screen_share_stopped', room, user: username });
  }

  function broadcastCall(room: string, payload: unknown, exceptUser?: string): void {
    const members = callMembers.get(room);
    if (!members) {
      return;
    }

    for (const name of members) {
      if (exceptUser && name === exceptUser) {
        continue;
      }
      sendToUserFn(name, payload);
    }
  }

  function removeFromCall(room: string, username: string, notifyLeaver: boolean): void {
    const members = callMembers.get(room);
    if (!members?.has(username)) {
      return;
    }

    members.delete(username);
    releaseShare(room, username);
    if (members.size === 0) {
      callMembers.delete(room);
      callSharing.delete(room);
      clearCallAloneTimer(room);
    } else {
      touchCallAloneTimer(room);
    }

    broadcastCall(room, { type: 'user_left_call', room, user: username });
    if (notifyLeaver) {
      sendToUserFn(username, { type: 'left_call', room });
    }
  }

  function leaveAllCalls(username: string): void {
    for (const room of [...callMembers.keys()]) {
      removeFromCall(room, username, false);
    }
  }

  function livePosition(s: WatchSession): number {
    const pos = s.playing
      ? s.position + ((Date.now() - s.updatedAt) / 1000) * s.rate
      : s.position;
    return Math.max(0, pos);
  }

  function watchSnapshot(s: WatchSession) {
    return {
      room: s.room,
      provider: s.provider,
      videoId: s.videoId,
      url: s.url,
      host: s.host,
      playing: s.playing,
      position: livePosition(s),
      rate: s.rate,
      updatedAt: Date.now(),
      users: [...s.participants].sort((a, b) => a.localeCompare(b)),
    };
  }

  function watchPeersPayload(s: WatchSession) {
    return {
      type: 'watch_peers' as const,
      room: s.room,
      users: [...s.participants].sort((a, b) => a.localeCompare(b)),
      host: s.host,
    };
  }

  function broadcastWatch(room: string, payload: unknown, exceptUser?: string): void {
    const session = watchSessions.get(room);
    if (!session) {
      return;
    }

    for (const name of session.participants) {
      if (exceptUser && name === exceptUser) {
        continue;
      }
      sendToUserFn(name, payload);
    }
  }

  function postWatchSystemLine(room: string, content: string): void {
    const message = createMessage(room, SYSTEM_USERNAME, content);
    broadcastToMembersFn(room, { type: 'message', message });
  }

  function endWatchSession(room: string, endedBy: string): void {
    if (!watchSessions.has(room)) {
      return;
    }
    clearWatchAloneTimer(room);
    watchSessions.delete(room);
    broadcastToMembersFn(room, { type: 'watch_ended', room, user: endedBy });
    postWatchSystemLine(room, 'Watch together ended');
    fastify.log.info({ event: 'watch_end', user: endedBy, room }, 'ended watch session');
  }

  function removeFromWatch(room: string, username: string, notifyLeaver: boolean): void {
    const session = watchSessions.get(room);
    if (!session?.participants.has(username)) {
      return;
    }

    session.participants.delete(username);
    if (notifyLeaver) {
      sendToUserFn(username, { type: 'left_watch', room });
    }
    broadcastWatch(room, watchPeersPayload(session));
    touchWatchAloneTimer(room);
  }

  function leaveAllWatches(username: string): void {
    for (const [room, session] of [...watchSessions.entries()]) {
      if (session.host === username) {
        endWatchSession(room, username);
      }
    }
    for (const room of [...watchSessions.keys()]) {
      removeFromWatch(room, username, false);
    }
  }

  return {
    callMembers,
    callSharing,
    watchSessions,
    callAloneTimeoutMs,
    watchAloneTimeoutMs,
    typingTimeoutMs,
    setBroadcastHelpers,
    clearCallAloneTimer,
    touchCallAloneTimer,
    clearWatchAloneTimer,
    touchWatchAloneTimer,
    stopTyping,
    touchTyping,
    clearTypingForUser,
    callRoster,
    callSharingUser,
    releaseShare,
    broadcastCall,
    removeFromCall,
    leaveAllCalls,
    livePosition,
    watchSnapshot,
    watchPeersPayload,
    broadcastWatch,
    postWatchSystemLine,
    endWatchSession,
    removeFromWatch,
    leaveAllWatches,
  };
}


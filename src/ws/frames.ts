import { z } from 'zod';

const room = z.string().trim().min(1).max(512);
const peer = z.string().trim().min(1).max(64);

const sdp = z.object({
  type: z.enum(['offer', 'answer', 'pranswer', 'rollback']),
  sdp: z.string().max(200_000).optional(),
});

const candidate = z.object({
  candidate: z.string().max(4096).optional(),
  sdpMid: z.string().max(128).nullable().optional(),
  sdpMLineIndex: z.number().finite().nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});

export const wsFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('join_room'),
    room,
    token: z.string().max(512).optional(),
  }),
  z.object({
    type: z.literal('send_message'),
    room: room.optional(),
    content: z.string().max(16_000).optional(),
  }),
  z.object({ type: z.literal('join_call'), room }),
  z.object({ type: z.literal('screen_share_start'), room, user: peer.optional() }),
  z.object({ type: z.literal('screen_share_stop'), room }),
  z.object({ type: z.literal('leave_call'), room }),
  z.object({ type: z.literal('call_offer'), room, to: peer, sdp }),
  z.object({ type: z.literal('call_answer'), room, to: peer, sdp }),
  z.object({
    type: z.literal('ice_candidate'),
    room,
    to: peer,
    candidate: candidate.nullable().optional(),
  }),
  z.object({
    type: z.literal('watch_start'),
    room,
    url: z.string().max(2048).optional(),
  }),
  z.object({ type: z.literal('watch_join'), room }),
  z.object({ type: z.literal('watch_leave'), room }),
  z.object({
    type: z.literal('watch_control'),
    room,
    action: z.string().max(32).optional(),
    position: z.number().finite().optional(),
    rate: z.number().finite().optional(),
  }),
  z.object({ type: z.literal('watch_end'), room }),
  z.object({ type: z.literal('typing'), room, active: z.boolean().optional() }),
]);

/** The handler still branches on `type`; the schema has already checked the shape. */
export type LooseWsFrame = {
  type: string;
  room?: string;
  to?: string;
  token?: string;
  user?: string;
  content?: string;
  url?: string;
  action?: string;
  position?: number;
  rate?: number;
  active?: boolean;
  sdp?: { type?: string; sdp?: string };
  candidate?: unknown;
};

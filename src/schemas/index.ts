import { z } from 'zod';
import { hasControlChar, isUsername, messageHasForbiddenControl } from '../text';

const reqStr = (msg: string) =>
  z.preprocess(
    (val) => (typeof val === 'string' ? val.trim() : val),
    z.string({ message: msg }).min(1, msg)
  );

export const registerSchema = z.object({
  username: z
    .string({ message: 'username and password are required' })
    .trim()
    .min(1, 'username and password are required')
    .transform((value) => value.toLowerCase())
    .refine(isUsername, 'username must be 2-24 characters: a-z, 0-9, underscore'),
  password: z.string({ message: 'username and password are required' }).min(1, 'username and password are required'),
});

export const loginSchema = z.object({
  username: reqStr('username and password are required'),
  password: z.string({ message: 'username and password are required' }).min(1, 'username and password are required'),
});

export const resetPasswordSchema = z.object({
  username: reqStr('username, token, and password are required'),
  token: reqStr('username, token, and password are required'),
  password: z.string({ message: 'username, token, and password are required' }).min(1, 'username, token, and password are required'),
});

export const patchUserMeSchema = z.object({
  color: z.string().optional(),
  current_password: z.string().optional(),
  password: z.string().optional(),
});

export const userRoleBodySchema = z.object({
  role: z.enum(['admin', 'member'], {
    message: 'role must be admin or member',
  }),
});

export const idParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'invalid id').transform(Number).refine((n) => n > 0, 'invalid id'),
});

export const usernameParamSchema = z.object({
  username: reqStr('username is required'),
});

export const createRoomSchema = z.object({
  name: reqStr('name is required').refine((value) => !hasControlChar(value), 'name contains invalid characters'),
  // Non-integers are ignored by the handler, matching the pre-Zod behavior.
  members: z.unknown().optional(),
});

export const createDmSchema = z.object({
  userId: z.number({ message: 'userId is required' }).int({ message: 'userId is required' }),
});

export const roomSlugBodySchema = z.object({
  room: reqStr('room is required'),
});

export const roomMembersBodySchema = z.object({
  room: reqStr('room is required'),
  userIds: z.array(z.number().int(), { message: 'userIds is required' }),
});

export const roomKickBodySchema = z.object({
  room: reqStr('room is required'),
  userId: z.number({ message: 'userId is required' }).int({ message: 'userId is required' }),
});

export const roomSlugParamSchema = z.object({
  slug: reqStr('room is required'),
});

export const listMessagesQuerySchema = z.object({
  room: z.string().optional(),
});

export const createMessageSchema = z.object({
  room: reqStr('room and content are required'),
  content: reqStr('room and content are required').refine(
    (value) => !messageHasForbiddenControl(value),
    'message contains invalid characters'
  ),
});

export const deleteMessageParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'id is required').transform(Number).refine((n) => n > 0, 'id is required'),
});

export const fileIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'invalid file id').transform(Number).refine((n) => n > 0, 'invalid file id'),
});

export const linkPreviewQuerySchema = z.object({
  url: reqStr('url is required'),
});

export function formatZodError(error: z.ZodError): string {
  const firstIssue = error.issues[0];
  if (firstIssue) {
    return firstIssue.message;
  }
  return 'invalid request payload';
}

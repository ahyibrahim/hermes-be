import { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import {
  getUserById,
  getUserByUsername,
  listVisibleUsers,
  setUserColor,
  setUserRole,
  takenColors,
  usersWhoCanSee,
} from '../rooms';
import {
  changePassword,
  getProfile,
  issuePasswordReset,
  loginUser,
  redeemPasswordReset,
  registerUser,
  setAvatarFileId,
} from '../auth';
import { can } from '../authz';
import { isUserColor } from '../colors';
import { deleteOtherSessions, deleteSession, hashSessionToken } from '../sessions';
import { createFileRecord, deleteOrphanFile, getFileRecord } from '../db';
import { sniffInlineImageFile, UPLOAD_RESPONSE_HEADERS } from '../file-type';
import {
  authRateLimitConfig,
  perUserRateLimit,
  AVATAR_TYPES,
  extractToken,
  parseIceServers,
  resolveSession,
  resolveUser,
  RouteContext,
} from './common';
import {
  formatZodError,
  idParamSchema,
  loginSchema,
  patchUserMeSchema,
  registerSchema,
  resetPasswordSchema,
  usernameParamSchema,
  userRoleBodySchema,
} from '../schemas';

export async function authRoutes(fastify: FastifyInstance, ctx: RouteContext): Promise<void> {
  function fanOutProfile(username: string, profile: unknown): void {
    for (const name of usersWhoCanSee(username)) {
      ctx.sendToUser(name, { type: 'user_updated', user: profile });
    }
  }

  fastify.post(
    '/auth/register',
    { config: { rateLimit: authRateLimitConfig() } },
    async (request, reply) => {
      const parsed = registerSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: formatZodError(parsed.error) };
      }

      const { username, password } = parsed.data;
      try {
        const user = await registerUser(username, password);
        return { user: { id: user.id, username: user.username, role: user.role, color: user.color } };
      } catch (error) {
        const message = (error as Error).message;
        if (message.startsWith('username must') || message === 'username and password are required') {
          reply.code(400);
          return { error: message };
        }
        reply.code(409);
        return { error: 'could not register' };
      }
    }
  );

  fastify.post(
    '/auth/login',
    { config: { rateLimit: authRateLimitConfig() } },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: formatZodError(parsed.error) };
      }

      const { username, password } = parsed.data;
      const session = await loginUser(username, password);
      if (!session) {
        request.log.info(
          { event: 'login_failure', username: username.trim().toLowerCase() },
          'login failed'
        );
        reply.code(401);
        return { error: 'invalid credentials' };
      }

      request.log.info({ event: 'login_success', username: session.username }, 'login succeeded');
      return session;
    }
  );

  fastify.post(
    '/auth/reset',
    { config: { rateLimit: authRateLimitConfig() } },
    async (request, reply) => {
      const parsed = resetPasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: formatZodError(parsed.error) };
      }

      const { username, token, password } = parsed.data;
      const session = await redeemPasswordReset(username, token, password);
      if (!session) {
        request.log.info(
          { event: 'password_reset_failure', username: username.trim().toLowerCase() },
          'password reset failed'
        );
        reply.code(401);
        return { error: 'invalid reset token' };
      }

      ctx.closeUserSockets(session.username);
      request.log.info({ event: 'password_reset_success', username: session.username }, 'password reset redeemed');
      return session;
    }
  );

  fastify.post('/auth/logout', async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    const token = extractToken(request);
    deleteSession(token);
    ctx.closeUserSockets(username, { onlyHash: token ? hashSessionToken(token) : undefined });
    request.log.info({ event: 'logout', username }, 'logged out');
    return { ok: true };
  });

  fastify.get('/users', async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    const actor = getUserByUsername(username);
    if (!actor) {
      reply.code(401);
      return { error: 'authentication required' };
    }
    return listVisibleUsers(actor);
  });

  fastify.get('/users/online', async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    const actor = getUserByUsername(username);
    if (!actor) {
      reply.code(401);
      return { error: 'authentication required' };
    }
    const visible = new Set(listVisibleUsers(actor).map((user) => user.username));
    return ctx.onlineUsernames().filter((name) => visible.has(name));
  });

  fastify.get('/ice', async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    return { iceServers: parseIceServers(process.env.HERMES_ICE_SERVERS) };
  });

  fastify.get('/users/me', async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    const profile = getProfile(username);
    if (!profile) {
      reply.code(401);
      return { error: 'authentication required' };
    }
    return profile;
  });

  fastify.patch('/users/me', async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    const parsed = patchUserMeSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: formatZodError(parsed.error) };
    }

    const body = parsed.data;
    if (typeof body.color === 'string') {
      if (!isUserColor(body.color)) {
        reply.code(400);
        return { error: 'color is not in the palette' };
      }
      const me = getUserByUsername(username);
      if (!me) {
        reply.code(401);
        return { error: 'authentication required' };
      }
      const taken = takenColors();
      if (taken.has(body.color) && me.color !== body.color) {
        reply.code(409);
        return { error: 'color is taken' };
      }
      try {
        setUserColor(me.id, body.color);
      } catch (error) {
        const message = String((error as Error).message);
        if (message.includes('UNIQUE') && (message.includes('idx_users_color') || message.includes('users.color'))) {
          reply.code(409);
          return { error: 'color is taken' };
        }
        throw error;
      }
      const profile = getProfile(username);
      if (profile) {
        fanOutProfile(username, profile);
      }
      return profile;
    }

    if (!body.current_password || !body.password || !body.password.trim()) {
      reply.code(400);
      return { error: 'current_password and password are required' };
    }

    try {
      const ok = await changePassword(username, body.current_password, body.password);
      if (!ok) {
        reply.code(401);
        return { error: 'invalid credentials' };
      }
    } catch (error) {
      reply.code(400);
      return { error: (error as Error).message };
    }

    const token = extractToken(request);
    deleteOtherSessions(username, token);
    ctx.closeUserSockets(username, { exceptHash: token ? hashSessionToken(token) : undefined });
    request.log.info({ event: 'password_change', username }, 'password changed');
    return { ok: true };
  });

  fastify.post('/users/me/avatar', { config: { rateLimit: perUserRateLimit(20) } }, async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    const me = getUserByUsername(username);
    if (!me) {
      reply.code(401);
      return { error: 'authentication required' };
    }

    const data = await request.file();
    if (!data) {
      reply.code(400);
      return { error: 'file is required' };
    }

    const mime = data.mimetype || '';
    if (!AVATAR_TYPES.has(mime)) {
      data.file.resume();
      reply.code(415);
      return { error: 'avatar must be png, jpeg, webp, or gif' };
    }

    const storedName = `${crypto.randomUUID()}`;
    const storedPath = path.join(ctx.filesDir, storedName);
    let committed = false;
    try {
      await pipeline(data.file, fs.createWriteStream(storedPath));

      if (data.file.truncated) {
        reply.code(413);
        return { error: 'file too large' };
      }

      const sniffed = sniffInlineImageFile(storedPath);
      if (!sniffed) {
        reply.code(415);
        return { error: 'avatar must be png, jpeg, webp, or gif' };
      }

      const size = fs.statSync(storedPath).size;
      const file = createFileRecord(
        `avatar:${username}`,
        username,
        data.filename || 'avatar',
        sniffed,
        size,
        storedPath
      );
      committed = true;
      const previousAvatar = me.avatar_file_id;
      setAvatarFileId(me.id, file.id);
      if (previousAvatar != null && previousAvatar !== file.id) {
        deleteOrphanFile(previousAvatar);
      }
      request.log.info({ event: 'avatar_upload', user: username, id: file.id }, 'avatar uploaded');
      return getProfile(username);
    } finally {
      if (!committed) {
        fs.rmSync(storedPath, { force: true });
      }
    }
  });

  fastify.get('/users/:id/avatar', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    const parsed = idParamSchema.safeParse(request.params);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid user id' };
    }

    const id = parsed.data.id;
    const user = getUserById(id);
    if (!user || !usersWhoCanSee(user.username).includes(username)) {
      reply.code(404);
      return { error: 'avatar not found' };
    }
    if (!user.avatar_file_id) {
      reply.code(404);
      return { error: 'avatar not found' };
    }

    const file = getFileRecord(user.avatar_file_id);
    if (!file || !fs.existsSync(file.path)) {
      reply.code(404);
      return { error: 'avatar not found' };
    }

    const image = sniffInlineImageFile(file.path);
    if (!image) {
      reply.code(404);
      return { error: 'avatar not found' };
    }

    reply.headers(UPLOAD_RESPONSE_HEADERS);
    reply.header('Content-Type', image);
    reply.header('Content-Disposition', 'inline');
    return reply.send(fs.createReadStream(file.path));
  });

  fastify.post(
    '/users/:username/password-reset',
    async (request: FastifyRequest<{ Params: { username: string } }>, reply) => {
      const actorName = resolveUser(request, reply);
      if (!actorName) {
        return { error: 'authentication required' };
      }

      const parsed = usernameParamSchema.safeParse(request.params);
      if (!parsed.success) {
        reply.code(400);
        return { error: formatZodError(parsed.error) };
      }

      const targetUsername = parsed.data.username;
      const actor = getUserByUsername(actorName);
      const session = resolveSession(request, reply);
      if (!actor || !session) {
        reply.code(401);
        return { error: 'authentication required' };
      }
      const target = getUserByUsername(targetUsername);
      if (!target || target.system) {
        reply.code(404);
        return { error: 'user not found' };
      }
      if (!can({ ...actor, scope: session.scope }, 'user.password_reset', { target })) {
        reply.code(403);
        return { error: 'forbidden' };
      }

      const issued = issuePasswordReset(targetUsername);
      if ('error' in issued) {
        reply.code(404);
        return { error: 'user not found' };
      }

      request.log.info(
        { event: 'password_reset_issued', username: targetUsername.trim().toLowerCase() },
        'password reset token issued'
      );
      reply.code(201);
      return issued;
    }
  );

  fastify.patch(
    '/users/:username/role',
    async (request: FastifyRequest<{ Params: { username: string } }>, reply) => {
      const actorName = resolveUser(request, reply);
      if (!actorName) {
        return { error: 'authentication required' };
      }

      const parsedParams = usernameParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        reply.code(400);
        return { error: formatZodError(parsedParams.error) };
      }

      const actor = getUserByUsername(actorName);
      const session = resolveSession(request, reply);
      if (!actor || !session) {
        reply.code(401);
        return { error: 'authentication required' };
      }

      const parsedBody = userRoleBodySchema.safeParse(request.body);
      if (!parsedBody.success) {
        reply.code(400);
        return { error: formatZodError(parsedBody.error) };
      }

      const target = getUserByUsername(parsedParams.data.username);
      if (!target) {
        reply.code(404);
        return { error: 'user not found' };
      }
      if (target.system) {
        reply.code(400);
        return { error: 'cannot change a system user role' };
      }
      if (
        !can({ ...actor, scope: session.scope }, 'role.set', {
          target,
          nextRole: parsedBody.data.role,
        })
      ) {
        reply.code(403);
        return { error: 'forbidden' };
      }

      const result = setUserRole(parsedParams.data.username, parsedBody.data.role, {
        allowLastAdmin: actor.role === 'master',
      });
      if ('error' in result) {
        if (result.error === 'not_found') {
          reply.code(404);
          return { error: 'user not found' };
        }
        if (result.error === 'system_user') {
          reply.code(400);
          return { error: 'cannot change a system user role' };
        }
        if (result.error === 'forbidden') {
          reply.code(403);
          return { error: 'forbidden' };
        }
        reply.code(400);
        return { error: 'cannot demote the last admin' };
      }

      fanOutProfile(result.username, result);
      request.log.info(
        { event: 'role_set', actor: actorName, username: result.username, role: result.role },
        'user role updated'
      );
      return result;
    }
  );
}

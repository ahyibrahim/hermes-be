import { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createFileRecord, createMessage, getFileRecord, isRoomMember } from '../db';
import { revealRoomMembers } from '../rooms';
import { buildContentDisposition, isImageFile } from '../content-disposition';
import { normalizeRoomSlug, resolveUser, RouteContext } from './common';
import { fileIdParamSchema } from '../schemas';

export async function fileRoutes(fastify: FastifyInstance, ctx: RouteContext): Promise<void> {
  fastify.post('/files', async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    const data = await request.file();
    if (!data) {
      reply.code(400);
      return { error: 'file is required' };
    }

    const roomField = data.fields.room as { value?: string } | undefined;
    const slug = normalizeRoomSlug(roomField?.value);
    if (!slug) {
      reply.code(403);
      data.file.resume();
      return { error: 'room must be a slug, not a numeric id' };
    }

    if (!isRoomMember(slug, username)) {
      reply.code(403);
      data.file.resume();
      return { error: 'not a member of this room' };
    }
    const storedName = `${crypto.randomUUID()}`;
    const storedPath = path.join(ctx.filesDir, storedName);
    await pipeline(data.file, fs.createWriteStream(storedPath));

    if (data.file.truncated) {
      fs.rmSync(storedPath, { force: true });
      reply.code(413);
      return { error: 'file too large' };
    }

    const size = fs.statSync(storedPath).size;
    const file = createFileRecord(
      slug,
      username,
      data.filename || 'upload',
      data.mimetype || 'application/octet-stream',
      size,
      storedPath
    );
    revealRoomMembers(slug);
    const message = createMessage(slug, username, file.original_name, file.id);
    ctx.broadcastToMembers(slug, { type: 'message', message });
    request.log.info(
      {
        event: 'file_upload',
        id: file.id,
        uploader: username,
        size: file.size,
        mime: file.mime,
        room: slug,
      },
      'file uploaded'
    );

    return {
      file: {
        id: file.id,
        room: file.room,
        uploader: file.uploader,
        original_name: file.original_name,
        mime: file.mime,
        size: file.size,
        created_at: file.created_at,
      },
      message,
    };
  });

  fastify.get('/files/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    const parsed = fileIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid file id' };
    }

    const id = parsed.data.id;
    const file = getFileRecord(id);
    if (!file) {
      reply.code(404);
      return { error: 'file not found' };
    }

    if (!isRoomMember(file.room, username)) {
      reply.code(403);
      return { error: 'not a member of this room' };
    }

    if (!fs.existsSync(file.path)) {
      reply.code(404);
      return { error: 'file not found' };
    }

    reply.header('Content-Type', file.mime);
    const image = isImageFile(file.mime, file.original_name);
    reply.header(
      'Content-Disposition',
      buildContentDisposition(image ? 'inline' : 'attachment', file.original_name)
    );
    return reply.send(fs.createReadStream(file.path));
  });
}

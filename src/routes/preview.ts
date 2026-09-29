import { FastifyInstance, FastifyRequest } from 'fastify';
import { perUserRateLimit, resolveUser, RouteContext } from './common';
import { formatZodError, linkPreviewQuerySchema } from '../schemas';
import { UPLOAD_RESPONSE_HEADERS } from '../file-type';

export async function previewRoutes(fastify: FastifyInstance, ctx: RouteContext): Promise<void> {
  fastify.get(
    '/link-preview',
    { config: { rateLimit: perUserRateLimit(60) } },
    async (request: FastifyRequest<{ Querystring: { url?: string } }>, reply) => {
      const username = resolveUser(request, reply);
      if (!username) {
        return { error: 'authentication required' };
      }

      const parsed = linkPreviewQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.code(400);
        return { error: formatZodError(parsed.error) };
      }

      const preview = await ctx.linkPreview.getPreview(parsed.data.url, username);
      return { preview };
    }
  );

  fastify.get(
    '/link-preview/image',
    { config: { rateLimit: perUserRateLimit(300) } },
    async (request: FastifyRequest<{ Querystring: { url?: string } }>, reply) => {
      const username = resolveUser(request, reply);
      if (!username) {
        return { error: 'authentication required' };
      }

      const parsed = linkPreviewQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.code(400);
        return { error: formatZodError(parsed.error) };
      }

      const image = await ctx.linkPreview.getImage(parsed.data.url, username);
      if (!image) {
        reply.code(404);
        return { error: 'image not available' };
      }
      reply.headers(UPLOAD_RESPONSE_HEADERS);
      reply.header('Content-Type', image.type);
      reply.header('Cache-Control', 'private, max-age=3600');
      return reply.send(image.bytes);
    }
  );
}

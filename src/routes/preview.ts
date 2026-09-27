import { FastifyInstance, FastifyRequest } from 'fastify';
import { resolveUser, RouteContext } from './common';
import { formatZodError, linkPreviewQuerySchema } from '../schemas';

export async function previewRoutes(fastify: FastifyInstance, ctx: RouteContext): Promise<void> {
  fastify.get('/link-preview', async (request: FastifyRequest<{ Querystring: { url?: string } }>, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    const parsed = linkPreviewQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: formatZodError(parsed.error) };
    }

    const preview = await ctx.linkPreview.getPreview(parsed.data.url);
    return { preview };
  });
}

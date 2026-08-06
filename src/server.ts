import './runtime-compat';
import Fastify, { FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import { createMessage, listMessages } from './db';
import { loginUser, registerUser } from './auth';

type RoomSocket = {
  socket: any;
  room: string;
  user: string;
};

const fastify = Fastify({ logger: false });

const roomClients = new Map<string, Set<RoomSocket>>();
const userTokens = new Map<string, string>();

async function bootstrap() {
  await fastify.register(websocket);

  fastify.get('/health', async () => ({
    status: 'ok',
    service: 'hermes-be',
    message: 'Backend is running',
  }));

  fastify.post('/auth/register', async (request, reply) => {
    const body = request.body as { username?: string; password?: string };

    if (!body.username || !body.password) {
      reply.code(400);
      return { error: 'username and password are required' };
    }

    try {
      const user = registerUser(body.username, body.password);
      return { user: { id: user.id, username: user.username } };
    } catch (error) {
      reply.code(409);
      return { error: (error as Error).message };
    }
  });

  fastify.post('/auth/login', async (request, reply) => {
    const body = request.body as { username?: string; password?: string };

    if (!body.username || !body.password) {
      reply.code(400);
      return { error: 'username and password are required' };
    }

    const session = loginUser(body.username, body.password);
    if (!session) {
      reply.code(401);
      return { error: 'invalid credentials' };
    }

    userTokens.set(session.token, session.username);
    return session;
  });

  fastify.get('/messages', async (request: FastifyRequest<{ Querystring: { room?: string } }>) => {
    const room = request.query.room ?? 'general';
    return listMessages(room);
  });

  fastify.post('/messages', async (request, reply) => {
    const body = request.body as { room?: string; sender?: string; content?: string; token?: string };

    if (!body.room || !body.sender || !body.content) {
      reply.code(400);
      return { error: 'room, sender, and content are required' };
    }

    if (body.token && !userTokens.has(body.token)) {
      reply.code(401);
      return { error: 'invalid token' };
    }

    const message = createMessage(body.room, body.sender, body.content);
    broadcastToRoom(body.room, { type: 'message', message });

    return message;
  });

  fastify.get('/ws', { websocket: true }, (connection: any) => {
    const socket = connection.socket;
    let room = 'general';
    let user = 'anonymous';

    const removeClient = (targetRoom: string) => {
      const clients = roomClients.get(targetRoom);
      if (!clients) {
        return;
      }

      for (const client of clients) {
        if (client.socket === socket) {
          clients.delete(client);
          break;
        }
      }
    };

    const registerRoom = (nextRoom: string, nextUser: string) => {
      removeClient(room);

      room = nextRoom;
      user = nextUser;

      if (!roomClients.has(room)) {
        roomClients.set(room, new Set());
      }

      roomClients.get(room)?.add({ socket, room, user });
    };

    registerRoom(room, user);

    socket.send(JSON.stringify({ type: 'connected', room, user }));

    socket.on('message', (raw: Buffer | string) => {
      try {
        const payload = JSON.parse(raw.toString());

        if (payload.type === 'join_room') {
          const nextRoom = payload.room ?? 'general';
          const nextUser = payload.user ?? user;
          registerRoom(nextRoom, nextUser);
          socket.send(JSON.stringify({ type: 'joined_room', room, user: nextUser }));
        }

        if (payload.type === 'send_message') {
          const message = createMessage(payload.room ?? room, payload.sender ?? user, payload.content ?? '');
          broadcastToRoom(payload.room ?? room, { type: 'message', message });
        }
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: 'Invalid message payload' }));
      }
    });

    socket.on('close', () => {
      removeClient(room);
    });
  });

  await fastify.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
  console.log('Server listening on http://0.0.0.0:3000');
}

function broadcastToRoom(room: string, payload: unknown) {
  const clients = roomClients.get(room);
  if (!clients) {
    return;
  }

  for (const client of clients) {
    client.socket.send(JSON.stringify(payload));
  }
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});

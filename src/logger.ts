import { stdSerializers, type LoggerOptions } from 'pino';

const LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

/**
 * Pino redact paths. Fastify nests the request serializer under `req`, so
 * header and query secrets live there. `*.password` catches a password field
 * anywhere in a logged object, including a request body if one is ever logged.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.Authorization',
  'headers.authorization',
  'headers.Authorization',
  'req.query.token',
  'query.token',
  'req.body.password',
  'body.password',
  '*.password',
  'password',
];

export type LogDestination = { write(chunk: string): void };

export type LoggerConfigOptions = {
  destination?: LogDestination;
  level?: string;
};

/**
 * Pretty-print only when stdout is a TTY. The systemd unit pipes stdout to
 * journald, which is never a TTY, so production always gets JSON. pino-pretty
 * is a devDependency; if it is not installed, logs stay JSON even on a TTY.
 */
export function shouldPrettyPrint(): boolean {
  if (!process.stdout.isTTY) {
    return false;
  }

  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export function resolveLogLevel(override?: string): string {
  const raw = (override ?? process.env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  return LEVELS.has(raw) ? raw : 'info';
}

/**
 * Strip `token` query values out of a URL. Pino redact matches object paths,
 * not substrings inside `req.url`, and Fastify's default serializer logs the
 * raw URL — which is how `?token=` would otherwise land in journald.
 */
export function redactRequestUrl(url: string): string {
  return url.replace(/([?&]token=)[^&]*/gi, '$1[Redacted]');
}

export function requestSerializer(req: {
  method?: string;
  url?: string;
  hostname?: string;
  ip?: string;
  socket?: { remotePort?: number };
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
}) {
  const headers = req.headers ?? {};
  const url = typeof req.url === 'string' ? req.url : '';
  const authorization = headers.authorization ?? headers.Authorization;
  const token = req.query?.token;
  return {
    method: req.method,
    url: redactRequestUrl(url),
    hostname: req.hostname,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
    ...(authorization !== undefined ? { headers: { authorization } } : {}),
    ...(token !== undefined ? { query: { token } } : {}),
  };
}

export type FastifyLoggerOption = LoggerOptions & { stream?: LogDestination };

/**
 * Fastify `logger` option. JSON to stdout unless a test injects a destination
 * or the process is attached to a TTY (local `npm run dev`).
 */
export function buildLoggerConfig(options: LoggerConfigOptions = {}): FastifyLoggerOption {
  const level = resolveLogLevel(options.level);
  const pretty = !options.destination && shouldPrettyPrint();

  const config: FastifyLoggerOption = {
    level,
    redact: {
      paths: REDACT_PATHS,
      censor: '[Redacted]',
    },
    serializers: {
      req: requestSerializer,
      err: stdSerializers.err,
    },
  };

  if (options.destination) {
    config.stream = options.destination;
  } else if (pretty) {
    config.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    };
  }

  return config;
}

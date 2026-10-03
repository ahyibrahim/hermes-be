import crypto from 'node:crypto';
import { parseIceServers } from './routes/common';

export type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

const DEFAULT_TURN_TTL_SECONDS = 60 * 60;

/**
 * coturn `use-auth-secret`: the username is `<unix-expiry>:<account>` and the
 * credential is HMAC-SHA1 of that username with `HERMES_TURN_SECRET`.
 */
function turnTtlSeconds(): number {
  const raw = process.env.HERMES_TURN_TTL_SECONDS;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_TURN_TTL_SECONDS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 60 || parsed > 24 * 60 * 60) {
    return DEFAULT_TURN_TTL_SECONDS;
  }
  return parsed;
}

function turnUrls(): string[] {
  const raw = process.env.HERMES_TURN_URLS;
  if (!raw || !raw.trim()) {
    return [];
  }
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.startsWith('turn:') || value.startsWith('turns:'));
}

function mintTurn(username: string, now: number): IceServer | null {
  const secret = process.env.HERMES_TURN_SECRET?.trim() ?? '';
  const urls = turnUrls();
  if (!secret || urls.length === 0) {
    return null;
  }

  const expiry = Math.floor(now / 1000) + turnTtlSeconds();
  const turnUsername = `${expiry}:${username}`;
  const credential = crypto.createHmac('sha1', secret).update(turnUsername).digest('base64');
  return {
    urls: urls.length === 1 ? urls[0] : urls,
    username: turnUsername,
    credential,
  };
}

/**
 * Public STUN stays as configured. A configured TURN server adds a credential
 * for this member only. Credentials embedded in `HERMES_ICE_SERVERS` are dropped.
 */
export function iceServersFor(username: string, now = Date.now()): IceServer[] {
  const base = parseIceServers(process.env.HERMES_ICE_SERVERS).map((server) => ({ urls: server.urls }));
  const turn = mintTurn(username, now);
  return turn ? [...base, turn] : base;
}

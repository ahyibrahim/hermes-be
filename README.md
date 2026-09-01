# hermes-be

Private messenger backend for a small group of friends. Local network and Tailscale. One Node process, SQLite, Fastify.

## Run

```sh
npm install
npm run dev
```

Listens on `0.0.0.0:3000` (or `PORT`). Data lives in `data/` (`hermes.db` and `files/`) **on the machine that runs the process**, not on the developer laptop. Override with `HERMES_DB_PATH` and `HERMES_FILES_DIR`. Do not point those at `/var/lib/hermes` — that is the production instance.

To exercise the web UI the same way production does (one process, same origin), build hermes-fe first and point `HERMES_WEB_DIR` at `apps/web/build`. Use a throwaway database so a local run cannot touch live history:

```sh
cd /home/ai/Workspace/hermes-fe && npm run build

cd /home/ai/Workspace/hermes-be
HERMES_WEB_DIR=/home/ai/Workspace/hermes-fe/apps/web/build \
HERMES_DB_PATH=/tmp/hermes-local.db \
HERMES_FILES_DIR=/tmp/hermes-local-files \
npm run dev
```

Open `http://127.0.0.1:3000`. There is no frontend `npm start` — that command in hermes-fe is the CLI. For Vite hot-reload instead, see the hermes-fe README (`npm run dev:web`). Full host setup and tagged deploys are in [docs/DEPLOY.md](docs/DEPLOY.md).

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | Bind port, on `0.0.0.0`. |
| `HERMES_DB_PATH` | `./data/hermes.db` | SQLite file. Created if absent, migrated in place on every start. |
| `HERMES_FILES_DIR` | `./data/files/` | Upload directory, created if absent. |
| `HERMES_SESSION_TTL_DAYS` | `30` | Login token lifetime in days. Anything that is not a positive number falls back to 30. |
| `LOG_LEVEL` | `info` | Pino level (`fatal` … `silent`). JSON to stdout; pretty-print only on a TTY. |
| `HERMES_GIT_COMMIT` | unset | Commit reported by `/health`. Set by `scripts/deploy.sh`; falls back to asking git, then to `unknown`. |
| `HERMES_WEB_DIR` | unset | Directory of the SvelteKit static bundle. When set to an existing directory, this process serves the web UI (and SPA client routes) from the same origin as the API and `/ws`. Unset, or a path that does not exist, is a no-op. |
| `HERMES_ICE_SERVERS` | Google STUN | JSON array of ICE servers for `GET /ice`. Default `[{"urls":"stun:stun.l.google.com:19302"}]`. TURN is not shipped in this release. |

Production instances read these from `/etc/hermes/<instance>.env`. See [docs/DEPLOY.md](docs/DEPLOY.md).

On startup the process migrates that SQLite file in place. Additive changes
(`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN`) leave existing tables alone; v0.6.0
also rewrites `room_members` to foreign keys. After pulling this code, restart
hermes-be on the host that serves `ying-1:3000` (or whatever `HERMES_BASE_URL`
points at). Rehearse that rewrite on `s1` before `p1` — see
[docs/DEPLOY.md](docs/DEPLOY.md#v060-s1-rehearsal-and-p1-backup).

```sh
npm test
npm run build
```

`npm test` runs the self-contained `node:test` files under `src/`. They boot what they need and write to temporary databases, so they never touch `data/`. That includes `src/v06-api.test.ts` (users, rooms, DMs, logout). `npm run test:integration` runs the same file.

## Current status

Live room chat works for two authenticated clients without rejoining. `POST /messages` persists and broadcasts to sockets currently joined to that room slug. File upload/download is supported. Presence is based on connected sockets, not message history. Per-room voice calls are signaled over `/ws` (`join_call`, SDP, ICE); media is peer-to-peer. `GET /ice` returns STUN servers. When `HERMES_WEB_DIR` is set to an existing directory, this same process also serves the web UI so REST, `/ws`, and the SPA share one origin.

## Auth

Login returns `{ username, token, expires_at }`. Send the token as `Authorization: Bearer <token>` on REST. WebSocket handshake requires the same token via `Authorization: Bearer <token>` and/or `?token=`. Identity always comes from the token; client `user` / `sender` fields are ignored when a token is present.

Unauthenticated `/ws` upgrades are rejected (HTTP 401). Invalid tokens are rejected the same way.

Sessions are rows in the `sessions` table, not process memory, so **a token survives a restart**. It expires `HERMES_SESSION_TTL_DAYS` after login (30 days by default); expired tokens are rejected and pruned. A client can persist the token and reuse it on next launch, and `expires_at` says how long that is worth doing.

Rooms are **slugs** (`general`, `dm:alice:bob`), never numeric ids. `GET /messages?room=1` returns 403. New users are added to `general`. `GET /rooms` only returns rooms the caller belongs to, and includes `type` (`group` or `dm`).

## REST

| Method | Path | Auth | Notes |
|--------|------|------|--------|
| GET | `/health` | no | `{ status, service, message, version, commit }` |
| POST | `/auth/register` | no | Rate limited. `{ username, password }`. First user is `admin`. |
| POST | `/auth/login` | no | Rate limited. Rehashes legacy SHA256 passwords to argon2id. |
| GET | `/rooms` | Bearer | Membership-filtered `[{ id, slug, name, type, created_at, members }]` |
| POST | `/rooms` | Bearer | `{ name, members?: number[] }` → group room. Creator is always a member. |
| POST | `/rooms/dm` | Bearer | `{ userId }` → existing or new DM. Idempotent. 400 for self-DM. |
| GET | `/users` | Bearer | `[{ id, username, role, avatar_file_id }]` |
| GET | `/users/me` | Bearer | Profile: `{ id, username, role, avatar_file_id }`. |
| PATCH | `/users/me` | Bearer | `{ current_password, password }`. Keeps this token; drops the rest. |
| POST | `/users/me/avatar` | Bearer | Image multipart (`png`/`jpeg`/`webp`/`gif`, 25MB). |
| GET | `/users/:id/avatar` | Bearer | Any authenticated user. Not gated on room membership. |
| GET | `/users/online` | Bearer | Usernames with an open WebSocket, sorted. |
| GET | `/ice` | Bearer | `{ iceServers }` for WebRTC. From `HERMES_ICE_SERVERS` or the default STUN URL. |
| POST | `/auth/logout` | Bearer | Deletes the current session. `{ ok: true }` |
| GET | `/messages?room=<slug>` | Bearer | Member of that room. 403 for numeric `room`. |
| POST | `/messages` | Bearer (or body `token`) | Persist + broadcast. Sender is the token username. |
| POST | `/files` | Bearer | Multipart: field `room` first, then file field `file`. Max 25MB. Creates a message with `file_id`. |
| GET | `/files/:id` | Bearer | Download if you are a member of the file's room. |

`GET /health` response:

```json
{
  "status": "ok",
  "service": "hermes-be",
  "message": "Backend is running",
  "version": "0.8.0",
  "commit": "8f8d92ef239e09938c19d7a4df105ac3605af87b"
}
```

`version` is `package.json`'s. `commit` is `HERMES_GIT_COMMIT` when set (a deploy sets it), otherwise the checkout's `git rev-parse HEAD`, otherwise `unknown`. `/health` never fails because git is unavailable, so polling it is how a deploy is verified.

`POST /messages` body:

```json
{
  "room": "general",
  "content": "hello",
  "token": "<optional if Authorization is set>"
}
```

Response is a `MessageRecord`. That same object is broadcast on WebSocket as `{ "type": "message", "message": { ... } }`.

File upload response:

```json
{
  "file": {
    "id": 1,
    "room": "general",
    "uploader": "alice",
    "original_name": "notes.txt",
    "mime": "text/plain",
    "size": 12,
    "created_at": "<iso>"
  },
  "message": {
    "id": 2,
    "room": "general",
    "sender": "alice",
    "content": "notes.txt",
    "created_at": "<iso>",
    "file_id": 1
  }
}
```

## WebSocket

- Path: `/ws` (raw JSON text frames, not Socket.IO)
- Connect: `ws://<host>/ws?token=<token>` (or Bearer on the handshake)

The connection stays open after 101 until the client closes it or auth fails. Do not treat `open` alone as proof of join; wait for `connected`, then send `join_room`.

### Client → server

```json
{ "type": "join_room", "room": "general" }
```

`user` is ignored. After a successful join the server sends `joined_room` then a `room_users` snapshot of **currently connected** members.

```json
{ "type": "send_message", "room": "general", "content": "hello" }
```

`send_message` does **not** insert a row. Persist with `POST /messages` only. The CLI currently POSTs and then sends `send_message`; the second call is ignored so history is not duplicated.

Call membership is independent of `join_room`. `join_call` / `leave_call` require an existing room membership and route signaling by username on the open socket. Offers, answers, and ICE candidates are relayed only to `to` (who must be in that call). Audio never traverses the server.

```json
{ "type": "join_call", "room": "general" }
{ "type": "leave_call", "room": "general" }
{ "type": "call_offer", "room": "general", "to": "bob", "sdp": { "type": "offer", "sdp": "..." } }
{ "type": "call_answer", "room": "general", "to": "alice", "sdp": { "type": "answer", "sdp": "..." } }
{ "type": "ice_candidate", "room": "general", "to": "bob", "candidate": { "candidate": "...", "sdpMid": "0" } }
```

### Server → client

```json
{ "type": "connected", "user": "alice" }
{ "type": "joined_room", "room": "general" }
{ "type": "room_users", "room": "general", "users": ["alice", "bob"] }
{ "type": "user_joined", "room": "general", "user": "bob" }
{ "type": "user_left", "room": "general", "user": "bob" }
{ "type": "message", "message": { "id": 1, "room": "general", "sender": "alice", "content": "hello", "created_at": "<iso>", "file_id": null } }
{ "type": "error", "content": "<reason>", "message": "<reason>" }
{ "type": "call_peers", "room": "general", "users": ["alice", "bob"] }
{ "type": "user_joined_call", "room": "general", "user": "bob" }
{ "type": "user_left_call", "room": "general", "user": "bob" }
{ "type": "left_call", "room": "general" }
{ "type": "call_offer", "room": "general", "from": "alice", "to": "bob", "sdp": { "type": "offer", "sdp": "..." } }
{ "type": "call_answer", "room": "general", "from": "bob", "to": "alice", "sdp": { "type": "answer", "sdp": "..." } }
{ "type": "ice_candidate", "room": "general", "from": "alice", "to": "bob", "candidate": { "candidate": "...", "sdpMid": "0" } }
```

`error` uses `content` (and `message` with the same string for older CLIs).

Live path: Alice `POST /messages` while Bob is joined to `general` → Bob receives `{ type: "message", message }` without rejoining.

Heartbeats: server pings sockets about every 30s and drops peers that stop answering.

## hermes-fe follow-up

The CLI should:

1. Put the login token on the WebSocket URL (`?token=`) and/or `Authorization` header. Until it does, `/ws` will 401 and live chat will look “offline.”
2. Treat WebSocket `close` / 1006 as offline; on reconnect, send `join_room` again for the current room.
3. Stop calling `send_message` after `POST /messages` (broadcast already happened).
4. For files: `POST /files` with `room` + `file`, print `file_id` from the message, `GET /files/:id` to download.

## Deploy

[docs/DEPLOY.md](docs/DEPLOY.md) is the runbook (local smoke-test, one-time host setup, tagged deploy). In short: the host runs `hermes-be@p1`, a systemd template unit under a `hermes` service user, with code in `/srv/hermes/p1/hermes-be` and data in `/var/lib/hermes/p1/` — deliberately not this checkout. The web UI is static files served from this same process; there is no second Node service.

```sh
sudo ./scripts/setup-host.sh p1     # once, needs root; creates /etc/hermes/p1.env
# then, after the release tags exist on origin:
sudo HERMES_WEB_BUNDLE=/home/ai/Workspace/hermes-fe/apps/web/build \
  ./scripts/deploy.sh p1 v0.4.0     # per release
journalctl -u hermes-be@p1 -f
```

`setup-host.sh` must run before the first `deploy.sh` or the deploy fails with a missing env file. `deploy.sh` checks out the **GitHub tag** (not this working tree), builds, unpacks the web bundle into `HERMES_WEB_DIR` when that is set, restarts the unit and polls `/health` until it reports the version and commit it just deployed. Tailscale clients then open `http://ying-1:PORT/`. Wiring this into GitHub Actions is backlog, blocked on a private hermes-be; pushing a tag alone still does not deploy.

## Roadmap

[docs/ROADMAP.md](docs/ROADMAP.md) is the source of truth for release scope, v0.2.0 through v0.8.0. Architecture decisions are recorded in [docs/adr/](docs/adr/): [0001](docs/adr/0001-frontend-stack.md) on the SvelteKit web stack, [0002](docs/adr/0002-deployment-topology.md) on the deployment topology.

## Out of scope for now

E2E encryption and clustered processes. Voice chat is planned for v0.8.0, browser only.

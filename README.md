# hermes-be

Private messenger backend for a small group of friends. Local network and Tailscale. One Node process, SQLite, Fastify.

## Run

```sh
npm install
npm run dev
```

Listens on `0.0.0.0:3000` (or `PORT`). Data lives in `data/` (`hermes.db` and `files/`) **on the machine that runs the process**, not on the developer laptop. Override with `HERMES_DB_PATH` and `HERMES_FILES_DIR`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | Bind port, on `0.0.0.0`. |
| `HERMES_DB_PATH` | `./data/hermes.db` | SQLite file. Created if absent, migrated in place on every start. |
| `HERMES_FILES_DIR` | `./data/files/` | Upload directory, created if absent. |
| `HERMES_SESSION_TTL_DAYS` | `30` | Login token lifetime in days. Anything that is not a positive number falls back to 30. |
| `HERMES_GIT_COMMIT` | unset | Commit reported by `/health`. Set by `scripts/deploy.sh`; falls back to asking git, then to `unknown`. |

Production instances read these from `/etc/hermes/<instance>.env`. See [docs/DEPLOY.md](docs/DEPLOY.md).

On startup the process migrates that SQLite file in place (`CREATE TABLE IF NOT EXISTS` does not change existing tables). After pulling this code, restart hermes-be on the host that serves `ying-1:3000` (or whatever `HERMES_BASE_URL` points at).

```sh
npm test
npm run build
```

`npm test` runs the self-contained `node:test` files under `src/`. They boot what they need and write to temporary databases, so they never touch `data/`.

`npm run test:integration` is separate and is **not** part of `npm test`. It runs `test/integration/integration.spec.ts`, which is a specification for the v0.6.0 API surface rather than a regression test: it needs a hermes-be already listening on port 3456 (override with `PORT`) and asserts against endpoints that do not exist yet, so it fails against the current server by design. Give it a throwaway `HERMES_DB_PATH`.

## Current status

Live room chat works for two authenticated clients without rejoining. `POST /messages` persists and broadcasts to sockets currently joined to that room slug. File upload/download is supported. Presence is based on connected sockets, not message history.

## Auth

Login returns `{ username, token, expires_at }`. Send the token as `Authorization: Bearer <token>` on REST. WebSocket handshake requires the same token via `Authorization: Bearer <token>` and/or `?token=`. Identity always comes from the token; client `user` / `sender` fields are ignored when a token is present.

Unauthenticated `/ws` upgrades are rejected (HTTP 401). Invalid tokens are rejected the same way.

Sessions are rows in the `sessions` table, not process memory, so **a token survives a restart**. It expires `HERMES_SESSION_TTL_DAYS` after login (30 days by default); expired tokens are rejected and pruned. A client can persist the token and reuse it on next launch, and `expires_at` says how long that is worth doing.

Rooms are **slugs** (`general`), never numeric ids. `GET /messages?room=1` returns 403.

## REST

| Method | Path | Auth | Notes |
|--------|------|------|--------|
| GET | `/health` | no | `{ status, service, message, version, commit }` |
| POST | `/auth/register` | no | `{ username, password }` |
| POST | `/auth/login` | no | `{ username, password }` → `{ username, token, expires_at }` |
| GET | `/rooms` | Bearer | `[{ id, slug, name, created_at, members }]` |
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
  "version": "0.3.0",
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

### Server → client

```json
{ "type": "connected", "user": "alice" }
{ "type": "joined_room", "room": "general" }
{ "type": "room_users", "room": "general", "users": ["alice", "bob"] }
{ "type": "user_joined", "room": "general", "user": "bob" }
{ "type": "user_left", "room": "general", "user": "bob" }
{ "type": "message", "message": { "id": 1, "room": "general", "sender": "alice", "content": "hello", "created_at": "<iso>", "file_id": null } }
{ "type": "error", "content": "<reason>", "message": "<reason>" }
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

[docs/DEPLOY.md](docs/DEPLOY.md) is the runbook. In short: the host runs `hermes-be@p1`, a systemd template unit under a `hermes` service user, with code in `/srv/hermes/p1/hermes-be` and data in `/var/lib/hermes/p1/` — deliberately not this checkout.

```sh
sudo ./scripts/setup-host.sh p1     # once, needs root
sudo ./scripts/deploy.sh p1 v0.3.0  # per release
journalctl -u hermes-be@p1 -f
```

`deploy.sh` checks out the tag, builds, restarts the unit and polls `/health` until it reports the version and commit it just deployed. In v0.5.0 the same script gets called by a GitHub Actions job on a self-hosted runner, triggered by publishing a Release; pushing a tag alone will still not deploy.

## Roadmap

[docs/ROADMAP.md](docs/ROADMAP.md) is the source of truth for release scope, v0.2.0 through v0.8.0. Architecture decisions are recorded in [docs/adr/](docs/adr/): [0001](docs/adr/0001-frontend-stack.md) on the SvelteKit web stack, [0002](docs/adr/0002-deployment-topology.md) on the deployment topology.

## Out of scope for now

E2E encryption and clustered processes. Voice chat is planned for v0.8.0, browser only.

# hermes-be

Private messenger backend for a small group of friends. Local network and Tailscale. One Node process, SQLite, Fastify.

## Run

```sh
npm install
npm run dev
```

Listens on `0.0.0.0:3000` (or `PORT`). Data lives in `data/` (`hermes.db` and `files/`) **on the machine that runs the process**, not on the developer laptop. Override with `HERMES_DB_PATH` and `HERMES_FILES_DIR`.

On startup the process migrates that SQLite file in place (`CREATE TABLE IF NOT EXISTS` does not change existing tables). After pulling this code, restart hermes-be on the host that serves `ying-1:3000` (or whatever `HERMES_BASE_URL` points at).

```sh
npm test
npm run build
```

## Current status

Live room chat works for two authenticated clients without rejoining. `POST /messages` persists and broadcasts to sockets currently joined to that room slug. File upload/download is supported. Presence is based on connected sockets, not message history.

## Auth

Login returns `{ username, token }`. Send the token as `Authorization: Bearer <token>` on REST. WebSocket handshake requires the same token via `Authorization: Bearer <token>` and/or `?token=`. Identity always comes from the token; client `user` / `sender` fields are ignored when a token is present.

Unauthenticated `/ws` upgrades are rejected (HTTP 401). Invalid tokens are rejected the same way.

Rooms are **slugs** (`general`), never numeric ids. `GET /messages?room=1` returns 403.

## REST

| Method | Path | Auth | Notes |
|--------|------|------|--------|
| GET | `/health` | no | |
| POST | `/auth/register` | no | `{ username, password }` |
| POST | `/auth/login` | no | `{ username, password }` → `{ username, token }` |
| GET | `/rooms` | Bearer | `[{ id, slug, name, created_at, members }]` |
| GET | `/messages?room=<slug>` | Bearer | Member of that room. 403 for numeric `room`. |
| POST | `/messages` | Bearer (or body `token`) | Persist + broadcast. Sender is the token username. |
| POST | `/files` | Bearer | Multipart: field `room` first, then file field `file`. Max 25MB. Creates a message with `file_id`. |
| GET | `/files/:id` | Bearer | Download if you are a member of the file's room. |

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

## Out of scope for now

Voice / WebRTC, E2E encryption, clustered processes.

## Later: deploy to the host

The process and SQLite file live on a different machine from this repo (for example a Tailscale node). Today that means pull and restart on the host by hand. A later expansion is a tunnel (or similar) so we can deploy and restart directly on that machine from here, instead of copying commits over separately.

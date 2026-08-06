# hermes-be

## Project brief

Hermes is a private messenger backend for a small group of friends. It should work over both a local network and a Tailscale private network. The initial focus is simplicity, privacy, and ease of setup rather than scalability.

## Goals

- Provide a simple, secure, private messaging experience
- Support local-network and Tailscale-based connectivity
- Keep the backend easy to run and maintain for a single developer
- Leave room for future voice chat support

## Constraints

- Small scale: roughly 5 users total
- Avoid overengineering
- Prefer a simple architecture over distributed systems
- Treat security and privacy as core requirements

## Current status

The backend is now at a usable MVP stage for local testing and simple frontend integration.

Implemented so far:

- TypeScript backend using Node.js and Fastify
- Health endpoint at `/health`
- SQLite-backed message persistence
- REST endpoints for reading and creating messages
- WebSocket support for real-time messaging
- Basic room-based websocket joining
- Simple user registration and login flow
- Token-based auth for basic access control
- Regression tests for database and auth behavior
- Build verified successfully with `npm run build`

## What we will do in the next iteration

The next iteration is focused on making the backend easier to integrate with a simple frontend and to support the first real user flow.

Planned work:

- Finalize a clean API and websocket contract for the frontend
- Add file upload/download support
- Add basic presence and online status handling
- Improve room and user management for a more predictable experience
- Add better documentation for endpoints and websocket events
- Keep the architecture intentionally simple and local-first

## Recommended stack for the MVP

- TypeScript
- Node.js
- Fastify
- WebSocket support for real-time messaging
- SQLite for simple local persistence

## MVP features

- User authentication
- Private and group chat rooms
- Real-time message delivery
- Message persistence
- File sharing
- Presence and online status

## Future roadmap

- Add encrypted voice chat later
- Design the backend so it can support WebRTC-based voice features in a future phase

## Frontend-facing API contract

The frontend can use the following endpoints and websocket events.

### REST endpoints

#### Health check

- Method: `GET`
- Path: `/health`
- Response:
  ```json
  {
    "status": "ok",
    "service": "hermes-be",
    "message": "Backend is running"
  }
  ```

#### Register a user

- Method: `POST`
- Path: `/auth/register`
- Body:
  ```json
  {
    "username": "alice",
    "password": "hunter2"
  }
  ```
- Response:
  ```json
  {
    "user": {
      "id": 1,
      "username": "alice"
    }
  }
  ```

#### Log in a user

- Method: `POST`
- Path: `/auth/login`
- Body:
  ```json
  {
    "username": "alice",
    "password": "hunter2"
  }
  ```
- Response:
  ```json
  {
    "username": "alice",
    "token": "<uuid>"
  }
  ```

#### List messages for a room

- Method: `GET`
- Path: `/messages?room=general`
- Response:
  ```json
  [
    {
      "id": 1,
      "room": "general",
      "sender": "alice",
      "content": "hello",
      "created_at": "2026-08-06T12:00:00.000Z"
    }
  ]
  ```

#### Create a message

- Method: `POST`
- Path: `/messages`
- Body:
  ```json
  {
    "room": "general",
    "sender": "alice",
    "content": "hello",
    "token": "<token>"
  }
  ```
- Response:
  ```json
  {
    "id": 1,
    "room": "general",
    "sender": "alice",
    "content": "hello",
    "created_at": "2026-08-06T12:00:00.000Z"
  }
  ```

### WebSocket endpoint

- Path: `/ws`
- The frontend should connect to this endpoint.

#### Incoming websocket messages from the frontend

##### Join a room

```json
{
  "type": "join_room",
  "room": "general",
  "user": "alice"
}
```

##### Send a message over websocket

```json
{
  "type": "send_message",
  "room": "general",
  "sender": "alice",
  "content": "hello"
}
```

#### Outgoing websocket messages from the backend

##### Connection confirmation

```json
{
  "type": "connected",
  "room": "general",
  "user": "anonymous"
}
```

##### Room join confirmation

```json
{
  "type": "joined_room",
  "room": "general",
  "user": "alice"
}
```

##### Message broadcast

```json
{
  "type": "message",
  "message": {
    "id": 1,
    "room": "general",
    "sender": "alice",
    "content": "hello",
    "created_at": "2026-08-06T12:00:00.000Z"
  }
}
```

##### Error

```json
{
  "type": "error",
  "message": "Invalid message payload"
}
```

## Handoff note

This project is intentionally small and private. The right implementation is a lightweight real-time backend with straightforward persistence, not a large-scale messaging platform.

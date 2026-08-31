/**
 * Historical live-server specification for the v0.6.0 API surface.
 *
 * The behaviours it described (users, rooms, DMs, logout, duplicate register
 * 409, unauthenticated 401, idempotent DMs, self-DM 400) now live in
 * `src/v06-api.test.ts` and run as part of `npm test`. WebSocket handshake
 * auth, REST send, and room membership stay as shipped in v0.4.0: upgrades
 * still require a token, and `send_message` is still a no-op (persist with
 * POST /messages). In-band `authenticate` / `typing` / global `presence`
 * frames were in this script and are not part of v0.6.0.
 *
 *   npm test
 *   npm run test:integration
 */
console.log('Moved to src/v06-api.test.ts (npm test).');
process.exit(0);

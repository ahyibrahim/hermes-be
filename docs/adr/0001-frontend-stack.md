# 0001 - Frontend stack for the web UI

- Status: Accepted
- Date: 2026-08-30
- Deciders: project author
- Affects: `hermes-fe` (primarily), `hermes-be` static asset serving

## Decision

The Hermes web UI will be built with **SvelteKit using `adapter-static`** — a
client-rendered single-page app with no SSR — living in `apps/web` inside the
`hermes-fe` npm workspaces monorepo and consuming the shared `packages/core`.

The realistic alternative was **React with Vite**. It was close enough to be
worth recording honestly.

`adapter-static` is part of the decision, not an implementation detail. See
Deployment below.

## Context

`hermes-fe` today is a roughly 600-line TypeScript readline CLI. It has to keep
working while the web UI is added: it is the only client that exists, and it is
in daily use.

The important thing about this choice is how contained it is. The bulk of the
migration — around 60 percent of the effort — is extracting a transport and
session core out of `cli.ts`: `resolveRoom()`, the `displayedMessageIds` dedup,
`handlePresence()` and the roster helpers, the socket handler routing, and
reconnect-then-rejoin, plus the three platform adapters for transport, file IO
and token storage. That work is framework-agnostic and identical under either
option. It ships as its own release (v0.3.0) with no UI risk at all.

So the framework choice only governs the view layer sitting on top of an already
UI-free core. That is a smaller and more reversible bet than the question first
appears to be, which is why it was reasonable to let a secondary consideration
(the learning goal) break the tie.

## Comparison

### Deployment shape — decisive

Both Vite and SvelteKit-with-`adapter-static` emit a directory of static assets:
HTML, JS, CSS. Fastify serves that directly with `@fastify/static` mounted on
`HERMES_WEB_DIR`. The result is one process to supervise, one origin, therefore
no CORS, and no change whatsoever to the existing Bearer-token auth model. The
bundle can even derive its API base URL from `window.location.origin`, so a
single artifact works against `p1` or a future `s1` on another port.

SvelteKit with the Node adapter and SSR would be a materially different system:
a second Node process to supervise on the host with its own systemd unit and
port, and SSR pushes hard toward `httpOnly` cookie auth, because server-rendered
pages cannot read a token out of `localStorage`. That would mean backend changes
to the auth model — cookie issuance, CSRF handling — for a chat app whose entire
UI is behind a login and has nothing to server-render or index.

This constraint is why the decision names `adapter-static` specifically rather
than SvelteKit generally. Under `adapter-static`, SvelteKit and Vite are
deployment-equivalent, and the choice reduces to the remaining points.

### Fit for a chat app

Svelte edges this. A chat UI is a WebSocket event stream mutating shared state:
a message list, a room roster, a presence set, a connection status. Svelte 5
runes and stores map onto that directly — a store fed by the core's event
emitter, components reacting to exactly the fields they read, with fine-grained
updates and no reconciliation pass.

React would work, but it would need `memo`, `useCallback` and `useMemo`
discipline to stop every inbound message re-rendering the whole thread, and it
would need a virtualized message list sooner rather than later. Both are
solvable and well-trodden; they are just extra work that Svelte does not ask
for.

### Speed to a working UI

React wins here, clearly. The component ecosystem is more mature: shadcn/ui and
Radix are better documented, more complete and more battle-tested than
shadcn-svelte, and there is far more prior art to copy for the fiddly parts of a
chat interface. Choosing Svelte costs some velocity on the first screens.

### Learning goal

The author wants SvelteKit familiarity for a different upcoming project. This is
a real reason and it is what broke the tie.

The honest caveat: SvelteKit's distinctive value is its routing, SSR, form
actions, and server endpoints. An SPA built with `adapter-static` against an
existing Fastify backend exercises almost none of that. There are no server
endpoints, no form actions, no load functions doing server work, and no SSR at
all. This project will teach Svelte-the-language properly — runes, stores,
components, transitions — and SvelteKit-the-framework only shallowly, mostly
client-side routing and project structure. Anyone reading this later should not
mistake it for evidence that SvelteKit's server story has been evaluated in
practice. It has not.

### The final product

Effectively identical. Users of a small private messenger will not be able to
tell which framework rendered it. Svelte ships a smaller bundle with no runtime
library to download, which is a genuine advantage that is completely irrelevant
here: the app is served over a tailnet or the local network from a machine a few
milliseconds away.

## Consequences

Positive:

- One process, one origin, no CORS. The Bearer-token auth model is untouched, so
  `hermes-be` needs only an `@fastify/static` mount that no-ops when
  `HERMES_WEB_DIR` is unset.
- The deploy artifact is a directory of files. `deploy.sh` unpacks it; there is
  nothing to supervise, health-check or restart on the frontend side, and
  rollback is unpacking the previous bundle.
- Reactive state maps cleanly onto the WebSocket event stream, so the UI layer
  stays thin over `packages/core`.
- The author gets the Svelte experience they wanted.

Negative, accepted:

- Slower start on UI components than React plus shadcn/ui would have been.
- A smaller ecosystem to borrow from for chat-specific widgets such as
  virtualized lists.
- No SSR means a blank shell until JS loads. Irrelevant for an authenticated
  app on a fast local network.
- The learning goal is only partly served, as recorded above.
- Reversibility is asymmetric in a useful way: because `packages/core` is
  framework-agnostic, replacing `apps/web` later costs the view layer only, not
  the transport, session or adapter work.

## Alternatives considered and rejected

**React with Vite.** The strongest alternative, and better on ecosystem maturity
and time-to-first-screen. Rejected because it is at best equal on deployment,
slightly worse on fit for a stream-driven UI, and does not serve the learning
goal. Had the ecosystem gap been load-bearing for this app, this would have won.

**SvelteKit with the Node adapter and SSR.** Rejected on deployment grounds: a
second process to supervise on the host, plus pressure to move auth to httpOnly
cookies and therefore change the backend, in exchange for SSR benefits that an
entirely-behind-login chat app cannot use.

**Plain Svelte with Vite, no SvelteKit.** Would have worked and is arguably the
most honest match to what is actually needed. Rejected because SvelteKit under
`adapter-static` costs nearly nothing over it, gives routing and project
structure for free, and leaves the door open to SSR later without a rewrite.

**Keep the CLI as the only client.** Rejected: non-technical members of the group
cannot use it, and file sharing and eventually voice chat need a browser.

**Server-rendered templates from Fastify, no SPA.** Rejected. A live chat UI
driven by a WebSocket event stream is exactly the case where a reactive client
framework pays for itself, and voice chat in v0.8.0 requires substantial
client-side JS regardless.

# Deploying hermes-be

hermes-be runs on `ying-1` as a systemd service under a dedicated `hermes` user,
one **instance** per environment. Code for an instance lives in
`/srv/hermes/<instance>/hermes-be` and its data in `/var/lib/hermes/<instance>/`.
Neither is the editable checkout at `/home/ai/Workspace/hermes-be`, and that
separation is the point: a deploy must never touch the working tree, and
`npm test` must never be able to reach real message history.

As of v0.3.0 deploying is a manual, deliberate act: publish a tag, SSH to the
host, run one script. See [what changes in v0.5.0](#what-changes-in-v050) and
[adr/0002-deployment-topology.md](adr/0002-deployment-topology.md) for why it is
built in that order.

## The instance model

| Instance | Exists | Purpose |
|----------|--------|---------|
| `p1` | now | Production. The one everybody uses. |
| `s1` | v0.6.0 | Staging, seeded from a copy of `p1`'s data, created purely to rehearse the v0.6.0 room-membership migration before `p1` is touched. |

`deploy/hermes-be@.service` is a systemd *template* unit, so an instance is
`hermes-be@p1`. Standing up `s1` later is one env file plus
`systemctl enable hermes-be@s1`, not a refactor. Nothing else in the roadmap is
risky enough to need a second environment, which is why only `p1` exists today.

## One-time host setup

**This step needs root**, because it creates a system user and writes under
`/srv`, `/var/lib`, `/etc` and `/etc/systemd/system`. Run it yourself; it is
deliberately not automated anywhere.

```sh
cd /home/ai/Workspace/hermes-be
sudo ./scripts/setup-host.sh p1
```

It is idempotent and safe to re-run. It:

1. creates the `hermes` system group and user, if absent (no login shell, no home)
2. creates `/srv/hermes/p1/`, `/var/lib/hermes/p1/files/` and `/etc/hermes/`
3. installs `/etc/hermes/p1.env` from `deploy/hermes.env.example`, rewriting the
   paths for the instance — and leaves it alone if it already exists
4. installs `deploy/hermes-be@.service` to `/etc/systemd/system/` and enables
   `hermes-be@p1` at boot

It does **not** start the service, because there is no code in
`/srv/hermes/p1/hermes-be` until the first deploy.

Review `/etc/hermes/p1.env` afterwards, particularly `PORT`.

### Optional: seeding an existing database

There is a one-time copy of an existing development database into the instance
data directory, opt-in:

```sh
sudo HERMES_SEED_FROM=/home/ai/Workspace/hermes-be/data ./scripts/setup-host.sh p1
```

It copies `hermes.db` and anything under `files/` that is not already there, and
refuses to overwrite an existing database.

**`data/hermes.db` does not currently exist in the dev workspace** — only
`data/files/`. So for a fresh install this is a no-op and the schema is created
by `migrateSchema()` on the first start of the service. Leave `HERMES_SEED_FROM`
unset unless you know there is a database worth carrying over.

## Deploy runbook

1. **Pick or publish a tag.** Deploys are always by tag, never by branch. Tag on
   the release branch and push the tag:

   ```sh
   git tag v0.3.0
   git push origin v0.3.0
   ```

   Pushing a tag does not deploy anything, in this release or later ones.

2. **SSH to the host.**

   ```sh
   ssh ying-1
   ```

3. **Run the deploy.**

   ```sh
   cd /home/ai/Workspace/hermes-be
   sudo ./scripts/deploy.sh p1 v0.3.0
   ```

   The script checks the tag out into `/srv/hermes/p1/hermes-be` as the `hermes`
   user, runs `npm ci` and `npm run build`, writes the deployed commit into
   `/etc/hermes/p1.env` as `HERMES_GIT_COMMIT`, restarts `hermes-be@p1`, and then
   polls `/health` until it reports the version and commit that were just
   deployed. It exits non-zero with the `journalctl` command to run if it does
   not see them within 90 seconds (`HERMES_HEALTH_TIMEOUT`).

4. **Confirm.**

   ```sh
   curl -s http://127.0.0.1:3000/health
   ```

   ```json
   {"status":"ok","service":"hermes-be","message":"Backend is running","version":"0.3.0","commit":"<sha>"}
   ```

### Migrations

There is no separate migrate command. `migrateSchema()` runs on every process
start, so **restarting the service is the migration**. Every schema change up to
v0.6.0 is additive (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN`), which is what
makes redeploying an older tag a safe rollback without a restore.

The one exception is called out in the roadmap: take a manual copy of `p1`'s
`hermes.db` immediately before the v0.6.0 membership migration, which rewrites
message history in place.

### Rolling back

Redeploy the previous tag:

```sh
sudo ./scripts/deploy.sh p1 v0.2.0
```

There is no automated rollback in v0.3.0. It arrives in v0.5.0, wired to a failed
health check.

## Environment variables

All of these are read from `/etc/hermes/<instance>.env` by the systemd unit
(`EnvironmentFile=/etc/hermes/%i.env`). `deploy/hermes.env.example` is the
template, carrying `p1`'s values.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | Port the server binds, on `0.0.0.0`. Give a second instance a different one. |
| `HERMES_DB_PATH` | `./data/hermes.db` | SQLite file. Created if absent, migrated in place on every start. Must be inside the unit's `ReadWritePaths`. `p1` uses `/var/lib/hermes/p1/hermes.db`. |
| `HERMES_FILES_DIR` | `./data/files/` | Upload directory, created if absent. `p1` uses `/var/lib/hermes/p1/files`. |
| `HERMES_SESSION_TTL_DAYS` | `30` | Login token lifetime in days. Values that are not a positive number fall back to the default. |
| `LOG_LEVEL` | `info` | Pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`. JSON to stdout. |
| `HERMES_GIT_COMMIT` | unset | Commit reported by `/health`. `deploy.sh` rewrites this on every deploy; no need to set it by hand. Unset means `/health` asks git, then reports `unknown`. |
| `HERMES_WEB_DIR` | unset | Static web bundle directory. **Arrives in v0.4.0** and is commented out in the example; unset is a no-op. |

Note that `HERMES_SESSION_TTL_DAYS` is now the real logout interval. Before
v0.3.0 tokens lived in an in-memory `Map`, so every restart signed everyone out;
sessions are rows in SQLite now and survive restarts.

The systemd `EnvironmentFile` format is not shell: no `export`, no command
substitution, and quotes are only needed for values containing spaces.

## Service status and logs

hermes-be logs JSON to stdout. The unit's stdout is journald, which owns
retention; there are no log files and no logrotate config. Each request line
carries a `reqId`. Domain events (login, websocket, room join, file upload,
each `migrateSchema()` step) are logged at `info` and never include a password,
a token, message content, or file contents.

Pretty-print is local-only: `pino-pretty` is a **devDependency**, and it is
used only when stdout is a TTY (`npm run dev` in a terminal). systemd never
attaches a TTY, so `journalctl` always sees JSON.

```sh
systemctl status hermes-be@p1
journalctl -u hermes-be@p1 -f              # follow
journalctl -u hermes-be@p1 -n 100 --no-pager
journalctl -u hermes-be@p1 --since "1 hour ago"
journalctl -u hermes-be@p1 -o cat          # JSON lines, no journald prefix
journalctl -u hermes-be@p1 | grep login_failure
```

Change the level by editing `LOG_LEVEL` in `/etc/hermes/p1.env` and restarting:

```sh
sudo systemctl restart hermes-be@p1        # also re-runs migrations
sudo systemctl stop hermes-be@p1
```

`info` is the default and is what production should run. `debug` is noisier
request logging; `silent` turns the logger off, which is what `npm test` uses.

What is **not** logged: the `Authorization` header, the `token` query
parameter, any `password` field, message bodies, and uploaded file bytes.
Those are redacted or never written, so they must not appear in journald.

The unit restarts on failure with a 5 second backoff and gives up after 5 failed
starts in 5 minutes, so a service that is down and staying down means
`systemctl status` will say `failed` rather than looping quietly.

### When something is wrong

- **`/health` reports the old version or commit.** The restart did not pick up
  the new build, or the build did not land. Check
  `journalctl -u hermes-be@p1 -n 50` and that
  `/srv/hermes/p1/hermes-be/dist/server.js` is newer than the deploy.
- **`EACCES` or `SQLITE_CANTOPEN` writing the database.** `HERMES_DB_PATH` is
  outside `ReadWritePaths=/var/lib/hermes/%i`, or the file is not owned by
  `hermes`. `ProtectSystem=strict` makes everything else read-only on purpose.
- **The unit will not start at all.** `systemd-analyze verify
  /etc/systemd/system/hermes-be@.service`, and check `/etc/hermes/p1.env` exists
  — a missing `EnvironmentFile` fails the unit.

## What changes in v0.5.0

The manual step above becomes a GitHub Actions job on a self-hosted runner on
`ying-1`, triggered by **publishing a GitHub Release** (plus a
`workflow_dispatch` button taking a tag, for redeploys and rollbacks). It calls
this same `scripts/deploy.sh`; CI gains only the trigger, the cross-repo
hermes-fe web-bundle fetch, and rollback. That is why the script exists in this
release rather than being written later.

Two things worth knowing now, because both are easy to get wrong:

- **Pushing a tag will not deploy.** Only publishing a Release fires
  `release: published`. Pushing to `main` is likewise always safe.
- **Editing an already-published Release does not re-fire the event.** That is
  what the dispatch button is for.

Full detail, including the hardening rules for a self-hosted runner on a public
repository, is in [adr/0002-deployment-topology.md](adr/0002-deployment-topology.md).

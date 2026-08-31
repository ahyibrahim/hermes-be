# 0002 - Deployment topology

- Status: Accepted for the host shape (template unit, `deploy.sh`, `p1`).
  CI wiring deferred.
- Date: 2026-08-30 (CI wiring deferred 2026-09-01)
- Deciders: project author
- Affects: `hermes-be` (runner, service, instances), `hermes-fe` (release build)
- Implemented across: v0.3.0 (service and manual script). Self-hosted runner
  and release workflows are backlog, blocked on making hermes-be private
  ([be#35](https://github.com/ahyibrahim/hermes-be/issues/35)).

## Decision

**Shipped:** per-instance systemd units from a template, and `deploy.sh` written
once in v0.3.0, invoked by hand.

**Deferred:** one self-hosted GitHub Actions runner on `ying-1`, fired by
publishing a GitHub Release, calling that same `deploy.sh`. A runner on a
public repo is a path for a fork pull request to execute code on the machine
that holds the live database. That work does not resume until hermes-be is
private. The original “repos stay public + workflow discipline” alternative is
what this deferral reverses.

## Context

`ying-1` is this same machine — `hostname` reports `YING` — and it is not
reachable from the public internet. It sits on a tailnet. Releases need to be
publishable from any device, including a laptop that has no host credentials and
may not be on the tailnet at the time. Today deploying means pulling and
restarting by hand on the host.

## The runner

One self-hosted runner on `ying-1`, registered to `hermes-be`, installed via
`svc.sh install` so it starts at boot and picks up work with nobody logged in.

The reason this shape was chosen is that the runner **polls GitHub over outbound
HTTPS**. Nothing needs to reach in. Concretely:

- No inbound access to the host, and no port forwarding or public exposure.
- No tailnet path from GitHub, and no tailnet credentials in GitHub.
- No credentials on the device doing the publishing. Publishing a Release is a
  GitHub action, not an SSH session.

A release published from any device therefore triggers a deploy on a host that
GitHub cannot address.

`hermes-fe` does **not** get a self-hosted runner. It builds its static bundle on
a GitHub-hosted runner and publishes `build/` as a release asset. So exactly one
self-hosted runner exists in the whole system, which keeps the risky surface as
small as possible. Because both repos are public, the `hermes-be` deploy can
fetch that asset with the default `GITHUB_TOKEN`; no cross-repo PAT secret is
needed anywhere.

## The trigger

`release: published`, plus `workflow_dispatch` with a required `tag` input.

Two behaviours are worth stating explicitly, because both are easy to get wrong:

- **Pushing a git tag does not deploy.** Only publishing a GitHub Release fires
  `release: published`. Tagging locally, and pushing tags, remain safe
  operations. Pushing to `main` is likewise safe. Deploying is always a
  deliberate, separate act.
- **Editing an already-published Release does not re-fire `published`.** The
  event fires once. Without another way in, redeploying the same version would
  mean deleting and recreating the Release, which is both awkward and
  destructive of release notes.

That second point is the whole reason the `workflow_dispatch` button exists: it
takes a tag as input, so any released version can be redeployed or rolled back
from the Actions tab. Dispatch is restricted to accounts with write access, so it
does not widen the attack surface.

## Public-repo self-hosted runner hardening

A self-hosted runner on a **public** repository is the one genuinely dangerous
part of this design. The failure mode is specific: if a workflow that runs on the
self-hosted runner can be triggered from a fork, then anyone in the world can
open a pull request whose workflow executes arbitrary code as the runner user on
the machine holding the live message database.

These are hard rules, in order of importance:

1. **Never attach a `pull_request` trigger to any workflow that runs on the
   self-hosted runner.** The deploy workflow triggers only on
   `release: published` and `workflow_dispatch`, neither of which a fork can
   fire.
2. **Pin every test and build workflow to `ubuntu-latest`.** `.github/workflows/`
   test workflows carry a header comment saying so. They have a `pull_request`
   trigger, so they must stay GitHub-hosted, permanently.
3. **Require approval for all outside collaborators' fork PR workflows**, in
   Settings > Actions > General. This is the setting that substitutes for making
   the repos private.
4. **Keep the sudoers rule to two verbs.** The runner user may run only
   `systemctl restart hermes-be` and `systemctl status hermes-be` without a
   password. Nothing else. A compromise of the runner then cannot trivially
   escalate to root.

Rules 1 and 2 are the same rule seen from both ends, and together they are the
security boundary: fork-triggerable workflows never touch the host, and
host-touching workflows are never fork-triggerable.

## Environments

A **template** systemd unit, `hermes-be@.service`, from the very start:

- Environment file per instance: `/etc/hermes/%i.env`, supplying `PORT`,
  `HERMES_DB_PATH`, `HERMES_FILES_DIR` and `HERMES_WEB_DIR`.
- Code checkout per instance: `/srv/hermes/<instance>/hermes-be`.
- Data per instance: `/var/lib/hermes/<instance>/` holding `hermes.db` and
  `files/`.
- Runs as a dedicated `hermes` service user.

Only **`p1`** runs initially, enabled as `hermes-be@p1`. The template is not
speculative generality; it is what makes standing up a second instance one env
file and one `systemctl enable` rather than a refactor.

**`s1` is stood up just before the v0.6.0 membership migration**, seeded from a
copy of `p1`'s database and files, purely to rehearse that migration on real data
and confirm existing history survives before `p1` is touched. That migration —
an in-place rewrite of `room_members` from the slug-and-username model to the
foreign-key model — is the only change in the roadmap risky enough to justify a
staging environment, so that is exactly when one appears.

This also resolves a live hazard: the production database currently sits at
`data/hermes.db` inside the editable checkout at `/home/ai/Workspace/hermes-be`.
Once this box is the host, a deploy touching the working tree is destructive and
an errant `npm test` can clobber real history. v0.3.0 separates the two with a
documented one-time copy.

## Split rollout

The deploy logic is written **once**, in two stages:

- **v0.3.0**: the host becomes a real systemd service and `scripts/deploy.sh`
  lands, taking the instance as its first argument, runnable by hand over SSH. It
  fetches a tag, runs `npm ci` and `npm run build`, migrates, restarts the unit,
  and polls `/health` for the expected version.
- **CI wiring (backlog):** CI calls that same script. CI gains only the trigger,
  the cross-repo web-asset fetch (with a short retry backoff, since the two repos
  release independently and the `hermes-fe` bundle may still be uploading), and
  rollback. Deferred until hermes-be is private.

The point is that automation is not a rewrite of the deploy path. Until CI
wiring lands, the gap between a tagged tree and production is one SSH command
(`deploy.sh`) rather than a manual build.

## No automated backups in `deploy.sh`

Deliberate. Every schema change up to v0.6.0 is additive —
`CREATE TABLE IF NOT EXISTS` and `ADD COLUMN` — and rollback is redeploying the
previous tag, which those additive migrations survive. A backup step on every
deploy would add failure modes and disk churn for a friend-group messenger whose
data is not irreplaceable.

The single explicit exception: **take a manual copy of `p1`'s `hermes.db`
immediately before the v0.6.0 membership migration.** That one rewrites live
message history in place, so it needs a deliberate copy rather than a habitual
one. This is called out in `docs/ROADMAP.md` under v0.6.0 and belongs in
`docs/DEPLOY.md` as a runbook step.

## Consequences

Positive:

- The host is never inbound-reachable from GitHub, and no host credentials leave
  the host.
- Publishing a Release from a phone or a laptop deploys, with no tailnet
  connection required at the time.
- Exactly one self-hosted runner, so the hardening rules apply in one place.
- Both repos public means no PAT for the cross-repo asset fetch and no Actions
  minutes quota.
- Rollback and redeploy are a dispatch button with a tag, not a Release surgery.

Negative, accepted:

- A self-hosted runner on a public repo needs the hardening rules above followed
  permanently. This is the main ongoing risk and the reason ADR-referencing
  comments sit in the workflow files and the PR template.
- The runner is a long-lived agent on the same machine as the live database.
- No automated backups, mitigated as described.
- Release-day ordering matters: publish the `hermes-fe` release first, let its
  bundle finish uploading, then publish `hermes-be`. The retry backoff makes this
  a soft rule rather than a hard one.
- Two repos releasing independently means two version numbers to keep in step.

## Alternatives considered and rejected

**GitHub-hosted runner joining the tailnet, then deploying over SSH** (via
`tailscale/github-action`). Rejected: it requires a Tailscale auth key and an SSH
key as GitHub secrets, so a workflow compromise yields tailnet access and host
login, and it puts credentials in the cloud in exchange for removing a local
agent. The polling runner needs no inbound path and no stored keys.

**Plain manual `deploy.sh` over SSH, no CI at all.** This is the production path
until hermes-be is private and the backlog issues are scheduled. It requires
being on the tailnet with host credentials to ship anything.

**Making hermes-be private.** Originally rejected (a PAT, Actions minutes, no
help for publishing). Reopened as the **blocker** for any self-hosted runner
([be#35](https://github.com/ahyibrahim/hermes-be/issues/35)). hermes-fe can stay
public so the web asset stays fetchable without a PAT. If both become private,
that PAT cost returns.

**Deploy on every push to `main`.** Rejected: it makes merging and deploying the
same act, removes the ability to deploy an older version deliberately, and offers
no natural rollback target. Releases give explicit, named, redeployable versions.

**Docker or containers.** Rejected as disproportionate. One Node process, one
SQLite file, one host. A template systemd unit already gives per-instance
isolation of config and data, which is all the isolation this needs, without
adding an image build and registry to the release path.

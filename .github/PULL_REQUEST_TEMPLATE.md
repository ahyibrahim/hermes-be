## Summary

One or two sentences on what this changes and why.

## What changed

-

## How tested

- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] Manual check, described below

Manual steps taken, and against which instance or a local throwaway database:

## Schema and compatibility

- [ ] No schema change
- [ ] Schema change, additive only (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN`)
- [ ] Schema change that rewrites existing rows — rehearsed on `s1`, manual
      `hermes.db` copy taken, migration path documented

- [ ] No change needed in hermes-fe
- [ ] Needs a matching hermes-fe change — linked below

## Related issue

Closes #

## Checklist

- [ ] CI stays pinned to `ubuntu-latest`; no `pull_request` trigger added to any
      self-hosted workflow (see `docs/adr/0002-deployment-topology.md`)
- [ ] No real data committed; `data/` untouched
- [ ] `docs/ROADMAP.md` updated if release scope moved

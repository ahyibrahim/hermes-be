---
name: Feature request
about: Propose a change or addition to hermes-be
title: ''
labels: enhancement
assignees: ''
---

## Problem

What is awkward or missing today.

## Proposal

## Target release

Which release in [docs/ROADMAP.md](../../docs/ROADMAP.md) this belongs to, and
why. Add the matching `release:vX.Y.Z` label. If it does not fit an existing
release, say so.

## Surface affected

- New or changed endpoints:
- New or changed WebSocket message types:
- Schema change: yes / no. If yes, does it rewrite existing rows?
- Does hermes-fe need a matching change?

## Alternatives considered

## Notes

Schema changes that rewrite live message history need a rehearsal on the `s1`
instance and a manual database copy first. See
[docs/adr/0002-deployment-topology.md](../../docs/adr/0002-deployment-topology.md).

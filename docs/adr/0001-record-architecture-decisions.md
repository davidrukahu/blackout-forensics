<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: LicenseRef-Proprietary
-->

# 0001. Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-08-06


## Context

This project's decisions are unusually load-bearing: several of them determine whether the product is
lawful to operate, whether its licence model funds the business, and whether its evidence is
defensible. A decision whose reasoning is lost cannot be safely revisited — someone will either
cargo-cult it or reverse it without knowing what it was protecting.

## Decision

Record significant decisions as ADRs in `docs/adr/NNNN-slug.md`, MADR format, numbered sequentially
and never renumbered. A superseded ADR stays in place with its status changed and a pointer forward.

The wayfinder map at `.scratch/blackout-v1/map.md` holds the fuller reasoning and the evidence trail;
ADRs are the durable in-repository summary that survives the map.

## Consequences

Decisions become reviewable by someone who was not present. The cost is discipline: an ADR that is
written after the fact, to justify rather than to decide, is worse than none.

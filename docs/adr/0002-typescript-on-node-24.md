<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: LicenseRef-Proprietary
-->

# 0002. TypeScript everywhere on Node 24 LTS

- **Status:** Accepted
- **Date:** 2026-08-06
- **Source:** `.scratch/blackout-v1/issues/07-language-and-framework.md`

## Context

The system spans a batch analytical container, deterministic background workers and an accessible
server-rendered web application. PRD §12.2 targets 500 events/sec sustained, 2,000 burst, and ten
million events in two hours. PRD §12.6 requires core domain functions to be deterministic and
testable without network access.

This is a solo cold start with no customer and no revenue.

## Decision

TypeScript for everything — domain core, workers, audit container and web application — on Node 24
LTS. Vitest for tests, `fast-check` for the property and fuzz layer PRD §15.1 mandates, and
Testcontainers for integration tests against real Postgres and PostGIS.

## Consequences

The throughput targets are modest and the heavy work is SQL-shaped aggregation rather than hot-loop
computation, so it belongs in the database regardless of host language — which removes the main
performance argument for Go. One language means one test harness, one schema codegen path and one
CI pipeline, which is what a solo maintainer can actually sustain.

**Cost accepted:** a Node container is a worse artefact to hand a customer's security team than a
static binary — larger, with a runtime to audit. Revisit if a customer security review rejects it.

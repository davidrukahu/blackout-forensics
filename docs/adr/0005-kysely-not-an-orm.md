<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: LicenseRef-Proprietary
-->

# 0005. Kysely over an ORM, for tenant isolation rather than ergonomics

- **Status:** Accepted
- **Date:** 2026-08-06
- **Source:** `.scratch/blackout-v1/issues/07-language-and-framework.md`

## Context

PRD §11.1 requires that production application roles neither own tenant tables nor hold BYPASSRLS,
and that background jobs set an explicit tenant context. Every transaction must issue
`SET LOCAL app.tenant_id` before its queries. PRD §17.5 makes cross-tenant negative tests — for read,
write, export and background jobs — a release gate.

## Decision

Kysely as a typed query builder over the `postgres.js` driver, with raw SQL for PostGIS, H3 and
analytical work. No ORM.

## Consequences

An access layer that hides connection and transaction lifecycle makes the `SET LOCAL` guarantee hard
to enforce and harder to test — and an untestable tenant boundary is an unshippable one here. Kysely
keeps transactions explicit and SQL visible, which also suits geospatial work that ORMs serve poorly.

**Cost accepted:** more verbose data access than Prisma or Drizzle, and no generated migration
tooling — migrations are plain SQL via dbmate.

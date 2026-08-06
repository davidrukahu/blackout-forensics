<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: AGPL-3.0-only
-->

# Blackout Forensics

A vendor-neutral evidence and recovery-control system for financed motorcycles and vehicles.

When a GPS tracker stops reporting, a financier cannot tell expected sleep from a coverage gap, a
platform delay, a dead SIM, a disconnected battery, a failed device, interference, or theft. This
system turns that silence into an evidence record, a probable explanation with counterevidence, and
a prioritised queue that a human works.

**It never decides anything consequential.** It cannot repossess, immobilise, contact a borrower,
change credit state or dispatch a recovery. Priority means investigation order — not proof, blame or
authorisation.

## Repository layout

| Package | Licence | Contents |
|---|---|---|
| `packages/spec` | Apache-2.0 | Canonical event schema, adapter manifest contract, conformance fixtures. Published publicly. |
| `packages/core` | AGPL-3.0-only | Episode engine, evidence rules, queue domain, audit. |
| `packages/connectors` | Apache-2.0 | Source adapters and conformance kit. |
| `packages/sdk` | Apache-2.0 | Client libraries. |
| `packages/app` | AGPL-3.0-only | Server-rendered queue, case review, reports, administration. |

## Stack

TypeScript on Node 24 LTS. Postgres/PostGIS as the single query engine — including inside the audit
container, so it runs the identical analyser code the product runs. React Router 7 for the web
application. Vitest, `fast-check` and Testcontainers. Kysely over `postgres.js`, chosen so
`SET LOCAL app.tenant_id` stays explicit and testable.

## Where the decisions live

`.scratch/blackout-v1/map.md` is the decision record — every settled question, its reasoning and
what later evidence changed. `.taskmaster/` is the execution backlog; run `task-master next`.

    npm install
    npm run check

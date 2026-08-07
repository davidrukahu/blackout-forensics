<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: AGPL-3.0-only
-->

# Developer guide

## Prerequisites

- Node 24 LTS (`.nvmrc` pins it)
- Docker (integration tests and benchmarks start disposable Postgres 16 containers)
- `pipx` (licence lint)

## The synthetic end-to-end demonstration

Every step below is exercised in CI; a new engineer should get from clone to a working queue in
about ten minutes.

```bash
npm ci
npm run check              # typecheck (all packages incl. app), unit tests, schema build,
                           # synthetic-tenant guard, public-spec export
npm run test:integration   # Postgres-backed suites: stores, RLS, replay, geo, retention,
                           # security probes, Release A/B acceptance, DR restore exercise
npm run dev -w @blackout/app
```

Open <http://localhost:5173>. The queue is seeded by running every reference scenario through the
real sampler and classifier — no hand-typed rows. The urgent row is the power-cut scenario firing
H-POWER with direct evidence. Claim it, open the case, propose `classify_suspicious` with the
canonical reason, switch role to supervisor (cookie `bf-role=supervisor`) and approve: the
timeline records both people. That walk is the same one `packages/app/src/release-c.e2e.test.ts`
performs, and it writes `release/release-c-e2e.json`.

## Repository layout

| Package | What it is |
| --- | --- |
| `packages/spec` | Public interoperability spec (Apache-2.0): canonical event, bundle schema, conformance fixtures |
| `packages/core` | The forensic engine (AGPL): temporal model, sampler, lifecycle, rules, classifier, corridor, correlation, retention, reporting, security |
| `packages/connectors` | Import adapters (Traccar live rig under `src/traccar`) |
| `packages/generator` | Synthetic corpus: baselines over real Nairobi corridors, 14 damage scenarios with ground truth |
| `packages/app` | React Router 7 server-rendered analyst app |
| `packages/audit` | Telemetry Control Audit pipeline and CLI (ships in the audit container) |
| `packages/sdk` | Client SDK scaffold |

## The gates

- `npm run check` — must pass before any commit lands.
- `npm run test:integration` — Postgres-backed; run before merging anything that touches storage.
- `pipx run reuse lint` — the licence boundary (AGPL core / Apache spec) is machine-checked.
- The classification baseline (`packages/core/src/rules/fixtures/classification-baseline.json`)
  is §15.5's regression gate: a rule change that shifts any scenario's classification fails the
  diff test until the snapshot is regenerated deliberately, and that regeneration is the diff an
  approver signs — in the same commit, with the explanation.

## Conventions that are enforced, not requested

- No customer telemetry, ever: every tenant id in tests and fixtures starts with `synthetic_`
  (`npm run check:synthetic` fails otherwise).
- Workspace imports resolve to *source* under vitest (see `vitest.config.ts`) so tests can never
  pass against a stale build.
- Never key customer attributes on OSM feature ids; the tenant schema bans raw geometry
  (`FORBIDDEN_IN_TENANT_SCHEMA`).
- Database access goes through `withTenant()` — there is no unscoped accessor to reach for.

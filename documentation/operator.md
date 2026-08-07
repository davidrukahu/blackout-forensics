<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: AGPL-3.0-only
-->

# Operator guide

The deployment unit is a customer-run container (ADR 0011): your data never leaves your
infrastructure, and the audit container ships with its own Postgres/PostGIS.

## Running

- Postgres 16, non-superuser roles: `bf_migrator` owns objects, `bf_app` uses them,
  `bf_retention` may DELETE and nothing else. A superuser bypasses row-level security — never
  run the application as one (the schema file repeats this warning).
- Apply `packages/core/src/db/schema.sql` with `bf_migrator`. RLS with FORCE is applied by a
  loop over every table — partitions do not inherit policies, so new partitions must go through
  `core.apply_tenant_rls()`.
- Monthly partitions exist for `core.raw_receipt` and `core.observation`; create the next month
  before it starts.

## Backups and disaster recovery

Targets (NFR-DR-001/002, embedded in code as `DR_TARGETS`): 15-minute RPO, four-hour RTO, daily
base backup plus 5-minute WAL shipping, 35-day rolling retention, quarterly restore exercise.

- `backupStatus()` computes the daily health record from your artifact list; wire it to your
  monitoring. It reports the *realized* RPO in minutes and names every reason it is not healthy.
- The quarterly exercise is evaluated by `evaluateExercise()` — rows, RLS policies, append-only
  triggers and an object-store sample must all verify, and the realized RTO/RPO are computed from
  the run's own timestamps. A failed exercise does not reset the quarterly clock.
- The full procedure is `RECOVERY_RUNBOOK` (also in [runbooks.md](runbooks.md)). A committed
  example record from a real timed run is `release/dr-exercise.json`.

## Retention

Defaults are PRD §11.4's table (see [dpo.md](dpo.md)). Runs are planned deterministically,
executed as `bf_retention`, and evidenced by tombstones in `audit.event` written in the same
transaction as each deletion. Legal holds block deletion item-by-item and visibly. See
`packages/core/src/retention/` and the integration test for the exact semantics.

## Capacity

`release/benchmark-smoke.json` is the committed smoke-tier run: ~54k events/s ingest against the
500/s sustained target, read p95s of 1–2 ms against 2 s budgets, on an M-series laptop with
containerized Postgres. **The smoke tier is not benchmark evidence** — §12.2 requires the
reference tier (`npm run bench:reference`, ten-minute burst, ten-million-event batch) on
published hardware before any number is quoted externally. The disclaimer is embedded in the
results file so it cannot be detached.

## Support bundles

Only `buildSupportBundle()` output is safe to share: it is allowlist-constructed and scanned for
coordinates, phone numbers, IMEIs and emails on the way out — a bundle that might leak throws
instead of existing. Never attach raw logs; route them through `safeLogLine()` first.

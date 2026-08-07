<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: AGPL-3.0-only
-->

# Runbooks

Each runbook is tested where a test can reach it; the test is named so you can rehearse.

## 1. Upgrade

1. Read the release notes for the target version; verify the release signature against
   `release/allowed_signers` (`ssh-keygen -Y verify`).
2. Take a base backup; confirm `backupStatus()` is healthy before touching anything.
3. Apply the new container image. Schema changes ship as idempotent `CREATE ... IF NOT EXISTS` /
   `CREATE OR REPLACE` statements in `schema.sql`, applied by `bf_migrator` — re-running the file
   is the migration mechanism, and it is what every integration test does from scratch.
4. Run the smoke checks: `npm run check` in the container build, then the health endpoint.
5. If the classification baseline changed in this release, the diff was signed in the release
   commit — read it before resuming review work.

## 2. Rollback

1. Stop the application (never the database) — episodes and receipts are append-only, so a
   newer app version cannot have destroyed prior data.
2. Redeploy the previous image (previous signature also in `allowed_signers`).
3. Schema is forward-compatible by construction (additive statements); if a release ever ships
   a breaking schema change, its notes carry the specific rollback file. None has.
4. Verify with the same smoke checks as an upgrade.

## 3. Restore / disaster recovery

`RECOVERY_RUNBOOK` in `packages/core/src/dr/backup.ts`, tested end-to-end (timed, verified) in
`packages/core/src/dr/restore-exercise.int.test.ts`; a real run's record is
`release/dr-exercise.json`.

1. Declare the incident and record the point-in-time recovery target.
2. Provision clean Postgres 16 from the container image.
3. Restore the newest base backup; verify its checksum against the backup record.
4. Replay WAL to the target — the gap between target and last segment is the realized RPO.
5. Verify: row counts, RLS policies, append-only triggers, object-store sample.
6. Repoint the application; start-to-serving duration is the realized RTO.
7. File the exercise record; two-person review if any verification failed.

## 4. Incident

See [incident-response.md](incident-response.md).

## 5. Data deletion (subject request or contract end)

1. Check active legal holds for the scope; a hold blocks deletion and the plan will say so
   item-by-item. Resolve or release (audited) first.
2. Build the inventory (e.g. `receiptInventory()`), plan with `planRetention()` using a policy
   whose relevant class is due, review the plan — every kept item states why.
3. Execute as `bf_retention` (`PostgresRetentionExecutor`): each deletion and its tombstone are
   one transaction. Tested in `packages/core/src/db/retention.int.test.ts`.
4. Hand the requester the tombstone evidence: item refs, run id, policy version, and the date
   after which no backup generation can contain the data (35-day window).
5. Diarize that date; `overdueBackups()` flags generations that should already be gone.

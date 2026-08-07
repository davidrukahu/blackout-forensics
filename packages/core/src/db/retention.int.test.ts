// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * §11.4 retention against a real database.
 *
 * The claims that need Postgres to prove: the app role cannot delete at all; the retention role
 * can delete and nothing else; a deletion and its tombstone are one transaction; a legal hold
 * blocks the plan; and a re-run over the tombstoned inventory is a no-op.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { executeRetention, planRetention, type LegalHold } from '../retention/retention.js'
import { PostgresRetentionExecutor, receiptInventory, tombstonedRefs } from './retention-store.js'
import { withTenant } from './tenant.js'

const SCHEMA = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8')
const TENANT = 'synthetic_ret'
const NOW = '2026-08-08T00:00:00.000Z'
const daysAgo = (days: number): string =>
  new Date(Date.parse(NOW) - days * 86_400_000).toISOString()

let container: StartedPostgreSqlContainer
let root: Sql
let app: Sql
let retention: Sql

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  root = postgres(container.getConnectionUri(), { max: 2, onnotice: () => {} })
  await root.unsafe(SCHEMA)
  await root.unsafe(`
    DROP ROLE IF EXISTS bf_app;
    CREATE ROLE bf_app LOGIN PASSWORD 'app-password' NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA core, audit TO bf_app;
    GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA core, audit TO bf_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core, audit TO bf_app;

    -- §11.4's documented exception: DELETE and nothing else beyond read/insert-tombstone.
    DROP ROLE IF EXISTS bf_retention;
    CREATE ROLE bf_retention LOGIN PASSWORD 'ret-password' NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA core, audit TO bf_retention;
    GRANT SELECT, DELETE ON ALL TABLES IN SCHEMA core TO bf_retention;
    GRANT SELECT, INSERT ON audit.event TO bf_retention;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA audit TO bf_retention;
  `)
  // Old enough data to be due needs partitions the shipping schema no longer carries.
  await root.unsafe(`
    CREATE TABLE IF NOT EXISTS core.raw_receipt_2026_06
      PARTITION OF core.raw_receipt FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
    CREATE TABLE IF NOT EXISTS core.raw_receipt_2026_07
      PARTITION OF core.raw_receipt FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
    SELECT core.apply_tenant_rls('core.raw_receipt_2026_06');
    SELECT core.apply_tenant_rls('core.raw_receipt_2026_07');
    GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA core TO bf_app;
    GRANT SELECT, DELETE ON ALL TABLES IN SCHEMA core TO bf_retention;
  `)

  const appUri = new URL(container.getConnectionUri())
  appUri.username = 'bf_app'
  appUri.password = 'app-password'
  app = postgres(appUri.toString(), { max: 4, onnotice: () => {} })

  const retUri = new URL(container.getConnectionUri())
  retUri.username = 'bf_retention'
  retUri.password = 'ret-password'
  retention = postgres(retUri.toString(), { max: 4, onnotice: () => {} })

  // Seed: one receipt long past the 30-day default, one fresh.
  await withTenant(app, TENANT, async (tx) => {
    await tx`INSERT INTO core.raw_receipt (tenant_id, source, batch_id, raw_sha256, received_at, byte_length)
      VALUES (${TENANT}, 'traccar', 'b1', ${'e'.repeat(64)}, ${daysAgo(60)}, 100),
             (${TENANT}, 'traccar', 'b2', ${'f'.repeat(64)}, ${daysAgo(5)}, 100)`
  })
}, 180_000)

afterAll(async () => {
  await app?.end({ timeout: 5 })
  await retention?.end({ timeout: 5 })
  await root?.end({ timeout: 5 })
  await container?.stop()
})

describe('roles', () => {
  it('the app role cannot delete a receipt, even its own', async () => {
    await expect(
      withTenant(app, TENANT, (tx) => tx`DELETE FROM core.raw_receipt WHERE batch_id = 'b1'`),
    ).rejects.toThrow(/append-only|permission denied/)
  })

  it('the retention role cannot UPDATE — delete is the whole exception', async () => {
    await expect(
      withTenant(retention, TENANT, (tx) => tx`UPDATE core.raw_receipt SET byte_length = 0`),
    ).rejects.toThrow(/append-only|permission denied/)
  })
})

describe('a full retention run', () => {
  it('deletes what is due, tombstones it, honours holds, and re-runs as a no-op', async () => {
    const inventory = await receiptInventory(app, TENANT)
    expect(inventory).toHaveLength(2)

    // First: a hold over the tenant blocks everything, visibly.
    const hold: LegalHold = {
      id: 'hold-t', scope: { tenantId: TENANT, entireTenant: true },
      authority: 'demand letter', placedBy: 'counsel', placedAt: daysAgo(10),
      reviewAt: NOW, releasedBy: null, releasedAt: null,
    }
    const heldPlan = planRetention({ items: inventory, holds: [hold], now: NOW })
    expect(heldPlan.deletions).toEqual([])
    expect(heldPlan.kept.filter((k) => k.reason === 'legal_hold')).toHaveLength(2)

    // Released: the 60-day receipt is due; the 5-day one is not.
    const plan = planRetention({ items: inventory, holds: [], now: NOW })
    expect(plan.deletions.map((d) => d.ref)).toEqual(['e'.repeat(64)])

    const executor = new PostgresRetentionExecutor(retention, TENANT, {
      runId: plan.runId,
      policyVersion: plan.policyVersion,
      purgedFromBackupsBy: plan.deletions[0]!.purgedFromBackupsBy,
    }, () => NOW)
    const report = await executeRetention(plan, executor, NOW)
    expect(report.deleted).toBe(1)
    expect(report.failed).toEqual([])

    const remaining = await receiptInventory(app, TENANT)
    expect(remaining.map((r) => r.ref)).toEqual(['f'.repeat(64)])

    const stones = await root`
      SELECT detail FROM audit.event WHERE action = 'retention.tombstone' AND tenant_id = ${TENANT}`
    expect(stones).toHaveLength(1)
    expect(stones[0]!.detail).toMatchObject({
      ref: 'e'.repeat(64),
      data_class: 'raw_receipt',
      run_id: plan.runId,
    })

    // Re-run: the tombstone makes the plan a no-op — idempotency via evidence, not memory.
    const tombstoned = await tombstonedRefs(app, TENANT)
    const rerun = planRetention({
      items: remaining.concat(
        inventory
          .filter((i) => tombstoned.has(i.ref))
          .map((i) => ({ ...i, tombstonedAt: NOW })),
      ),
      holds: [],
      now: NOW,
    })
    expect(rerun.deletions).toEqual([])
  })

  it('the tombstone itself cannot be deleted by the app role', async () => {
    await expect(
      withTenant(app, TENANT, (tx) => tx`DELETE FROM audit.event WHERE action = 'retention.tombstone'`),
    ).rejects.toThrow(/append-only|permission denied/)
  })
})

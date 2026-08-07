// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Postgres execution of §11.4 retention.
 *
 * The deleting connection runs as the dedicated `bf_retention` role — the one documented
 * exception to append-only, permitted to DELETE and nothing else. Every deletion writes its
 * tombstone to audit.event in the same transaction: either the item is gone and the evidence
 * exists, or neither. The application role cannot delete at all; that stays proven in the
 * integration tests alongside this executor.
 */

import type { Sql } from 'postgres'

import type { DataClass, DeletionExecutor, RetainedItem, Tombstone } from '../retention/retention.js'
import { withTenant } from './tenant.js'

/** What the inventory reader can see today. Extended as more classes get Postgres storage. */
const CLASS_TABLES: Partial<Record<DataClass, string>> = {
  raw_receipt: 'core.raw_receipt',
  quarantined_payload: 'core.quarantine',
}

export class UnsupportedClassError extends Error {
  constructor(readonly dataClass: DataClass) {
    super(`no Postgres storage is mapped for data class "${dataClass}"`)
    this.name = 'UnsupportedClassError'
  }
}

/** Read the retained inventory for a tenant: every receipt with its age, ready for planning. */
export async function receiptInventory(
  sql: Sql,
  tenantId: string,
): Promise<RetainedItem[]> {
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx`
      SELECT raw_sha256, received_at, source FROM core.raw_receipt ORDER BY raw_sha256`
    return rows.map((row) => ({
      ref: row.raw_sha256 as string,
      dataClass: 'raw_receipt' as const,
      tenantId,
      createdAt: new Date(row.received_at as string).toISOString(),
    }))
  })
}

/**
 * Executor bound to a bf_retention connection. Deletion and tombstone are one transaction —
 * the evidence cannot lag the act.
 */
export class PostgresRetentionExecutor implements DeletionExecutor {
  private readonly written: Tombstone[] = []

  constructor(
    private readonly retentionSql: Sql,
    private readonly tenantId: string,
    private readonly run: { readonly runId: string; readonly policyVersion: string; readonly purgedFromBackupsBy: string },
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async delete(ref: string, dataClass: DataClass): Promise<void> {
    const table = CLASS_TABLES[dataClass]
    if (table === undefined) throw new UnsupportedClassError(dataClass)

    const deletedAt = this.now()
    await withTenant(this.retentionSql, this.tenantId, async (tx) => {
      if (dataClass === 'raw_receipt') {
        await tx`DELETE FROM core.raw_receipt WHERE raw_sha256 = ${ref}`
      } else {
        await tx`DELETE FROM core.quarantine WHERE row_sha256 = ${ref}`
      }
      await tx`INSERT INTO audit.event (tenant_id, actor, action, occurred_at, detail)
        VALUES (${this.tenantId}, 'system:retention', 'retention.tombstone', ${deletedAt},
                ${tx.json({
                  ref,
                  data_class: dataClass,
                  run_id: this.run.runId,
                  policy_version: this.run.policyVersion,
                  purged_from_backups_by: this.run.purgedFromBackupsBy,
                } as never)})`
    })
    this.written.push({
      ref,
      dataClass,
      deletedAt,
      runId: this.run.runId,
      policyVersion: this.run.policyVersion,
      purgedFromBackupsBy: this.run.purgedFromBackupsBy,
    })
  }

  tombstones(): readonly Tombstone[] {
    return this.written
  }
}

/** Refs already tombstoned for a tenant — what makes a re-run plan a no-op. */
export async function tombstonedRefs(sql: Sql, tenantId: string): Promise<Set<string>> {
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx`
      SELECT detail->>'ref' AS ref FROM audit.event
      WHERE action = 'retention.tombstone'`
    return new Set(rows.map((row) => row.ref as string))
  })
}

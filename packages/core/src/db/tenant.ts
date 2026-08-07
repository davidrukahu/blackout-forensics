// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tenant-scoped database access.
 *
 * PRD §11.1 requires every query against tenant data to run with an explicit tenant context, and
 * §17.5 makes cross-tenant negative tests a release gate. That means the context cannot be
 * something a caller *may* set — it has to be the only way in.
 *
 * `withTenant` is therefore the sole entry point: it opens a transaction, issues
 * `SET LOCAL app.tenant_id`, and hands the caller a connection that is already scoped. There is no
 * unscoped accessor to reach for, which is why an ORM that hides transaction lifecycle was
 * rejected — the guarantee has to be structural, not remembered.
 */

import type { Sql, TransactionSql } from 'postgres'

export class MissingTenantContextError extends Error {
  constructor() {
    super(
      'no tenant context: every query against tenant data must run inside withTenant(). A query ' +
        'without a context sees nothing, which is the safe failure — but the caller is still wrong.',
    )
    this.name = 'MissingTenantContextError'
  }
}

/**
 * Run work inside a transaction scoped to one tenant.
 *
 * `SET LOCAL` binds the setting to the transaction, so it cannot leak into the next borrower of a
 * pooled connection. That detail is the whole reason this is a transaction rather than a session
 * setting: pooled connections are reused, and a session-scoped tenant id would be a cross-tenant
 * leak waiting for load.
 */
export async function withTenant<T>(
  sql: Sql,
  tenantId: string,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  if (tenantId === '') throw new MissingTenantContextError()

  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    return work(tx)
  }) as Promise<T>
}

/**
 * Run work with no tenant context at all.
 *
 * Exists so background jobs can be *tested* for the safe failure — a job that forgets its context
 * must see an empty database, not every tenant's data. Deliberately named to be uncomfortable to
 * use in production code.
 */
export async function withoutTenantForTesting<T>(
  sql: Sql,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => work(tx)) as Promise<T>
}

export interface TenantContextCheck {
  readonly table: string
  readonly rowsVisibleWithContext: number
  readonly rowsVisibleWithoutContext: number
  readonly rowsVisibleToOtherTenant: number
}

/**
 * The cross-tenant negative check, as data rather than as prose.
 *
 * Returns what each table exposed under three conditions so a test — or an operator running a
 * pre-release check — can assert the only acceptable answer: own rows visible, nothing visible
 * without a context, nothing visible to another tenant.
 */
export async function checkTenantIsolation(
  sql: Sql,
  params: { table: string; tenantId: string; otherTenantId: string },
): Promise<TenantContextCheck> {
  const count = async (tx: TransactionSql): Promise<number> => {
    const rows = await tx.unsafe(`SELECT count(*)::int AS n FROM ${params.table}`)
    return (rows[0] as unknown as { n: number }).n
  }

  const withOwn = await withTenant(sql, params.tenantId, count)
  const withNone = await withoutTenantForTesting(sql, count)
  const withOther = await withTenant(sql, params.otherTenantId, count)

  return {
    table: params.table,
    rowsVisibleWithContext: withOwn,
    rowsVisibleWithoutContext: withNone,
    rowsVisibleToOtherTenant: withOther,
  }
}

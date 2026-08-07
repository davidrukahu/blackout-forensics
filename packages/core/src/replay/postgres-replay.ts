// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Postgres-backed replay runs.
 *
 * The scope and the approval live with the run rather than at the call site, so "who authorised
 * this and over what interval" is answerable afterwards from the database alone.
 */

import type { Sql } from 'postgres'

import { withTenant } from '../db/tenant.js'
import { planWindows, type ReplayHooks, type ReplayProgress, type ReplayScope } from './replay.js'

export interface StartedRun {
  readonly runId: string
  readonly checkpointAt: string | null
  readonly windowsTotal: number
}

/**
 * Create or find a run for this scope.
 *
 * An unfinished run for the same scope is resumed rather than duplicated: two concurrent replays of
 * one interval would double the work and interleave their checkpoints into nonsense.
 */
export async function startOrResumeRun(
  sql: Sql,
  scope: ReplayScope,
  startedAt: string,
): Promise<StartedRun> {
  const windowsTotal = planWindows(scope).length

  return withTenant(sql, scope.tenantId, async (tx) => {
    const existing = await tx`SELECT id, checkpoint_at, windows_total FROM core.replay_run
      WHERE source = ${scope.source}
        AND interval_start = ${scope.from} AND interval_end = ${scope.to}
        AND status IN ('running', 'failed', 'cancelled')
      ORDER BY id DESC LIMIT 1`

    if (existing.length > 0) {
      const row = existing[0] as unknown as {
        id: number; checkpoint_at: Date | null; windows_total: number
      }
      return {
        runId: String(row.id),
        checkpointAt: row.checkpoint_at === null ? null : row.checkpoint_at.toISOString(),
        windowsTotal: row.windows_total,
      }
    }

    const inserted = await tx`INSERT INTO core.replay_run
      (tenant_id, source, interval_start, interval_end, approved_by, reason, windows_total, started_at)
      VALUES (${scope.tenantId}, ${scope.source}, ${scope.from}, ${scope.to},
              ${scope.approvedBy}, ${scope.reason}, ${windowsTotal}, ${startedAt})
      RETURNING id`
    return {
      runId: String((inserted[0] as unknown as { id: number }).id),
      checkpointAt: null,
      windowsTotal,
    }
  })
}

/** Hooks that persist checkpoints and write to the separate audit stream. */
export function postgresHooks(
  sql: Sql,
  scope: ReplayScope,
  params: {
    processWindow: ReplayHooks['processWindow']
    occurredAt: string
    actor: string
    shouldCancel?: ReplayHooks['shouldCancel']
  },
): ReplayHooks {
  return {
    processWindow: params.processWindow,
    ...(params.shouldCancel !== undefined ? { shouldCancel: params.shouldCancel } : {}),

    saveCheckpoint: async (progress: ReplayProgress) => {
      await withTenant(sql, scope.tenantId, async (tx) => {
        await tx`UPDATE core.replay_run
          SET status = ${progress.status},
              checkpoint_at = ${progress.checkpointAt},
              windows_done = ${progress.windowsDone},
              finished_at = ${progress.status === 'running' ? null : params.occurredAt}
          WHERE id = ${Number(progress.runId)}`
      })
    },

    audit: async (entry) => {
      await withTenant(sql, scope.tenantId, async (tx) => {
        await tx`INSERT INTO audit.event (tenant_id, actor, action, occurred_at, detail)
          VALUES (${scope.tenantId}, ${params.actor}, ${entry.action}, ${params.occurredAt},
                  ${tx.json(entry.detail as never)})`
      })
    },
  }
}

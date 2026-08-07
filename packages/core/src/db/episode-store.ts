// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Postgres-backed episode read store and audit sink.
 *
 * `MemoryEpisodeStore` is the reference semantics; this must reproduce them against a database
 * that also enforces tenant isolation. The row is a *projection* of the episode's version chain —
 * the chain itself, stored whole in `versions`, is the history, so revising an episode is an
 * upsert of its projection, not an append of a new row. Append-only lives where history lives:
 * in the chain, and in `audit.event`.
 *
 * Pagination is keyset over `(start_at, id)` against the `episode_list_order` index — the §10.5
 * contract that a page boundary holds still while rows are inserted around it.
 */

import type { Sql } from 'postgres'

import type { Episode } from '../episodes/lifecycle.js'
import { currentVersion } from '../episodes/lifecycle.js'
import type { AuditSink, EpisodeFilters, EpisodeListItem, EpisodeReadStore } from '../api/episodes.js'
import { withTenant } from './tenant.js'

const iso = (value: unknown): string => new Date(value as string | Date).toISOString()

export class PostgresEpisodeStore implements EpisodeReadStore {
  constructor(
    private readonly sql: Sql,
    private readonly tenantId: string,
  ) {}

  /**
   * Write an episode's current projection. The full version chain and recorded actions travel
   * with it, exactly as the lifecycle module shapes them — a reader gets back what a revision
   * produced, not a lossy summary of it.
   */
  async put(episode: Episode): Promise<void> {
    const current = currentVersion(episode)
    await withTenant(this.sql, this.tenantId, async (tx) => {
      await tx`INSERT INTO core.episode
          (id, tenant_id, device_ref, current_state, episode_type, start_at, end_at,
           versions, actions, finalisation_watermark_at)
        VALUES
          (${episode.id}, ${this.tenantId}, ${episode.deviceRef}, ${current.state},
           ${current.type}, ${current.startAt}, ${current.endAt},
           ${tx.json(episode.versions as never)}, ${tx.json(episode.actions as never)},
           ${episode.finalisationWatermarkAt})
        ON CONFLICT (tenant_id, id) DO UPDATE SET
          current_state = EXCLUDED.current_state,
          episode_type = EXCLUDED.episode_type,
          start_at = EXCLUDED.start_at,
          end_at = EXCLUDED.end_at,
          versions = EXCLUDED.versions,
          actions = EXCLUDED.actions,
          finalisation_watermark_at = EXCLUDED.finalisation_watermark_at`
    })
  }

  async page(params: {
    readonly after: { startAt: string; id: string } | null
    readonly limit: number
    readonly filters: EpisodeFilters
  }): Promise<readonly EpisodeListItem[]> {
    const { after, limit, filters } = params
    return withTenant(this.sql, this.tenantId, async (tx) => {
      const rows = await tx`
        SELECT id, device_ref, current_state, episode_type, start_at, end_at
        FROM core.episode
        WHERE true
          ${after === null ? tx`` : tx`AND (start_at, id) > (${after.startAt}::timestamptz, ${after.id})`}
          ${filters.state === undefined ? tx`` : tx`AND current_state = ${filters.state}`}
          ${filters.deviceRef === undefined ? tx`` : tx`AND device_ref = ${filters.deviceRef}`}
        ORDER BY start_at, id
        LIMIT ${limit}`
      return rows.map((row) => ({
        id: row.id as string,
        deviceRef: row.device_ref as string,
        state: row.current_state as string,
        episodeType: row.episode_type as string,
        startAt: iso(row.start_at),
        endAt: row.end_at === null ? null : iso(row.end_at),
      }))
    })
  }

  async get(id: string): Promise<Episode | null> {
    return withTenant(this.sql, this.tenantId, async (tx) => {
      const rows = await tx`
        SELECT id, device_ref, versions, actions, finalisation_watermark_at
        FROM core.episode WHERE id = ${id}`
      const row = rows[0]
      if (row === undefined) return null
      return {
        id: row.id as string,
        deviceRef: row.device_ref as string,
        versions: row.versions as Episode['versions'],
        actions: row.actions as Episode['actions'],
        finalisationWatermarkAt: iso(row.finalisation_watermark_at),
      }
    })
  }
}

/** Sensitive-view records go through the same append-only stream as everything else (§10.4). */
export class PostgresAuditSink implements AuditSink {
  constructor(
    private readonly sql: Sql,
    private readonly tenantId: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async record(entry: {
    readonly actor: string
    readonly action: string
    readonly detail: Record<string, unknown>
  }): Promise<void> {
    await withTenant(this.sql, this.tenantId, async (tx) => {
      await tx`INSERT INTO audit.event (tenant_id, actor, action, occurred_at, detail)
        VALUES (${this.tenantId}, ${entry.actor}, ${entry.action}, ${this.now()},
                ${tx.json(entry.detail as never)})`
    })
  }
}

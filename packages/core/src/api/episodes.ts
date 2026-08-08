// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The evidence read API — GET /v1/episodes and GET /v1/episodes/{id}, as domain functions the HTTP
 * layer will bind without adding semantics of its own.
 *
 * Three §10 contracts live here rather than in the transport:
 *
 *   * Stable cursor pagination (§10.5). The cursor encodes the last row's (start_at, id) tuple, so
 *     a page boundary holds still while rows are inserted around it — an offset would slide, and a
 *     slid boundary silently skips or repeats episodes in the queue an analyst is working.
 *   * Exact-location filters require explicit scope (§10.4). A caller without the scope asking for
 *     an area filter gets a refusal, not a quietly unfiltered answer — the wrong result would be
 *     indistinguishable from a right one.
 *   * Sensitive evidence views are recorded (§10.4). Reading an episode's full evidence emits an
 *     audit event through the same append-only stream everything else uses.
 */

import type { Episode } from '../episodes/lifecycle.js'

export interface EpisodeListItem {
  readonly id: string
  readonly deviceRef: string
  readonly state: string
  readonly episodeType: string
  readonly startAt: string
  readonly endAt: string | null
}

export interface EpisodePage {
  readonly items: readonly EpisodeListItem[]
  /** Opaque to callers; hand it back verbatim to continue. Null when the listing is exhausted. */
  readonly nextCursor: string | null
}

export interface EpisodeFilters {
  readonly state?: string
  readonly deviceRef?: string
  /** Exact-location territory: requires the caller to hold the location scope. */
  readonly h3Cell?: string
}

export interface CallerContext {
  readonly actor: string
  /** Scopes the authenticated identity carries. The tenant itself comes from the connection. */
  readonly scopes: readonly string[]
}

export const LOCATION_SCOPE = 'episodes:exact-location'

export class MissingScopeError extends Error {
  constructor(readonly scope: string) {
    super(
      `This filter needs the "${scope}" scope. The system refuses the request. The system does not return unfiltered data.`,
    )
    this.name = 'MissingScopeError'
  }
}

/** Cursor = base64(startAt|id). Opaque outside, ordered tuple inside. */
export function encodeCursor(startAt: string, id: string): string {
  return Buffer.from(`${startAt}|${id}`, 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): { startAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    const separator = decoded.indexOf('|')
    if (separator < 0) return null
    const startAt = decoded.slice(0, separator)
    const id = decoded.slice(separator + 1)
    if (Number.isNaN(Date.parse(startAt)) || id === '') return null
    return { startAt, id }
  } catch {
    return null
  }
}

export interface AuditSink {
  record(entry: {
    readonly actor: string
    readonly action: string
    readonly detail: Record<string, unknown>
  }): Promise<void>
}

export interface EpisodeReadStore {
  /** Rows strictly after the cursor tuple in (start_at, id) order. */
  page(params: {
    readonly after: { startAt: string; id: string } | null
    readonly limit: number
    readonly filters: EpisodeFilters
  }): Promise<readonly EpisodeListItem[]>
  get(id: string): Promise<Episode | null>
}

export interface ListEpisodesRequest {
  readonly caller: CallerContext
  readonly cursor?: string
  readonly limit?: number
  readonly filters?: EpisodeFilters
}

export class InvalidCursorError extends Error {
  constructor() {
    super('The cursor is not valid. Start the list from the beginning.')
    this.name = 'InvalidCursorError'
  }
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export async function listEpisodes(
  store: EpisodeReadStore,
  request: ListEpisodesRequest,
): Promise<EpisodePage> {
  const filters = request.filters ?? {}

  if (filters.h3Cell !== undefined && !request.caller.scopes.includes(LOCATION_SCOPE)) {
    throw new MissingScopeError(LOCATION_SCOPE)
  }

  const after = request.cursor === undefined ? null : decodeCursor(request.cursor)
  if (request.cursor !== undefined && after === null) throw new InvalidCursorError()

  const limit = Math.min(Math.max(request.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  // Fetch one extra row: its presence is what distinguishes "page is full" from "listing is done"
  // without a second query racing the first.
  const rows = await store.page({ after, limit: limit + 1, filters })

  const items = rows.slice(0, limit)
  const last = items[items.length - 1]
  return {
    items,
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last.startAt, last.id) : null,
  }
}

export interface EpisodeDetail {
  readonly episode: Episode
}

/**
 * Read one episode with its full evidence chain, and record that it happened.
 *
 * The audit write precedes the return: an audit trail that only records successful deliveries
 * misses exactly the reads that were cut short on purpose.
 */
export async function getEpisode(
  store: EpisodeReadStore,
  audit: AuditSink,
  params: { readonly caller: CallerContext; readonly id: string },
): Promise<EpisodeDetail | null> {
  const episode = await store.get(params.id)
  if (episode === null) return null

  await audit.record({
    actor: params.caller.actor,
    action: 'episode.sensitive_view',
    detail: { episode_id: params.id, device_ref: episode.deviceRef },
  })

  return { episode }
}

// ---------------------------------------------------------------- in-memory reference store

/** Reference semantics for the Postgres store, and what the unit tests pin. */
export class MemoryEpisodeStore implements EpisodeReadStore {
  private readonly episodes = new Map<string, Episode>()

  put(episode: Episode): void {
    this.episodes.set(episode.id, episode)
  }

  async page(params: {
    readonly after: { startAt: string; id: string } | null
    readonly limit: number
    readonly filters: EpisodeFilters
  }): Promise<readonly EpisodeListItem[]> {
    const all = [...this.episodes.values()]
      .map((episode) => {
        const current = episode.versions[episode.versions.length - 1]!
        return {
          id: episode.id,
          deviceRef: episode.deviceRef,
          state: current.state,
          episodeType: current.type,
          startAt: current.startAt,
          endAt: current.endAt,
        }
      })
      .filter((item) => {
        if (params.filters.state !== undefined && item.state !== params.filters.state) return false
        if (params.filters.deviceRef !== undefined && item.deviceRef !== params.filters.deviceRef) {
          return false
        }
        return true
      })
      .sort((a, b) => a.startAt.localeCompare(b.startAt) || a.id.localeCompare(b.id))

    const after = params.after
    const startIndex =
      after === null
        ? 0
        : all.findIndex(
            (item) => `${item.startAt}|${item.id}` > `${after.startAt}|${after.id}`,
          )
    const from = startIndex < 0 ? all.length : startIndex
    return all.slice(from, from + params.limit)
  }

  async get(id: string): Promise<Episode | null> {
    return this.episodes.get(id) ?? null
  }
}

// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The evidence read API's three §10 contracts, against the reference store.
 *
 * The cursor test is the one that earns its keep: it inserts rows *around* an open page boundary
 * and proves the walk neither skips nor repeats — the failure an offset cursor produces silently.
 */

import { describe, expect, it } from 'vitest'

import type { Episode, EpisodeState } from '../episodes/lifecycle.js'
import type { EpisodeType } from '../episodes/sampler.js'
import {
  InvalidCursorError,
  LOCATION_SCOPE,
  MemoryEpisodeStore,
  MissingScopeError,
  decodeCursor,
  encodeCursor,
  getEpisode,
  listEpisodes,
  type AuditSink,
  type EpisodeReadStore,
} from './episodes.js'

const CALLER = { actor: 'analyst@synthetic', scopes: [] as string[] }

function episode(id: string, startAt: string, overrides?: {
  state?: EpisodeState
  type?: EpisodeType
  deviceRef?: string
}): Episode {
  return {
    id,
    deviceRef: overrides?.deviceRef ?? 'dev-1',
    versions: [
      {
        version: 1,
        state: overrides?.state ?? 'provisional',
        type: overrides?.type ?? 'total_silence',
        startAt,
        endAt: null,
        cause: 'opened',
        actor: 'system:sampler',
        reason: 'expected report missed',
        at: startAt,
        supersedes: null,
        clockBasis: 'received_at',
        policyVersion: 'policy-1',
      },
    ],
    actions: [],
    finalisationWatermarkAt: '2026-09-01T00:00:00.000Z',
  }
}

function storeWith(...episodes: Episode[]): MemoryEpisodeStore {
  const store = new MemoryEpisodeStore()
  for (const e of episodes) store.put(e)
  return store
}

describe('cursor encoding', () => {
  it('round-trips the (startAt, id) tuple', () => {
    const cursor = encodeCursor('2026-08-05T06:00:00.000Z', 'ep-9')
    expect(decodeCursor(cursor)).toEqual({ startAt: '2026-08-05T06:00:00.000Z', id: 'ep-9' })
  })

  it('survives an id containing the separator — only the first | splits', () => {
    const cursor = encodeCursor('2026-08-05T06:00:00.000Z', 'ep|odd')
    expect(decodeCursor(cursor)).toEqual({ startAt: '2026-08-05T06:00:00.000Z', id: 'ep|odd' })
  })

  it('rejects garbage rather than guessing', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull()
    expect(decodeCursor(Buffer.from('no separator here').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('not-a-date|id').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('2026-08-05T06:00:00.000Z|').toString('base64url'))).toBeNull()
  })

  it('a tampered cursor is an error the caller sees, not an empty page', async () => {
    const store = storeWith(episode('a', '2026-08-05T06:00:00.000Z'))
    await expect(
      listEpisodes(store, { caller: CALLER, cursor: 'forged' }),
    ).rejects.toBeInstanceOf(InvalidCursorError)
  })
})

describe('pagination §10.5', () => {
  const at = (minute: number): string =>
    `2026-08-05T06:${String(minute).padStart(2, '0')}:00.000Z`

  it('a page boundary holds still while rows are inserted around it', async () => {
    const store = storeWith(
      episode('a', at(0)), episode('b', at(10)), episode('c', at(20)), episode('d', at(30)),
    )
    const first = await listEpisodes(store, { caller: CALLER, limit: 2 })
    expect(first.items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(first.nextCursor).not.toBeNull()

    // An analyst is mid-walk; the world does not stop. One row lands before the boundary, one
    // after. The already-served page cannot change; the rest of the walk sees exactly the rows
    // after the boundary — including the new late one, never a repeat of a or b.
    store.put(episode('early', at(5)))
    store.put(episode('late', at(25)))

    const second = await listEpisodes(store, { caller: CALLER, cursor: first.nextCursor! })
    expect(second.items.map((i) => i.id)).toEqual(['c', 'late', 'd'])
    expect(second.nextCursor).toBeNull()
  })

  it('ties on startAt are broken by id, so the order is total and the cursor unambiguous', async () => {
    const store = storeWith(episode('b', at(0)), episode('a', at(0)), episode('c', at(0)))
    const first = await listEpisodes(store, { caller: CALLER, limit: 2 })
    expect(first.items.map((i) => i.id)).toEqual(['a', 'b'])
    const rest = await listEpisodes(store, { caller: CALLER, cursor: first.nextCursor! })
    expect(rest.items.map((i) => i.id)).toEqual(['c'])
  })

  it('an exactly-full final page reports exhaustion, not a cursor to an empty page', async () => {
    const store = storeWith(episode('a', at(0)), episode('b', at(10)))
    const page = await listEpisodes(store, { caller: CALLER, limit: 2 })
    expect(page.items).toHaveLength(2)
    expect(page.nextCursor).toBeNull()
  })

  it('clamps the limit to [1, 200] rather than trusting the caller', async () => {
    const asked: number[] = []
    const spy: EpisodeReadStore = {
      page: async (params) => {
        asked.push(params.limit)
        return []
      },
      get: async () => null,
    }
    await listEpisodes(spy, { caller: CALLER, limit: 0 })
    await listEpisodes(spy, { caller: CALLER, limit: 100_000 })
    // Each request fetches one sentinel row beyond the page.
    expect(asked).toEqual([2, 201])
  })

  it('filters by state and device', async () => {
    const store = storeWith(
      episode('open', at(0)),
      episode('closed', at(10), { state: 'resolved' }),
      episode('other-dev', at(20), { deviceRef: 'dev-2' }),
    )
    const resolved = await listEpisodes(store, { caller: CALLER, filters: { state: 'resolved' } })
    expect(resolved.items.map((i) => i.id)).toEqual(['closed'])
    const byDevice = await listEpisodes(store, { caller: CALLER, filters: { deviceRef: 'dev-2' } })
    expect(byDevice.items.map((i) => i.id)).toEqual(['other-dev'])
  })
})

describe('exact-location scope §10.4', () => {
  it('refuses an area filter without the scope — never answers unfiltered', async () => {
    const store = storeWith(episode('a', '2026-08-05T06:00:00.000Z'))
    await expect(
      listEpisodes(store, { caller: CALLER, filters: { h3Cell: '8859a442b3fffff' } }),
    ).rejects.toBeInstanceOf(MissingScopeError)
  })

  it('serves the same filter to a caller holding the scope', async () => {
    const store = storeWith(episode('a', '2026-08-05T06:00:00.000Z'))
    const caller = { ...CALLER, scopes: [LOCATION_SCOPE] }
    await expect(
      listEpisodes(store, { caller, filters: { h3Cell: '8859a442b3fffff' } }),
    ).resolves.toBeDefined()
  })
})

describe('sensitive views are recorded §10.4', () => {
  const collectingSink = (): AuditSink & { entries: unknown[] } => {
    const entries: unknown[] = []
    return {
      entries,
      record: async (entry) => {
        entries.push(entry)
      },
    }
  }

  it('reading full evidence emits an audit event naming actor, episode and device', async () => {
    const store = storeWith(episode('ep-1', '2026-08-05T06:00:00.000Z'))
    const sink = collectingSink()
    const detail = await getEpisode(store, sink, { caller: CALLER, id: 'ep-1' })
    expect(detail?.episode.id).toBe('ep-1')
    expect(sink.entries).toEqual([
      {
        actor: 'analyst@synthetic',
        action: 'episode.sensitive_view',
        detail: { episode_id: 'ep-1', device_ref: 'dev-1' },
      },
    ])
  })

  it('a miss records nothing — there was nothing sensitive to see', async () => {
    const sink = collectingSink()
    const detail = await getEpisode(new MemoryEpisodeStore(), sink, { caller: CALLER, id: 'nope' })
    expect(detail).toBeNull()
    expect(sink.entries).toEqual([])
  })

  it('a failed audit write fails the read: unrecorded sensitive views do not happen', async () => {
    const store = storeWith(episode('ep-1', '2026-08-05T06:00:00.000Z'))
    const refusing: AuditSink = {
      record: async () => {
        throw new Error('audit stream unavailable')
      },
    }
    await expect(
      getEpisode(store, refusing, { caller: CALLER, id: 'ep-1' }),
    ).rejects.toThrow('audit stream unavailable')
  })
})

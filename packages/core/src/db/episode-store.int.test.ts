// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Postgres episode store against a real database.
 *
 * Two claims carry the file: the store reproduces `MemoryEpisodeStore`'s paging semantics
 * exactly (walked side by side over the same data), and tenant isolation holds under the
 * same non-superuser role the application runs as.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MemoryEpisodeStore, getEpisode, listEpisodes } from '../api/episodes.js'
import type { Episode, EpisodeState } from '../episodes/lifecycle.js'
import { PostgresAuditSink, PostgresEpisodeStore } from './episode-store.js'

const SCHEMA = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8')
const TENANT = 'synthetic_a'
const OTHER = 'synthetic_b'
const CALLER = { actor: 'analyst@synthetic', scopes: [] as string[] }

let container: StartedPostgreSqlContainer
let root: Sql
let app: Sql

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  root = postgres(container.getConnectionUri(), { max: 2, onnotice: () => {} })
  await root.unsafe(SCHEMA)
  await root.unsafe(`
    DROP ROLE IF EXISTS bf_app;
    CREATE ROLE bf_app LOGIN PASSWORD 'app-password' NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA core, audit TO bf_app;
    GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA core, audit TO bf_app;
    -- Episodes revise in place: the row is a projection of the version chain, and the chain is
    -- where the history lives. UPDATE here is not an exception to append-only; audit.event and
    -- the receipt tables keep their triggers.
    GRANT UPDATE ON core.episode TO bf_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core, audit TO bf_app;
  `)
  const uri = new URL(container.getConnectionUri())
  uri.username = 'bf_app'
  uri.password = 'app-password'
  app = postgres(uri.toString(), { max: 6, onnotice: () => {} })
}, 180_000)

afterAll(async () => {
  await app?.end({ timeout: 5 })
  await root?.end({ timeout: 5 })
  await container?.stop()
})

const at = (minute: number): string => `2026-08-05T06:${String(minute).padStart(2, '0')}:00.000Z`

function fixture(id: string, startAt: string, overrides?: {
  state?: EpisodeState
  deviceRef?: string
  versions?: number
}): Episode {
  const versionCount = overrides?.versions ?? 1
  return {
    id,
    deviceRef: overrides?.deviceRef ?? 'dev-1',
    versions: Array.from({ length: versionCount }, (_, i) => ({
      version: i + 1,
      state: i + 1 === versionCount ? (overrides?.state ?? 'provisional') : 'provisional',
      type: 'total_silence' as const,
      startAt,
      endAt: null,
      cause: i === 0 ? ('opened' as const) : ('evidence_updated' as const),
      actor: 'system:sampler',
      reason: i === 0 ? 'expected report missed' : 'later report widened the gap',
      at: startAt,
      supersedes: i === 0 ? null : i,
      clockBasis: 'received_at' as const,
      policyVersion: 'policy-1',
    })),
    actions: [],
    finalisationWatermarkAt: '2026-09-01T00:00:00.000Z',
  }
}

describe('round-trip fidelity', () => {
  it('returns the version chain and actions exactly as the lifecycle shaped them', async () => {
    const store = new PostgresEpisodeStore(app, TENANT)
    const episode: Episode = {
      ...fixture('rt-1', at(0), { state: 'review_required', versions: 3 }),
      actions: [{ kind: 'field_verification', at: at(30), reference: 'ticket-77' }],
    }
    await store.put(episode)
    const back = await store.get('rt-1')
    expect(back).toEqual(episode)
  })

  it('a revision replaces the projection, and the reader sees the new state', async () => {
    const store = new PostgresEpisodeStore(app, TENANT)
    await store.put(fixture('rev-1', at(0)))
    await store.put(fixture('rev-1', at(0), { state: 'resolved', versions: 2 }))
    const back = await store.get('rev-1')
    expect(back?.versions).toHaveLength(2)
    const page = await store.page({ after: null, limit: 100, filters: { state: 'resolved' } })
    expect(page.map((item) => item.id)).toContain('rev-1')
  })
})

describe('paging parity with the reference store', () => {
  it('walks identically to MemoryEpisodeStore over the same shuffled data', async () => {
    const pg = new PostgresEpisodeStore(app, `${TENANT}parity`)
    const memory = new MemoryEpisodeStore()
    // Shuffled inserts, colliding start times, mixed devices and states: the order the API
    // promises must come from the sort contract, not from insertion order.
    const episodes = [7, 3, 11, 0, 3, 9, 0, 14, 5, 11, 2, 8, 6, 1, 13].map((minute, i) =>
      fixture(`parity-${String(i).padStart(2, '0')}`, at(minute), {
        deviceRef: `dev-${i % 3}`,
        state: i % 4 === 0 ? 'resolved' : 'provisional',
      }),
    )
    for (const episode of episodes) {
      await pg.put(episode)
      memory.put(episode)
    }

    for (const filters of [{}, { state: 'resolved' }, { deviceRef: 'dev-1' }]) {
      const walk = async (store: PostgresEpisodeStore | MemoryEpisodeStore) => {
        const seen: string[] = []
        let cursor: string | null = null
        for (;;) {
          const page = await listEpisodes(store, {
            caller: CALLER,
            limit: 4,
            filters,
            ...(cursor === null ? {} : { cursor }),
          })
          seen.push(...page.items.map((item) => item.id))
          if (page.nextCursor === null) return seen
          cursor = page.nextCursor
        }
      }
      expect(await walk(pg), JSON.stringify(filters)).toEqual(await walk(memory))
    }
  })

  it('holds a page boundary still while rows land around it', async () => {
    const pg = new PostgresEpisodeStore(app, `${TENANT}cursor`)
    for (const [id, minute] of [['a', 0], ['b', 10], ['c', 20], ['d', 30]] as const) {
      await pg.put(fixture(id, at(minute)))
    }
    const first = await listEpisodes(pg, { caller: CALLER, limit: 2 })
    expect(first.items.map((i) => i.id)).toEqual(['a', 'b'])

    await pg.put(fixture('early', at(5)))
    await pg.put(fixture('late', at(25)))

    const second = await listEpisodes(pg, { caller: CALLER, cursor: first.nextCursor! })
    expect(second.items.map((i) => i.id)).toEqual(['c', 'late', 'd'])
  })
})

describe('tenant isolation', () => {
  it('another tenant sees neither the listing nor the episode', async () => {
    const mine = new PostgresEpisodeStore(app, `${TENANT}iso`)
    await mine.put(fixture('secret', at(0)))

    const theirs = new PostgresEpisodeStore(app, `${OTHER}iso`)
    expect(await theirs.get('secret')).toBeNull()
    expect(await theirs.page({ after: null, limit: 10, filters: {} })).toEqual([])
  })
})

describe('the audit sink', () => {
  it('a sensitive view lands in audit.event through the API path', async () => {
    const store = new PostgresEpisodeStore(app, `${TENANT}audit`)
    await store.put(fixture('watched', at(0)))
    const sink = new PostgresAuditSink(app, `${TENANT}audit`, () => at(45))

    const detail = await getEpisode(store, sink, { caller: CALLER, id: 'watched' })
    expect(detail?.episode.id).toBe('watched')

    const rows = await root`
      SELECT actor, action, occurred_at, detail FROM audit.event
      WHERE tenant_id = ${`${TENANT}audit`} AND action = 'episode.sensitive_view'`
    expect(rows).toHaveLength(1)
    expect(rows[0]?.actor).toBe('analyst@synthetic')
    expect(rows[0]?.detail).toEqual({ episode_id: 'watched', device_ref: 'dev-1' })
  })

  it('the audit row cannot be updated or deleted, even by its writer', async () => {
    // Two layers refuse this: the app role holds no UPDATE grant, and behind it the append-only
    // trigger. Either message is the same control succeeding.
    await expect(
      app`UPDATE audit.event SET actor = 'nobody' WHERE action = 'episode.sensitive_view'`,
    ).rejects.toThrow(/append-only|permission denied/)
    // And the trigger holds even for a role privileged enough to pass the grants.
    await expect(
      root`UPDATE audit.event SET actor = 'nobody' WHERE action = 'episode.sensitive_view'`,
    ).rejects.toThrow(/append-only/)
  })
})

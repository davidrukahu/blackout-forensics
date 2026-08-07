// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cell-data isolation, asserted against the real schema.
 *
 * ODbL and CC BY-SA 4.0 are incompatible copylefts — Creative Commons has never designated ODbL as
 * BY-SA-compatible — so a derived database holding both would owe two irreconcilable obligations.
 * The defence is that no such database can be constructed: separate schemas, no foreign keys
 * between them, and none into tenant data either.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const SCHEMA = readFileSync(join(process.cwd(), 'packages/core/src/db/schema.sql'), 'utf8')

let container: StartedPostgreSqlContainer
let sql: Sql

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  sql = postgres(container.getConnectionUri(), { max: 3, onnotice: () => {} })
  await sql.unsafe(SCHEMA)
}, 180_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await container?.stop()
})

describe('the two open-data layers can never be joined into one database', () => {
  it('has no foreign key between the OSM and cell schemas, in either direction', async () => {
    const rows = await sql<{ name: string }[]>`
      SELECT con.conname AS name
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_namespace srcns ON srcns.oid = src.relnamespace
      JOIN pg_class tgt ON tgt.oid = con.confrelid
      JOIN pg_namespace tgtns ON tgtns.oid = tgt.relnamespace
      WHERE con.contype = 'f'
        AND ((srcns.nspname = 'osm_snapshot' AND tgtns.nspname = 'cell_snapshot')
          OR (srcns.nspname = 'cell_snapshot' AND tgtns.nspname = 'osm_snapshot'))`
    expect(rows).toEqual([])
  })

  it('has no foreign key from tenant data into the cell schema', async () => {
    const rows = await sql<{ name: string }[]>`
      SELECT con.conname AS name
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_namespace srcns ON srcns.oid = src.relnamespace
      JOIN pg_class tgt ON tgt.oid = con.confrelid
      JOIN pg_namespace tgtns ON tgtns.oid = tgt.relnamespace
      WHERE con.contype = 'f'
        AND srcns.nspname IN ('core', 'audit') AND tgtns.nspname = 'cell_snapshot'`
    expect(rows).toEqual([])
  })

  it('keeps cell identifiers out of tenant tables entirely', async () => {
    const rows = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema IN ('core','audit')
        AND column_name IN ('cell_lat', 'cell_lon', 'opencellid_id', 'cell_prior_lat')`
    expect(rows).toEqual([])
  })
})

describe('a cell snapshot cannot activate without provenance', () => {
  const insert = (overrides: Record<string, unknown> = {}) =>
    sql`INSERT INTO cell_snapshot.snapshot ${sql({
      source_url: 'https://opencellid.org/downloads/639.csv.gz',
      licence: 'CC-BY-SA-4.0',
      extract_date: '2026-08-01',
      sha256: createHash('sha256').update('cells').digest('hex'),
      attribution: '© OpenCellID contributors, licensed under CC BY-SA 4.0',
      acquisition: 'self_hosted_download',
      imported_at: '2026-08-05T00:00:00Z',
      ...overrides,
    } as never)} RETURNING id`

  it('accepts a complete snapshot', async () => {
    expect(await insert()).toHaveLength(1)
  })

  it('refuses one with no licence or no attribution', async () => {
    await expect(insert({ licence: null })).rejects.toThrow(/not-null/)
    await expect(insert({ attribution: null })).rejects.toThrow(/not-null/)
  })

  it('refuses the community API as an acquisition route', async () => {
    // Not permitted for commercial production without contributing data or being whitelisted, and
    // access may be withdrawn at any time — so the database refuses to record it as a source.
    await expect(insert({ acquisition: 'community_api' })).rejects.toThrow(/check constraint/)
  })

  it('imports inactive', async () => {
    const rows = await sql<{ active: boolean }[]>`
      SELECT active FROM cell_snapshot.snapshot ORDER BY id DESC LIMIT 1`
    expect(rows[0]?.active).toBe(false)
  })
})

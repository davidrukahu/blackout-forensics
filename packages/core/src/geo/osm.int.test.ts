// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ODbL boundary, asserted against the real schema.
 *
 * The licence research concluded that enriching OSM features with customer-derived attributes is
 * the shape treated as a Derivative Database — which would oblige publishing the customer's data.
 * The defence is structural: tenant tables have no column capable of holding an OSM identifier, so
 * the prohibition is enforced by an absent column rather than by a coding rule someone must
 * remember. These tests are what keep that true as the schema grows.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { FORBIDDEN_IN_TENANT_SCHEMA, surrogateKeyFor } from './snapshot.js'

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

describe('no tenant table can hold an OSM identifier', () => {
  it('has no forbidden column anywhere in core or audit', async () => {
    const rows = await sql<{ table_schema: string; table_name: string; column_name: string }[]>`
      SELECT table_schema, table_name, column_name
      FROM information_schema.columns
      WHERE table_schema IN ('core', 'audit')`

    const offenders = rows.filter((r) =>
      (FORBIDDEN_IN_TENANT_SCHEMA as readonly string[]).includes(r.column_name.toLowerCase()),
    )
    expect(
      offenders.map((o) => `${o.table_schema}.${o.table_name}.${o.column_name}`),
    ).toEqual([])
  })

  it('keeps the OSM identifier in exactly one place', async () => {
    const rows = await sql<{ table_schema: string; table_name: string }[]>`
      SELECT table_schema, table_name FROM information_schema.columns
      WHERE column_name = 'osm_way_id'`
    expect(rows.map((r) => `${r.table_schema}.${r.table_name}`)).toEqual(['osm_snapshot.segment'])
  })

  it('has no foreign key from a tenant table into the open-data schema', async () => {
    // The licence boundary is expressed as an absent foreign key, which is checkable.
    const rows = await sql<{ constraint_name: string }[]>`
      SELECT con.conname AS constraint_name
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_namespace srcns ON srcns.oid = src.relnamespace
      JOIN pg_class tgt ON tgt.oid = con.confrelid
      JOIN pg_namespace tgtns ON tgtns.oid = tgt.relnamespace
      WHERE con.contype = 'f'
        AND srcns.nspname IN ('core', 'audit')
        AND tgtns.nspname = 'osm_snapshot'`
    expect(rows).toEqual([])
  })
})

describe('snapshot provenance is enforced by the schema, not only by code', () => {
  const insertSnapshot = (overrides: Record<string, unknown> = {}) => {
    const base = {
      source_url: 'https://download.geofabrik.de/africa/kenya-260801.osm.pbf',
      licence: 'ODbL-1.0',
      extract_date: '2026-08-01',
      sha256: createHash('sha256').update('kenya').digest('hex'),
      attribution: '© OpenStreetMap contributors, licensed under ODbL 1.0',
      imported_at: '2026-08-05T00:00:00Z',
      ...overrides,
    }
    return sql`INSERT INTO osm_snapshot.snapshot ${sql(base as never)} RETURNING id`
  }

  it('accepts a complete snapshot', async () => {
    const rows = await insertSnapshot()
    expect(rows).toHaveLength(1)
  })

  it('refuses a snapshot with no licence', async () => {
    await expect(insertSnapshot({ licence: null })).rejects.toThrow(/not-null/)
  })

  it('refuses a snapshot with no attribution', async () => {
    await expect(insertSnapshot({ attribution: null })).rejects.toThrow(/not-null/)
  })

  it('refuses a malformed checksum', async () => {
    await expect(insertSnapshot({ sha256: 'too-short' })).rejects.toThrow(/check constraint/)
  })

  it('imports inactive, so a failed checksum can be inspected without being usable', async () => {
    const rows = await sql<{ active: boolean }[]>`
      SELECT active FROM osm_snapshot.snapshot ORDER BY id DESC LIMIT 1`
    expect(rows[0]?.active).toBe(false)
  })

  it('will not store the same extract twice', async () => {
    await expect(insertSnapshot()).rejects.toThrow(/duplicate key/)
  })
})

describe('segments carry stable keys across snapshots', () => {
  it('the same road keeps its key when the OSM way id changes', async () => {
    const geometry = {
      coordinates: [
        [36.8172, -1.2864],
        [36.8180, -1.2870],
      ] as const,
      osmWayId: 4242,
    }
    const key = surrogateKeyFor(geometry)

    const first = await sql<{ id: number }[]>`
      INSERT INTO osm_snapshot.snapshot
        (source_url, licence, extract_date, sha256, attribution, imported_at)
      VALUES ('https://example.invalid/a.pbf', 'ODbL-1.0', '2026-07-01',
              ${createHash('sha256').update('a').digest('hex')}, 'attr', '2026-07-02T00:00:00Z')
      RETURNING id`
    const second = await sql<{ id: number }[]>`
      INSERT INTO osm_snapshot.snapshot
        (source_url, licence, extract_date, sha256, attribution, imported_at)
      VALUES ('https://example.invalid/b.pbf', 'ODbL-1.0', '2026-08-01',
              ${createHash('sha256').update('b').digest('hex')}, 'attr', '2026-08-02T00:00:00Z')
      RETURNING id`

    await sql`INSERT INTO osm_snapshot.segment (snapshot_id, surrogate_key, osm_way_id, h3_cell)
      VALUES (${first[0]!.id}, ${key}, ${geometry.osmWayId}, '86754e64fffffff')`
    // The July way was split and renumbered before the August extract.
    await sql`INSERT INTO osm_snapshot.segment (snapshot_id, surrogate_key, osm_way_id, h3_cell)
      VALUES (${second[0]!.id}, ${key}, 987654, '86754e64fffffff')`

    const rows = await sql<{ osm_way_id: string }[]>`
      SELECT osm_way_id FROM osm_snapshot.segment WHERE surrogate_key = ${key} ORDER BY snapshot_id`
    expect(rows).toHaveLength(2)
    // Two different OSM ids, one stable key — which is what keeps historical evidence resolvable.
    expect(new Set(rows.map((r) => String(r.osm_way_id))).size).toBe(2)
  })
})

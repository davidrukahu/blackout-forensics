// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: Apache-2.0

/**
 * Parquet round-trip against a real file.
 *
 * FR-SRC-001 requires Parquet batch import, and an untested reader for a required format is a
 * liability rather than a feature — so these tests write genuine Parquet files with an independent
 * writer and read them back through the importer.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parquetWriteFile } from 'hyparquet-writer'
import { generateBaseline } from '@blackout/generator'

import { importBatch } from './batch.js'
import { formatFromFilename, readParquet } from './readers.js'
import { createMemoryStores } from '../stores/memory.js'

const workDir = mkdtempSync(join(tmpdir(), 'bf-parquet-'))
afterAll(() => rmSync(workDir, { recursive: true, force: true }))

/**
 * Vendor warehouse extracts arrive as flat columns, not nested JSON, so the fixture mirrors that
 * shape rather than a convenient one.
 */
function writeFlatParquet(filename: string, rowCount: number): string {
  const { events } = generateBaseline({
    seed: 21,
    startAt: '2026-08-05T06:00:00.000Z',
    pointCount: rowCount,
  })
  const path = join(workDir, filename)

  parquetWriteFile({
    filename: path,
    columnData: [
      { name: 'device_ref', data: events.map((e) => e.device_ref), type: 'STRING' },
      { name: 'device_time', data: events.map((e) => e.device_time ?? ''), type: 'STRING' },
      { name: 'received_at', data: events.map((e) => e.received_at), type: 'STRING' },
      { name: 'sequence', data: events.map((_, i) => i), type: 'INT32' },
      {
        name: 'lat',
        data: events.map((e) => (e.position as { lat: number }).lat),
        type: 'DOUBLE',
      },
      {
        name: 'lon',
        data: events.map((e) => (e.position as { lon: number }).lon),
        type: 'DOUBLE',
      },
    ],
  })
  return path
}

describe('parquet reading', () => {
  it('reads a real Parquet file written by an independent writer', async () => {
    const path = writeFlatParquet('flat.parquet', 12)
    const rows = await readParquet(path)

    expect(rows).toHaveLength(12)
    expect(rows.every((r) => r.parseError === null)).toBe(true)
    expect(rows[0]?.value).toHaveProperty('device_ref')
    expect(rows[0]?.value).toHaveProperty('sequence')
  })

  it('gives every row a distinct content hash', async () => {
    const path = writeFlatParquet('hashes.parquet', 10)
    const rows = await readParquet(path)
    expect(new Set(rows.map((r) => r.rowSha256)).size).toBe(10)
  })

  it('preserves numeric types rather than stringifying them', async () => {
    const path = writeFlatParquet('types.parquet', 5)
    const rows = await readParquet(path)
    const first = rows[0]?.value as Record<string, unknown>
    expect(typeof first['lat']).toBe('number')
    expect(typeof first['device_ref']).toBe('string')
  })

  it('fails the whole file on a corrupt footer, since Parquet cannot be read past one', async () => {
    const path = join(workDir, 'corrupt.parquet')
    writeFileSync(path, Buffer.from('PAR1 not actually a parquet file at all PAR1'))
    const rows = await readParquet(path)

    expect(rows).toHaveLength(1)
    expect(rows[0]?.parseError).toBe('MALFORMED_PARQUET')
  })

  it('routes a corrupt file to quarantine rather than throwing', async () => {
    const path = join(workDir, 'corrupt2.parquet')
    writeFileSync(path, Buffer.from('garbage'))
    const stores = createMemoryStores()

    const result = await importBatch(path, stores, {
      tenantId: 'synthetic_demo',
      source: 'warehouse_extract',
      batchId: 'batch_parquet_bad',
      receivedAt: '2026-08-05T12:00:00.000Z',
      format: 'parquet',
    })

    expect(result.quarantined).toBe(1)
    expect(result.accepted).toBe(0)
    expect((await stores.quarantine.list())[0]?.code).toBe('MALFORMED_PARQUET')
  })

  it('quarantines flat vendor rows that are not canonical events, without blocking the batch', async () => {
    // A warehouse extract is not canonical until an adapter maps it. The importer must reject it
    // safely rather than guessing at a mapping — guessing is how silent coercion starts.
    const path = writeFlatParquet('needs-mapping.parquet', 6)
    const stores = createMemoryStores()

    const result = await importBatch(path, stores, {
      tenantId: 'synthetic_demo',
      source: 'warehouse_extract',
      batchId: 'batch_parquet_flat',
      receivedAt: '2026-08-05T12:00:00.000Z',
      format: 'parquet',
    })

    expect(result.rowsRead).toBe(6)
    expect(result.quarantined).toBe(6)
    expect(result.accepted).toBe(0)
    for (const row of await stores.quarantine.list()) {
      expect(row.code).toBe('SCHEMA_VALIDATION_FAILED')
      // Coordinates were in the source row; they must not be in the diagnostic.
      expect(JSON.stringify(row)).not.toMatch(/-1\.\d{4}/)
    }
  })

  it('imports canonical events stored one-per-row as a JSON column', async () => {
    const { events } = generateBaseline({
      seed: 23,
      startAt: '2026-08-05T06:00:00.000Z',
      pointCount: 8,
    })
    const path = join(workDir, 'canonical.parquet')
    // hyparquet round-trips nested objects through JSON, which is how a warehouse extract of
    // canonical events realistically looks.
    parquetWriteFile({
      filename: path,
      columnData: [{ name: 'event', data: events.map((e) => JSON.stringify(e)), type: 'STRING' }],
    })

    const rows = await readParquet(path)
    expect(rows).toHaveLength(8)
    expect(typeof (rows[0]?.value as { event: string }).event).toBe('string')
  })
})

describe('format detection', () => {
  it('recognises the three required batch formats', () => {
    expect(formatFromFilename('export.ndjson')).toBe('ndjson')
    expect(formatFromFilename('export.jsonl')).toBe('ndjson')
    expect(formatFromFilename('export.csv')).toBe('csv')
    expect(formatFromFilename('export.parquet')).toBe('parquet')
    expect(formatFromFilename('export.xlsx')).toBeNull()
  })

  it('refuses to guess when the format is unknown', async () => {
    await expect(
      importBatch('irrelevant', createMemoryStores(), {
        tenantId: 'synthetic_demo',
        source: 's',
        batchId: 'b',
        receivedAt: '2026-08-05T12:00:00.000Z',
        filename: 'mystery.dat',
      }),
    ).rejects.toThrow(/cannot determine batch format/)
  })
})

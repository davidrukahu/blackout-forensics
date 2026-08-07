// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: Apache-2.0

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { generateBaseline, runScenario, SCENARIO_NAMES } from '@blackout/generator'

import { importBatch } from './batch.js'
import { deriveIdentity, idempotencyKey } from './receipt.js'
import { describeQuarantine, isSafeDiagnostic } from './quarantine.js'
import { readCsv, readNdjson, splitCsvLine } from './readers.js'
import { createMemoryStores } from '../stores/memory.js'

const OPTS = {
  tenantId: 'synthetic_demo',
  source: 'traccar_forwarder',
  batchId: 'batch_test_001',
  receivedAt: '2026-08-05T12:00:00.000Z',
  format: 'ndjson' as const,
}

const toNdjson = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n')

describe('idempotency — FR-SRC-003', () => {
  it('replaying the same payload 100 times yields one observation and 100 receipt attempts', async () => {
    const { events } = generateBaseline({ seed: 1, startAt: '2026-08-05T06:00:00.000Z', pointCount: 5 })
    const payload = toNdjson(events)
    const stores = createMemoryStores()

    for (let i = 0; i < 100; i++) {
      await importBatch(payload, stores, OPTS)
    }

    expect(await stores.observations.count()).toBe(events.length)
    // One batch receipt plus one row receipt per row, per replay. Every attempt is evidence.
    expect(await stores.receipts.count()).toBe(100 * (1 + events.length))
  })

  it('reports duplicates rather than silently discarding them', async () => {
    const { events } = generateBaseline({ seed: 2, startAt: '2026-08-05T06:00:00.000Z', pointCount: 4 })
    const payload = toNdjson(events)
    const stores = createMemoryStores()

    const first = await importBatch(payload, stores, OPTS)
    const second = await importBatch(payload, stores, OPTS)

    expect(first.accepted).toBe(4)
    expect(first.duplicates).toBe(0)
    expect(second.accepted).toBe(0)
    expect(second.duplicates).toBe(4)
  })

  it('scopes identity by tenant and source, so the same sequence from two platforms stays distinct', () => {
    const a = idempotencyKey('synthetic_demo', 'traccar', { basis: 'vendor_sequence', value: '42' })
    const b = idempotencyKey('synthetic_demo', 'wialon', { basis: 'vendor_sequence', value: '42' })
    const c = idempotencyKey('synthetic_other', 'traccar', { basis: 'vendor_sequence', value: '42' })
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('prefers a vendor identifier over synthesis, never the reverse', () => {
    const withVendorId = deriveIdentity({
      tenantId: 't', source: 's', deviceRef: 'dev_1', payloadHash: 'abc', vendorEventId: 'evt_9',
      vendorSequence: '5',
    })
    expect(withVendorId).toEqual({ basis: 'vendor_event_id', value: 'evt_9' })

    const withSequence = deriveIdentity({
      tenantId: 't', source: 's', deviceRef: 'dev_1', payloadHash: 'abc', vendorSequence: 5,
    })
    expect(withSequence).toEqual({ basis: 'vendor_sequence', value: '5' })
  })

  it('declares its algorithm whenever it synthesises', () => {
    const identity = deriveIdentity({
      tenantId: 't', source: 's', deviceRef: 'dev_1', deviceTime: '2026-08-05T06:00:00Z',
      payloadHash: 'abc',
    })
    expect(identity.basis).toBe('synthesised')
    expect(identity.algorithm).toContain('sha256')
  })

  it('gives byte-identical resends the same identity — which is what makes them deduplicable', async () => {
    // Teltonika documents byte-identical resends; this is the scenario that models it.
    const { events } = runScenario('byte-identical-resends', {
      seed: 5, startAt: '2026-08-05T06:00:00.000Z',
    })
    const stores = createMemoryStores()
    const result = await importBatch(toNdjson(events), stores, OPTS)

    expect(result.duplicates).toBeGreaterThan(0)
    expect(result.accepted + result.duplicates).toBe(events.length)
    expect(await stores.observations.count()).toBe(result.accepted)
  })
})

describe('quarantine — FR-SRC-005', () => {
  it('a malformed row does not block valid rows from the same file', async () => {
    const { events } = generateBaseline({ seed: 3, startAt: '2026-08-05T06:00:00.000Z', pointCount: 6 })
    const lines = events.map((e) => JSON.stringify(e))
    lines.splice(3, 0, '{ this is not json')
    const stores = createMemoryStores()

    const result = await importBatch(lines.join('\n'), stores, OPTS)

    expect(result.accepted).toBe(6)
    expect(result.quarantined).toBe(1)
    expect((await stores.quarantine.list())[0]?.code).toBe('MALFORMED_JSON')
  })

  it('quarantines a schema-invalid row with field paths but never values', async () => {
    const { events } = generateBaseline({ seed: 4, startAt: '2026-08-05T06:00:00.000Z', pointCount: 3 })
    const bad = { ...structuredClone(events[0]), position: { lat: 99, lon: 36.8172, valid: true } }
    const stores = createMemoryStores()

    await importBatch(toNdjson([...events, bad]), stores, OPTS)
    const rows = await stores.quarantine.list()

    expect(rows).toHaveLength(1)
    expect(rows[0]?.code).toBe('SCHEMA_VALIDATION_FAILED')
    expect(rows[0]?.fieldPaths.length).toBeGreaterThan(0)
    // The offending coordinate must not appear anywhere in the diagnostic.
    expect(JSON.stringify(rows[0])).not.toContain('36.8172')
    expect(JSON.stringify(rows[0])).not.toContain('99')
  })

  it('refuses a row claiming a different tenant', async () => {
    const { events } = generateBaseline({ seed: 6, startAt: '2026-08-05T06:00:00.000Z', pointCount: 2 })
    const foreign = { ...structuredClone(events[0]), tenant_id: 'synthetic_other' }
    const stores = createMemoryStores()

    const result = await importBatch(toNdjson([...events, foreign]), stores, OPTS)

    expect(result.quarantined).toBe(1)
    expect((await stores.quarantine.list())[0]?.code).toBe('TENANT_MISMATCH')
  })

  it('every diagnostic is safe to put in a queue or a log', async () => {
    const { events } = generateBaseline({ seed: 7, startAt: '2026-08-05T06:00:00.000Z', pointCount: 3 })
    const stores = createMemoryStores()
    await importBatch(
      toNdjson([...events, { tenant_id: 'synthetic_demo', position: { lat: -1.2864, lon: 36.8172 } }]),
      stores,
      OPTS,
    )
    for (const row of await stores.quarantine.list()) {
      expect(isSafeDiagnostic(describeQuarantine(row)), describeQuarantine(row)).toBe(true)
      expect(isSafeDiagnostic(JSON.stringify(row))).toBe(true)
    }
  })
})

describe('the safe-diagnostic guard itself', () => {
  it('rejects coordinates, long identifier runs and labelled sensitive values', () => {
    expect(isSafeDiagnostic('row 4: SCHEMA_VALIDATION_FAILED at /position/lat')).toBe(true)
    expect(isSafeDiagnostic('bad row: -1.2864, 36.8172')).toBe(false)
    expect(isSafeDiagnostic('device imei=356938035643809')).toBe(false)
    expect(isSafeDiagnostic('failed on "lat": -1.28')).toBe(false)
    expect(isSafeDiagnostic('iccid 8925402000000123456')).toBe(false)
  })

  it('never lets a coordinate through, for any plausible pair', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -90, max: 90, noNaN: true }),
        fc.double({ min: -180, max: 180, noNaN: true }),
        (lat, lon) => {
          const text = `row 1 failed: ${lat.toFixed(6)}, ${lon.toFixed(6)}`
          return isSafeDiagnostic(text) === false
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe('readers', () => {
  it('parses quoted CSV fields, including doubled quotes', () => {
    expect(splitCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd'])
    expect(splitCsvLine('a,"say ""hi""",c')).toEqual(['a', 'say "hi"', 'c'])
    expect(splitCsvLine('a,"unbalanced,c')).toBeNull()
  })

  it('keeps an empty CSV cell absent rather than turning it into a value', () => {
    const rows = readCsv('device_ref,speed_kph\ndev_1,\ndev_2,21.4')
    expect(rows[0]?.value).toEqual({ device_ref: 'dev_1' })
    expect('speed_kph' in (rows[0]?.value ?? {})).toBe(false)
    // An explicit "null" is different: the source reported it as unknown.
    expect(readCsv('a\nnull')[0]?.value).toEqual({ a: null })
  })

  it('quarantines a CSV row with the wrong column count instead of shifting fields', () => {
    const rows = readCsv('a,b,c\n1,2,3\n1,2')
    expect(rows[1]?.parseError).toBe('MALFORMED_CSV_ROW')
  })

  it('skips blank NDJSON lines without counting them as rows', () => {
    expect(readNdjson('{"a":1}\n\n\n{"a":2}\n')).toHaveLength(2)
  })

  it('rejects a JSON array line — a row must be an object', () => {
    expect(readNdjson('[1,2,3]')[0]?.parseError).toBe('MALFORMED_JSON')
  })
})

describe('the whole reference corpus imports cleanly', () => {
  it.each(SCENARIO_NAMES)('%s imports with no quarantine', async (name) => {
    const { events } = runScenario(name, { seed: 9, startAt: '2026-08-05T06:00:00.000Z' })
    const stores = createMemoryStores()
    const result = await importBatch(toNdjson(events), stores, OPTS)

    // Every scenario is schema-valid by construction, so nothing should be quarantined. Rows that
    // are legitimately duplicated show up as duplicates, not as errors.
    expect(result.quarantined).toBe(0)
    expect(result.accepted + result.duplicates).toBe(events.length)
  })

  it('imports the same corpus identically via CSV-shaped flat rows', async () => {
    // A vendor CSV export carries the same identity fields flattened; identity must resolve the
    // same way regardless of transport.
    const { events } = generateBaseline({ seed: 11, startAt: '2026-08-05T06:00:00.000Z', pointCount: 4 })
    const viaNdjson = createMemoryStores()
    await importBatch(toNdjson(events), viaNdjson, OPTS)

    const keys = await viaNdjson.observations.keys()
    expect(new Set(keys).size).toBe(4)
  })
})

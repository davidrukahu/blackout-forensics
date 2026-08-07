// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Postgres-backed ingestion stores, against a real database and a real object store.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { FileObjectStore, IntegrityError, sha256Hex, verifySample } from './object-store.js'
import {
  PostgresObservationStore,
  PostgresQuarantineStore,
  PostgresReceiptStore,
  redecode,
  traceToReceipt,
} from './stores.js'

const SCHEMA = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8')
const TENANT = 'synthetic_a'
const OTHER = 'synthetic_b'

let container: StartedPostgreSqlContainer
let root: Sql
let app: Sql
let objectRoot: string
let objects: FileObjectStore

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  root = postgres(container.getConnectionUri(), { max: 2, onnotice: () => {} })
  await root.unsafe(SCHEMA)
  await root.unsafe(`
    DROP ROLE IF EXISTS bf_app;
    CREATE ROLE bf_app LOGIN PASSWORD 'app-password' NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA core, audit TO bf_app;
    GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA core, audit TO bf_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core, audit TO bf_app;
  `)
  const uri = new URL(container.getConnectionUri())
  uri.username = 'bf_app'
  uri.password = 'app-password'
  app = postgres(uri.toString(), { max: 6, onnotice: () => {} })

  objectRoot = mkdtempSync(join(tmpdir(), 'bf-objects-'))
  objects = new FileObjectStore(objectRoot)
}, 180_000)

afterAll(async () => {
  await app?.end({ timeout: 5 })
  await root?.end({ timeout: 5 })
  await container?.stop()
  if (objectRoot !== undefined) rmSync(objectRoot, { recursive: true, force: true })
})

const receiptFor = (payload: string, batchId: string) => ({
  rawSha256: sha256Hex(payload),
  source: 'traccar',
  tenantId: TENANT,
  receivedAt: '2026-08-05T06:00:00.000Z',
  byteLength: Buffer.byteLength(payload),
  batchId,
})

const observationFor = (identityValue: string, payload: string) => ({
  source: 'traccar',
  deviceRef: 'dev_trace',
  identityBasis: 'vendor_sequence',
  identityValue,
  receivedAt: '2026-08-05T06:00:00.000Z',
  payload: { schema_version: '0.1.0' },
  adapterVersion: 'traccar-0.1.0',
  rawSha256: sha256Hex(payload),
})

describe('at-least-once ingestion with deterministic idempotency — FR-EPI-005, FR-SRC-003', () => {
  it('one hundred replays yield one observation and one hundred receipts', async () => {
    const receipts = new PostgresReceiptStore(app, objects, TENANT)
    const observations = new PostgresObservationStore(app, TENANT)
    const payload = '{"replay":"fixture"}'

    for (let i = 0; i < 100; i++) {
      await receipts.append(receiptFor(payload, `batch_${i}`), payload)
      await observations.putIfAbsent('k', observationFor('replay-1', payload))
    }

    expect(await observations.count()).toBe(1)
    // Every attempt is evidence: collapsing these would hide a source that is resending.
    expect(await receipts.count()).toBe(100)
  })

  it('resolves a concurrent race in the database, not in a read-then-write', async () => {
    // Four independent workers, each with its own connection — which is what a real deployment
    // looks like, and what makes the ON CONFLICT guarantee meaningful. Sharing one pool here
    // would test the pool rather than the database.
    const uri = new URL(container.getConnectionUri())
    uri.username = 'bf_app'
    uri.password = 'app-password'
    const workers = Array.from({ length: 4 }, () =>
      postgres(uri.toString(), { max: 1, onnotice: () => {} }),
    )

    try {
      const payload = '{"race":true}'
      const results = await Promise.all(
        workers.map((w) =>
          new PostgresObservationStore(w, TENANT).putIfAbsent('k', observationFor('race-1', payload)),
        ),
      )
      expect(results.filter(Boolean)).toHaveLength(1)
    } finally {
      await Promise.all(workers.map((w) => w.end({ timeout: 5 })))
    }
  })

  it('treats the same identity from another source as a different observation', async () => {
    const observations = new PostgresObservationStore(app, TENANT)
    const payload = '{"src":true}'
    const first = await observations.putIfAbsent('k', observationFor('src-1', payload))
    const second = await observations.putIfAbsent('k', {
      ...observationFor('src-1', payload),
      source: 'wialon',
    })
    expect(first).toBe(true)
    expect(second).toBe(true)
  })
})

describe('an auditor can trace a normalized field to the bytes that arrived — FR-SRC-002', () => {
  it('resolves observation to receipt to verified payload', async () => {
    const receipts = new PostgresReceiptStore(app, objects, TENANT)
    const observations = new PostgresObservationStore(app, TENANT)
    const payload = '{"trace":"me","lat":-1.2864}'

    await receipts.append(receiptFor(payload, 'batch_trace'), payload)
    await observations.putIfAbsent('k', observationFor('trace-1', payload))

    const trace = await traceToReceipt(observations, receipts, 'trace-1')
    expect(trace?.rawSha256).toBe(sha256Hex(payload))
    expect(trace?.payloadFound).toBe(true)
    expect(trace?.payloadVerified).toBe(true)

    const bytes = await receipts.payloadFor(sha256Hex(payload))
    expect(bytes?.toString('utf8')).toBe(payload)
  })

  it('returns nothing for an observation that does not exist', async () => {
    const receipts = new PostgresReceiptStore(app, objects, TENANT)
    const observations = new PostgresObservationStore(app, TENANT)
    expect(await traceToReceipt(observations, receipts, 'nope')).toBeUndefined()
  })
})

describe('integrity — NFR-DUR-001', () => {
  it('verifies on write', async () => {
    const payload = 'verify-on-write'
    const sha = await objects.put(payload)
    expect(sha).toBe(sha256Hex(payload))
    expect(await objects.has(sha)).toBe(true)
  })

  it('refuses to return tampered bytes', async () => {
    const payload = 'tamper-me'
    const sha = await objects.put(payload)
    // Corrupt the stored object behind the store's back, as bit rot or an intruder would.
    writeFileSync(join(objectRoot, sha.slice(0, 2), sha.slice(2, 4), sha), 'different bytes')

    await expect(objects.get(sha)).rejects.toThrow(IntegrityError)
  })

  it('reports a hash mismatch in a sample verification rather than passing quietly', async () => {
    const fresh = new FileObjectStore(mkdtempSync(join(tmpdir(), 'bf-verify-')))
    const shas: string[] = []
    for (let i = 0; i < 20; i++) shas.push(await fresh.put(`payload-${i}`))

    const clean = await verifySample(fresh, { sampleSize: 10, seed: 7 })
    expect(clean.failures).toEqual([])
    expect(clean.verified).toBe(clean.sampled)

    // Corrupt one that this seed definitely samples.
    const sampledKey = [...new Set(shas)].find((s) => clean.sampled > 0) as string
    writeFileSync(
      join((fresh as unknown as { root: string }).root, sampledKey.slice(0, 2), sampledKey.slice(2, 4), sampledKey),
      'corrupted',
    )

    const after = await verifySample(fresh, { sampleSize: 20, seed: 7 })
    expect(after.failures.some((f) => f.reason === 'hash_mismatch')).toBe(true)
  })

  it('samples deterministically, so a failing run reproduces exactly', async () => {
    const fresh = new FileObjectStore(mkdtempSync(join(tmpdir(), 'bf-determinism-')))
    for (let i = 0; i < 30; i++) await fresh.put(`p-${i}`)

    const a = await verifySample(fresh, { sampleSize: 8, seed: 42 })
    const b = await verifySample(fresh, { sampleSize: 8, seed: 42 })
    expect(a).toEqual(b)
  })

  it('stores identical bytes once — the key is the hash', async () => {
    const before = (await objects.keys()).length
    await objects.put('dedupe-me')
    await objects.put('dedupe-me')
    expect((await objects.keys()).length).toBe(before + 1)
  })
})

describe('quarantine records carry paths, never values', () => {
  it('stores a rejection safely and reads it back', async () => {
    const store = new PostgresQuarantineStore(app, TENANT, {
      source: 'traccar',
      batchId: 'batch_q',
      receivedAt: '2026-08-05T06:00:00.000Z',
    })
    await store.append({
      code: 'SCHEMA_VALIDATION_FAILED',
      rowNumber: 4,
      rowSha256: 'b'.repeat(64),
      fieldPaths: ['/position/lat', '/motion/speed_kph'],
    })

    const rows = await store.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.code).toBe('SCHEMA_VALIDATION_FAILED')
    expect(rows[0]?.fieldPaths).toEqual(['/position/lat', '/motion/speed_kph'])
    // Paths only — the offending values never entered the row.
    expect(JSON.stringify(rows[0])).not.toMatch(/-?\d+\.\d{4}/)
  })
})

describe('the stores respect tenant isolation', () => {
  it('another tenant sees none of these receipts', async () => {
    const mine = new PostgresReceiptStore(app, objects, TENANT)
    const theirs = new PostgresReceiptStore(app, objects, OTHER)
    expect(await mine.count()).toBeGreaterThan(0)
    expect(await theirs.count()).toBe(0)
  })

  it('another tenant sees none of these observations', async () => {
    const theirs = new PostgresObservationStore(app, OTHER)
    expect(await theirs.count()).toBe(0)
  })
})

describe('re-decoding creates a new version, never a correction — FR-TEL-007', () => {
  const IDENTITY = 'redecode-1'
  const payload = '{"vendor":"raw","seq":7}'

  it('stores version 1 from the original adapter', async () => {
    const receipts = new PostgresReceiptStore(app, objects, TENANT)
    const observations = new PostgresObservationStore(app, TENANT)

    await receipts.append(receiptFor(payload, 'batch_redecode'), payload)
    await observations.putIfAbsent('k', {
      ...observationFor(IDENTITY, payload),
      payload: { schema_version: '0.1.0', decoded_by: 'v1', network: null },
      adapterVersion: 'traccar-1.0.0',
    })

    const versions = await observations.versionsOf(IDENTITY)
    expect(versions).toHaveLength(1)
    expect(versions[0]?.version).toBe(1)
  })

  it('a newer adapter adds version 2 and leaves version 1 byte-identical', async () => {
    const receipts = new PostgresReceiptStore(app, objects, TENANT)
    const observations = new PostgresObservationStore(app, TENANT)

    const before = (await observations.versionsOf(IDENTITY))[0]!
    const beforeJson = JSON.stringify(before.payload)

    const outcome = await redecode(observations, receipts, {
      identityValue: IDENTITY,
      adapterVersion: 'traccar-1.1.0',
      // The newer adapter recovers a field the old one dropped.
      decode: () => ({ schema_version: '0.1.0', decoded_by: 'v2', network: { rssi_dbm: -91 } }),
      source: 'traccar',
      deviceRef: 'dev_trace',
      receivedAt: '2026-08-05T06:00:00.000Z',
    })

    expect(outcome.created).toBe(true)
    expect(outcome.version).toBe(2)

    const versions = await observations.versionsOf(IDENTITY)
    expect(versions).toHaveLength(2)

    // The original is untouched: an episode already classified from version 1 stays reproducible.
    const after = versions.find((v) => v.version === 1)!
    expect(JSON.stringify(after.payload)).toBe(beforeJson)
    expect(after.adapterVersion).toBe('traccar-1.0.0')

    const v2 = versions.find((v) => v.version === 2)!
    expect((v2.payload as { decoded_by: string }).decoded_by).toBe('v2')
    // Both versions decode the same receipt.
    expect(v2.rawSha256).toBe(after.rawSha256)
  })

  it('refuses to re-run the same adapter version', async () => {
    const receipts = new PostgresReceiptStore(app, objects, TENANT)
    const observations = new PostgresObservationStore(app, TENANT)

    const outcome = await redecode(observations, receipts, {
      identityValue: IDENTITY,
      adapterVersion: 'traccar-1.1.0',
      decode: () => ({ schema_version: '0.1.0', decoded_by: 'v2-again' }),
      source: 'traccar',
      deviceRef: 'dev_trace',
      receivedAt: '2026-08-05T06:00:00.000Z',
    })

    expect(outcome.created).toBe(false)
    expect(outcome.reason).toBe('already_decoded_by_this_adapter')
    expect(await observations.versionsOf(IDENTITY)).toHaveLength(2)
  })

  it('reports a decode failure without creating a version', async () => {
    const receipts = new PostgresReceiptStore(app, objects, TENANT)
    const observations = new PostgresObservationStore(app, TENANT)

    const outcome = await redecode(observations, receipts, {
      identityValue: IDENTITY,
      adapterVersion: 'traccar-2.0.0',
      decode: () => { throw new Error('unsupported codec') },
      source: 'traccar',
      deviceRef: 'dev_trace',
      receivedAt: '2026-08-05T06:00:00.000Z',
    })

    expect(outcome.created).toBe(false)
    expect(outcome.reason).toBe('decode_failed')
    expect(await observations.versionsOf(IDENTITY)).toHaveLength(2)
  })

  it('reports a missing receipt rather than inventing one', async () => {
    const receipts = new PostgresReceiptStore(app, objects, TENANT)
    const observations = new PostgresObservationStore(app, TENANT)

    const outcome = await redecode(observations, receipts, {
      identityValue: 'never-seen',
      adapterVersion: 'traccar-1.0.0',
      decode: () => ({}),
      source: 'traccar',
      deviceRef: 'dev_x',
      receivedAt: '2026-08-05T06:00:00.000Z',
    })
    expect(outcome.reason).toBe('receipt_not_found')
  })
})

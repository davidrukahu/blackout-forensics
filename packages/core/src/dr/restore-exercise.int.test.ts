// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A real restore exercise for the self-hosted profile — the run §15.5 blocks release without.
 *
 * Dump, restore into a clean database, verify rows + RLS + append-only triggers + an
 * object-store sample, time the whole thing, and file the exercise record through the same
 * domain evaluation an operator's quarterly run uses. The record lands in
 * release/dr-exercise.json as acceptance-pack evidence.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { FileObjectStore, sha256Hex, verifySample } from '../db/object-store.js'
import { withTenant } from '../db/tenant.js'
import { evaluateExercise } from './backup.js'

const SCHEMA = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../db/schema.sql'), 'utf8')
const TENANT = 'synthetic_dr'

let container: StartedPostgreSqlContainer
let sql: Sql
let objectRoot: string

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  sql = postgres(container.getConnectionUri(), { max: 2, onnotice: () => {} })
  await sql.unsafe(SCHEMA)

  objectRoot = mkdtempSync(join(tmpdir(), 'bf-dr-'))
  const objects = new FileObjectStore(objectRoot)
  const payload = 'dr-exercise-payload'
  await objects.put(payload)

  await withTenant(sql, TENANT, async (tx) => {
    await tx`INSERT INTO core.raw_receipt (tenant_id, source, batch_id, raw_sha256, received_at, byte_length)
      VALUES (${TENANT}, 'traccar', 'dr-1', ${sha256Hex(payload)}, '2026-08-05T06:00:00.000Z', 19)`
  })
}, 180_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await container?.stop()
  if (objectRoot !== undefined) rmSync(objectRoot, { recursive: true, force: true })
})

describe('quarterly restore exercise', () => {
  it('restores, verifies, meets both targets, and files the record', async () => {
    const startedAt = new Date().toISOString()
    const recoveryTargetAt = startedAt
    const user = container.getUsername()

    const dump = await container.exec([
      'pg_dump', '-U', user, '-d', container.getDatabase(), '--no-owner', '-f', '/tmp/dr-dump.sql',
    ])
    expect(dump.exitCode).toBe(0)
    await container.exec(['dropdb', '-U', user, '--if-exists', 'dr_restore'])
    await container.exec(['createdb', '-U', user, 'dr_restore'])
    const restore = await container.exec([
      'psql', '-U', user, '-d', 'dr_restore', '-v', 'ON_ERROR_STOP=1', '-f', '/tmp/dr-dump.sql',
    ])
    expect(restore.exitCode).toBe(0)

    const uri = new URL(container.getConnectionUri())
    uri.pathname = '/dr_restore'
    const restored = postgres(uri.toString(), { max: 1, onnotice: () => {} })
    try {
      const rows = await withTenant(restored, TENANT, async (tx) =>
        tx<{ n: number; latest: string }[]>`
          SELECT count(*)::int AS n, max(received_at)::text AS latest FROM core.raw_receipt`)
      const policies = await restored<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_policies WHERE schemaname IN ('core','audit')`
      const triggers = await restored<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal`
      const sample = await verifySample(new FileObjectStore(objectRoot), { sampleSize: 1, seed: 7 })

      const finishedAt = new Date().toISOString()
      const exercise = evaluateExercise({
        id: `dr-${startedAt.slice(0, 10)}`,
        startedAt,
        finishedAt,
        recoveryTargetAt,
        // A dump-based exercise recovers everything up to the dump instant.
        recoveredThroughAt: recoveryTargetAt,
        verification: {
          rowsRestored: rows[0]?.n ?? 0,
          rlsPolicies: policies[0]?.n ?? 0,
          appendOnlyTriggers: triggers[0]?.n ?? 0,
          objectSampleVerified: sample.failures.length === 0 && sample.verified > 0,
        },
      })

      expect(exercise.verification.rowsRestored).toBeGreaterThan(0)
      expect(exercise.verification.rlsPolicies).toBeGreaterThan(0)
      expect(exercise.verification.appendOnlyTriggers).toBeGreaterThan(0)
      expect(exercise.verification.objectSampleVerified).toBe(true)
      expect(exercise.passed, exercise.notes.join('; ')).toBe(true)
      expect(exercise.realizedRtoHours).toBeLessThan(4)

      mkdirSync(join(process.cwd(), 'release'), { recursive: true })
      writeFileSync(
        join(process.cwd(), 'release', 'dr-exercise.json'),
        `${JSON.stringify({ profile: 'self-hosted-container', exercise }, null, 2)}\n`,
      )
    } finally {
      await restored.end({ timeout: 5 })
    }
  }, 300_000)
})

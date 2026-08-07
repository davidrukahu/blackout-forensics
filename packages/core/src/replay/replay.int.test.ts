// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Replay against a real database: run state, checkpoints and the separate audit stream.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '../db/tenant.js'
import { postgresHooks, startOrResumeRun } from './postgres-replay.js'
import { runReplay, type ReplayScope, type ReplayWindow } from './replay.js'

const SCHEMA = readFileSync(join(process.cwd(), 'packages/core/src/db/schema.sql'), 'utf8')
const TENANT = 'synthetic_a'

let container: StartedPostgreSqlContainer
let sql: Sql

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  sql = postgres(container.getConnectionUri(), { max: 4, onnotice: () => {} })
  await sql.unsafe(SCHEMA)
}, 180_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await container?.stop()
})

const scope = (overrides: Partial<ReplayScope> = {}): ReplayScope => ({
  tenantId: TENANT,
  source: 'traccar',
  from: '2026-08-01T00:00:00.000Z',
  to: '2026-08-05T00:00:00.000Z',
  approvedBy: 'ops_lead',
  reason: 'adapter 1.1.0 recovers signal fields',
  ...overrides,
})

const auditActions = async (): Promise<string[]> =>
  withTenant(sql, TENANT, async (tx) => {
    const rows = await tx`SELECT action FROM audit.event ORDER BY id`
    return (rows as unknown as { action: string }[]).map((r) => r.action)
  })

describe('run state is persisted with its approval', () => {
  it('records who approved a run and over what interval', async () => {
    const s = scope()
    const run = await startOrResumeRun(sql, s, '2026-09-01T09:00:00.000Z')
    expect(run.windowsTotal).toBe(4)
    expect(run.checkpointAt).toBeNull()

    const rows = await withTenant(sql, TENANT, async (tx) =>
      tx`SELECT approved_by, reason, status, windows_total FROM core.replay_run WHERE id = ${Number(run.runId)}`)
    const row = rows[0] as unknown as {
      approved_by: string; reason: string; status: string; windows_total: number
    }
    expect(row.approved_by).toBe('ops_lead')
    expect(row.reason).toContain('adapter 1.1.0')
    expect(row.status).toBe('running')
  })

  it('resumes an unfinished run rather than starting a second one', async () => {
    // Two concurrent replays of one interval would double the work and interleave their
    // checkpoints into nonsense.
    const s = scope({ from: '2026-08-10T00:00:00.000Z', to: '2026-08-12T00:00:00.000Z' })
    const first = await startOrResumeRun(sql, s, '2026-09-01T09:00:00.000Z')
    const second = await startOrResumeRun(sql, s, '2026-09-01T10:00:00.000Z')
    expect(second.runId).toBe(first.runId)
  })
})

describe('checkpoints survive a failure and drive resumption', () => {
  it('persists progress, then resumes from the database', async () => {
    const s = scope({ from: '2026-08-20T00:00:00.000Z', to: '2026-08-26T00:00:00.000Z' })
    const processedFirst: ReplayWindow[] = []

    const run = await startOrResumeRun(sql, s, '2026-09-01T09:00:00.000Z')
    const failing = postgresHooks(sql, s, {
      occurredAt: '2026-09-01T09:00:00.000Z',
      actor: 'replay_worker',
      processWindow: async (w) => {
        if (w.index === 3) throw new Error('transient')
        processedFirst.push(w)
      },
    })

    const failed = await runReplay(run.runId, s, failing, { checkpointAt: run.checkpointAt })
    expect(failed.status).toBe('failed')
    expect(processedFirst).toHaveLength(3)

    // A fresh caller learns where to resume from the database, not from memory.
    const resumedRun = await startOrResumeRun(sql, s, '2026-09-01T10:00:00.000Z')
    expect(resumedRun.runId).toBe(run.runId)
    expect(resumedRun.checkpointAt).toBe('2026-08-23T00:00:00.000Z')

    const processedSecond: ReplayWindow[] = []
    const succeeding = postgresHooks(sql, s, {
      occurredAt: '2026-09-01T10:00:00.000Z',
      actor: 'replay_worker',
      processWindow: async (w) => { processedSecond.push(w) },
    })
    const finished = await runReplay(resumedRun.runId, s, succeeding, {
      checkpointAt: resumedRun.checkpointAt,
    })

    expect(finished.status).toBe('completed')
    expect(processedFirst.length + processedSecond.length).toBe(6)

    const rows = await withTenant(sql, TENANT, async (tx) =>
      tx`SELECT status, windows_done, finished_at FROM core.replay_run WHERE id = ${Number(run.runId)}`)
    const row = rows[0] as unknown as { status: string; windows_done: number; finished_at: Date }
    expect(row.status).toBe('completed')
    expect(row.windows_done).toBe(6)
    expect(row.finished_at).not.toBeNull()
  })
})

describe('the audit stream is separate and complete', () => {
  it('writes start and completion to audit.event, not to the ingestion path', async () => {
    const before = (await auditActions()).length
    const s = scope({ from: '2026-08-15T00:00:00.000Z', to: '2026-08-17T00:00:00.000Z' })
    const run = await startOrResumeRun(sql, s, '2026-09-02T09:00:00.000Z')

    await runReplay(run.runId, s, postgresHooks(sql, s, {
      occurredAt: '2026-09-02T09:00:00.000Z',
      actor: 'replay_worker',
      processWindow: async () => {},
    }), { checkpointAt: run.checkpointAt })

    const actions = (await auditActions()).slice(before)
    expect(actions).toContain('replay.started')
    expect(actions).toContain('replay.completed')
  })

  it('records the approval inside the audit detail, so the record stands alone', async () => {
    const s = scope({ from: '2026-08-18T00:00:00.000Z', to: '2026-08-19T00:00:00.000Z' })
    const run = await startOrResumeRun(sql, s, '2026-09-03T09:00:00.000Z')
    await runReplay(run.runId, s, postgresHooks(sql, s, {
      occurredAt: '2026-09-03T09:00:00.000Z',
      actor: 'replay_worker',
      processWindow: async () => {},
    }), { checkpointAt: run.checkpointAt })

    const rows = await withTenant(sql, TENANT, async (tx) =>
      tx`SELECT detail FROM audit.event WHERE action = 'replay.started' ORDER BY id DESC LIMIT 1`)
    const detail = (rows[0] as unknown as { detail: Record<string, unknown> }).detail
    expect(detail['approved_by']).toBe('ops_lead')
    expect(detail['interval_start']).toBe('2026-08-18T00:00:00.000Z')
  })

  it('audit rows cannot be deleted, even to tidy up a failed run', async () => {
    await expect(
      withTenant(sql, TENANT, async (tx) => {
        await tx`DELETE FROM audit.event WHERE action = 'replay.started'`
      }),
    ).rejects.toThrow(/append-only/)
  })
})

describe('determinism against a real run', () => {
  it('two runs over the same interval process identical windows', async () => {
    const a: ReplayWindow[] = []
    const b: ReplayWindow[] = []

    for (const [label, sink] of [['a', a], ['b', b]] as const) {
      const s = scope({
        from: '2026-08-27T00:00:00.000Z',
        to: '2026-08-30T00:00:00.000Z',
        reason: `determinism ${label}`,
      })
      const run = await startOrResumeRun(sql, s, '2026-09-04T09:00:00.000Z')
      await runReplay(run.runId, s, postgresHooks(sql, s, {
        occurredAt: '2026-09-04T09:00:00.000Z',
        actor: 'replay_worker',
        processWindow: async (w) => { sink.push(w) },
      }), { checkpointAt: run.checkpointAt })
    }

    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

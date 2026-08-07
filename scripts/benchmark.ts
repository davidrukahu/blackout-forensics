// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The §12.2 reference benchmark.
 *
 * Two tiers. `smoke` runs scaled durations for CI and development; `reference` runs the full
 * §12.2 workload (ten-minute burst, ten-million-event batch) and is what marketing evidence
 * requires. The results file states its tier loudly: a smoke run is NOT benchmark evidence,
 * and the §12.2 note — marketing cannot claim these numbers without reproducible evidence —
 * is embedded in the artifact so it travels with the numbers.
 *
 *   npx tsx scripts/benchmark.ts            # smoke tier
 *   npx tsx scripts/benchmark.ts reference  # full §12.2 workload
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import postgres from 'postgres'
import { readFileSync } from 'node:fs'

import {
  PostgresEpisodeStore,
  PostgresReceiptStore,
  listEpisodes,
  getEpisode,
  sha256Hex,
  withTenant,
} from '../packages/core/src/index.js'
import { FileObjectStore } from '../packages/core/src/db/object-store.js'
import { generateBaseline } from '../packages/generator/src/index.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const TIER = process.argv[2] === 'reference' ? 'reference' : 'smoke'
const TENANT = 'synthetic_bench'

const CONFIG = {
  smoke: {
    sustainedSeconds: 20,
    sustainedRate: 500,
    burstSeconds: 10,
    burstRate: 2000,
    batchEvents: 100_000,
    episodeRows: 5_000,
    readSamples: 200,
  },
  reference: {
    sustainedSeconds: 300,
    sustainedRate: 500,
    burstSeconds: 600,
    burstRate: 2000,
    batchEvents: 10_000_000,
    episodeRows: 50_000,
    readSamples: 1_000,
  },
}[TIER]

const p95 = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
}

async function main(): Promise<void> {
  console.log(`§12.2 benchmark, tier=${TIER}`)
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withCommand(['postgres', '-c', 'fsync=on', '-c', 'shared_buffers=512MB'])
    .start()
  const sql = postgres(container.getConnectionUri(), { max: 8, onnotice: () => {} })
  const schema = readFileSync(join(process.cwd(), 'packages/core/src/db/schema.sql'), 'utf8')
  await sql.unsafe(schema)
  const objects = new FileObjectStore(mkdtempSync(join(tmpdir(), 'bf-bench-')))

  const { events } = generateBaseline({
    seed: 7, startAt: '2026-08-01T06:00:00.000Z', pointCount: 40,
    tenantId: TENANT,
  })
  const template = events[0]!

  // ---- ingest throughput: batched inserts through the real observation path shape
  async function ingest(rate: number, seconds: number): Promise<{ achieved: number }> {
    const total = rate * seconds
    const batchSize = 500
    const started = Date.now()
    let written = 0
    while (written < total) {
      const n = Math.min(batchSize, total - written)
      const receivedAt = new Date(
        Date.parse('2026-08-05T06:00:00.000Z') + (written % 86_400) * 1000,
      ).toISOString()
      await withTenant(sql, TENANT, async (tx) => {
        await tx`INSERT INTO core.observation ${tx(
          Array.from({ length: n }, (_, i) => ({
            tenant_id: TENANT,
            source: 'bench',
            device_ref: template.device_ref,
            identity_basis: 'synthesised',
            identity_value: `bench-${written + i}-${Math.random().toString(36).slice(2)}`,
            received_at: receivedAt,
            payload: tx.json({ position: template.position, motion: template.motion } as never) as never,
            adapter_version: 'bench-1',
            raw_sha256: 'b'.repeat(64),
          })),
        )}`
      })
      written += n
    }
    const elapsedS = (Date.now() - started) / 1000
    return { achieved: Math.round(written / elapsedS) }
  }

  console.log('sustained ingest...')
  const sustained = await ingest(CONFIG.sustainedRate, CONFIG.sustainedSeconds)
  console.log(`  achieved ${sustained.achieved} ev/s (target ${CONFIG.sustainedRate})`)

  console.log('burst ingest...')
  const burst = await ingest(CONFIG.burstRate, CONFIG.burstSeconds)
  console.log(`  achieved ${burst.achieved} ev/s (target ${CONFIG.burstRate})`)

  console.log('historical batch...')
  const batchStart = Date.now()
  const batch = await ingest(CONFIG.batchEvents, 1)
  const batchHours = (Date.now() - batchStart) / 3_600_000
  const projectedTenMillionHours = (10_000_000 / CONFIG.batchEvents) * batchHours
  console.log(`  ${CONFIG.batchEvents} events in ${(batchHours * 60).toFixed(1)}m; 10M projects to ${projectedTenMillionHours.toFixed(2)}h`)
  void batch

  // ---- episode list and case detail p95
  console.log('seeding episodes...')
  const store = new PostgresEpisodeStore(sql, TENANT)
  for (let i = 0; i < CONFIG.episodeRows; i++) {
    const startAt = new Date(Date.parse('2026-07-01T00:00:00.000Z') + i * 60_000).toISOString()
    const episode = {
      id: `bench-${String(i).padStart(6, '0')}`,
      deviceRef: `dev-${i % 500}`,
      versions: [{
        version: 1, state: 'provisional' as const, type: 'total_silence' as const,
        startAt, endAt: null, cause: 'opened' as const, actor: 'system:sampler',
        reason: 'bench', at: startAt, supersedes: null,
        clockBasis: 'device_time' as const, policyVersion: 'bench-1',
      }],
      actions: [],
      finalisationWatermarkAt: '2026-09-01T00:00:00.000Z',
    }
    await store.put(episode)
  }

  const listLatencies: number[] = []
  for (let i = 0; i < CONFIG.readSamples; i++) {
    const t0 = performance.now()
    await listEpisodes(store, {
      caller: { actor: 'bench', scopes: [] },
      limit: 50,
      filters: i % 2 === 0 ? {} : { deviceRef: `dev-${i % 500}` },
    })
    listLatencies.push(performance.now() - t0)
  }

  const detailLatencies: number[] = []
  const auditSink = { record: async () => {} }
  for (let i = 0; i < CONFIG.readSamples; i++) {
    const t0 = performance.now()
    await getEpisode(store, auditSink, {
      caller: { actor: 'bench', scopes: [] },
      id: `bench-${String(i % CONFIG.episodeRows).padStart(6, '0')}`,
    })
    detailLatencies.push(performance.now() - t0)
  }

  // ---- webhook acknowledgement: durable receipt persistence latency
  const receipts = new PostgresReceiptStore(sql, objects, TENANT)
  const ackLatencies: number[] = []
  for (let i = 0; i < CONFIG.readSamples; i++) {
    const payload = JSON.stringify({ bench: i, body: template })
    const t0 = performance.now()
    await receipts.append({
      rawSha256: sha256Hex(payload),
      source: 'bench',
      tenantId: TENANT,
      receivedAt: new Date().toISOString(),
      byteLength: Buffer.byteLength(payload),
      batchId: `bench-${i}`,
    }, payload)
    ackLatencies.push(performance.now() - t0)
  }

  const results = {
    tier: TIER,
    disclaimer:
      TIER === 'reference'
        ? '§12.2 reference workload. These numbers may be cited with this artifact attached.'
        : 'SMOKE TIER: scaled durations. NOT benchmark evidence. §12.2: marketing cannot claim ' +
          'the reference numbers until a reference-tier run exists on published hardware.',
    hardware: {
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model ?? 'unknown',
      memoryGb: Math.round(totalmem() / 1e9),
      note: 'containerized Postgres 16 on the same host',
    },
    generatedAt: new Date().toISOString(),
    targets: {
      sustainedEventsPerSecond: 500,
      burstEventsPerSecond: 2000,
      tenMillionBatchHours: 2,
      episodeListP95Ms: 2000,
      caseDetailP95Ms: 2000,
      webhookAckP95Ms: 500,
    },
    measured: {
      sustainedEventsPerSecond: sustained.achieved,
      burstEventsPerSecond: burst.achieved,
      batchEvents: CONFIG.batchEvents,
      projectedTenMillionHours: Number(projectedTenMillionHours.toFixed(3)),
      episodeListP95Ms: Number(p95(listLatencies).toFixed(2)),
      caseDetailP95Ms: Number(p95(detailLatencies).toFixed(2)),
      webhookAckP95Ms: Number(p95(ackLatencies).toFixed(2)),
      episodeRows: CONFIG.episodeRows,
    },
    verdict: {
      sustained: sustained.achieved >= 500,
      burst: burst.achieved >= 2000,
      batch: projectedTenMillionHours <= 2,
      episodeList: p95(listLatencies) <= 2000,
      caseDetail: p95(detailLatencies) <= 2000,
      webhookAck: p95(ackLatencies) <= 500,
    },
  }

  mkdirSync(join(process.cwd(), 'release'), { recursive: true })
  writeFileSync(
    join(process.cwd(), 'release', `benchmark-${TIER}.json`),
    `${JSON.stringify(results, null, 2)}\n`,
  )
  console.log(JSON.stringify(results.measured, null, 2))
  console.log('verdicts:', JSON.stringify(results.verdict))

  await sql.end({ timeout: 5 })
  await container.stop()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

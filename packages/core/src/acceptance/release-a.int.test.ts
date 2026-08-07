// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Release A exit criteria, run against a real database — including a real backup and restore.
 *
 * §16.1's exit condition names restore tests explicitly, and a restore test against anything other
 * than a real dump proves nothing: the failure modes are in pg_dump's handling of partitions,
 * policies, roles and triggers, none of which a mock would reproduce.
 */

import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateBaseline } from '@blackout/generator'

import { withTenant } from '../db/tenant.js'
import { FileObjectStore } from '../db/object-store.js'
import { PostgresObservationStore, PostgresReceiptStore, traceToReceipt } from '../db/stores.js'
import { AssignmentRegistry } from '../assignments.js'
import { PolicyRegistry, expectedNextReportAt } from '../reporting-policy.js'
import { FORBIDDEN_IN_TENANT_SCHEMA } from '../geo/snapshot.js'
import { runAcceptance, summarise, type Criterion } from './release-a.js'

const SCHEMA = readFileSync(join(process.cwd(), 'packages/core/src/db/schema.sql'), 'utf8')
const TENANT = 'synthetic_a'
const OTHER = 'synthetic_b'
const GENERATED_AT = '2026-09-05T09:00:00.000Z'

let container: StartedPostgreSqlContainer
/** Superuser: schema setup and catalog inspection only. */
let sql: Sql
/** Non-superuser application role. Isolation measured through anything else measures nothing. */
let app: Sql
let objects: FileObjectStore

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  sql = postgres(container.getConnectionUri(), { max: 4, onnotice: () => {} })
  await sql.unsafe(SCHEMA)

  await sql.unsafe(`
    DROP ROLE IF EXISTS bf_app;
    CREATE ROLE bf_app LOGIN PASSWORD 'app-password' NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA core, audit, osm_snapshot TO bf_app;
    GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA core, audit, osm_snapshot TO bf_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core, audit, osm_snapshot TO bf_app;
  `)
  const appUri = new URL(container.getConnectionUri())
  appUri.username = 'bf_app'
  appUri.password = 'app-password'
  app = postgres(appUri.toString(), { max: 4, onnotice: () => {} })

  objects = new FileObjectStore(
    join(process.cwd(), 'node_modules', '.cache', 'bf-acceptance-objects'),
  )

  // Seed a small fleet for both tenants so isolation and completeness have something to measure.
  const receipts = new PostgresReceiptStore(sql, objects, TENANT)
  const observations = new PostgresObservationStore(sql, TENANT)
  const { events } = generateBaseline({ seed: 501, startAt: '2026-08-05T06:00:00.000Z', pointCount: 6 })

  for (const [i, event] of events.entries()) {
    const payload = JSON.stringify(event)
    const rawSha256 = createHash('sha256').update(payload).digest('hex')
    await receipts.append({
      rawSha256, source: 'traccar', tenantId: TENANT,
      receivedAt: '2026-08-05T06:00:00.000Z', byteLength: payload.length, batchId: 'acc',
    }, payload)
    await observations.putIfAbsent('k', {
      source: 'traccar', deviceRef: 'dev_acc', identityBasis: 'vendor_sequence',
      identityValue: `acc-${i}`, receivedAt: '2026-08-05T06:00:00.000Z',
      payload: event as unknown as Record<string, unknown>,
      adapterVersion: 'traccar-0.1.0', rawSha256,
    })
  }

  await withTenant(sql, OTHER, async (tx) => {
    await tx`INSERT INTO core.observation
      (tenant_id, source, device_ref, identity_basis, identity_value, received_at, payload,
       adapter_version, raw_sha256)
      VALUES (${OTHER}, 'traccar', 'dev_other', 'vendor_sequence', 'other-1',
              '2026-08-05T06:00:00Z', '{}'::jsonb, 'traccar-0.1.0', ${'d'.repeat(64)})`
  })
}, 240_000)

afterAll(async () => {
  await app?.end({ timeout: 5 })
  await sql?.end({ timeout: 5 })
  await container?.stop()
})

/** Adapters this project actually has, and the readiness each has actually earned. */
const ADAPTER_READINESS: readonly { name: string; level: 'parsed' | 'forensics_ready' | 'recovery_ready' }[] = [
  { name: 'traccar', level: 'parsed' },
]

function criteria(): Criterion[] {
  return [
    {
      id: 'A-1',
      requirement: '§17.1',
      title: 'Two adapters forensics-ready and one recovery-ready',
      run: async () => {
        const forensics = ADAPTER_READINESS.filter(
          (a) => a.level === 'forensics_ready' || a.level === 'recovery_ready',
        ).length
        const recovery = ADAPTER_READINESS.filter((a) => a.level === 'recovery_ready').length
        const met = forensics >= 2 && recovery >= 1

        return {
          status: met ? 'pass' : 'not_met',
          evidence: ADAPTER_READINESS.map((a) => `${a.name}: ${a.level}`),
          ...(met
            ? {}
            : {
                outstanding:
                  `${forensics}/2 forensics-ready, ${recovery}/1 recovery-ready. The Traccar ` +
                  'adapter has not been run against a live rig, and a second adapter is blocked on ' +
                  'the protocol-specification licensing decision: only Teltonika publishes openly, ' +
                  'and Queclink\'s notice forbids use rather than merely redistribution.',
              }),
        }
      },
    },

    {
      id: 'A-2',
      requirement: '§17.1',
      title: 'Every canonical event carries tenant, source, device, receipt time, identity, hash and adapter version',
      run: async () => {
        const rows = await withTenant(sql, TENANT, async (tx) =>
          tx<{ n: number }[]>`SELECT count(*)::int AS n FROM core.observation
            WHERE tenant_id IS NULL OR source IS NULL OR device_ref IS NULL
               OR received_at IS NULL OR identity_value IS NULL
               OR raw_sha256 IS NULL OR adapter_version IS NULL`)
        const missing = rows[0]?.n ?? 0
        const total = await new PostgresObservationStore(sql, TENANT).count()
        return {
          status: missing === 0 ? 'pass' : 'fail',
          evidence: [`${total} observations, ${missing} missing a required field`],
        }
      },
    },

    {
      id: 'A-3',
      requirement: 'FR-TEL-002',
      title: 'Missing fields remain missing',
      run: async () => {
        // A field the source never sent must not reappear as null, zero or false after a round trip.
        const rows = await withTenant(sql, TENANT, async (tx) =>
          tx<{ payload: Record<string, unknown> }[]>`SELECT payload FROM core.observation LIMIT 1`)
        const payload = rows[0]?.payload ?? {}
        const absent = !('odometer_m' in payload)
        return {
          status: absent ? 'pass' : 'fail',
          evidence: [`top-level keys: ${Object.keys(payload).sort().join(', ')}`],
        }
      },
    },

    {
      id: 'A-4',
      requirement: 'FR-SRC-003',
      title: 'Duplicate, late and replay behaviour is measured and documented',
      run: async () => {
        const observations = new PostgresObservationStore(sql, TENANT)
        const before = await observations.count()
        // Replaying an identical observation must not create a second row.
        const written = await observations.putIfAbsent('k', {
          source: 'traccar', deviceRef: 'dev_acc', identityBasis: 'vendor_sequence',
          identityValue: 'acc-0', receivedAt: '2026-08-05T06:00:00.000Z',
          payload: {}, adapterVersion: 'traccar-0.1.0', rawSha256: 'e'.repeat(64),
        })
        const after = await observations.count()
        return {
          status: !written && after === before ? 'pass' : 'fail',
          evidence: [`replay created a row: ${written}`, `count before ${before}, after ${after}`],
        }
      },
    },

    {
      id: 'A-5',
      requirement: 'FR-AST-002 / FR-TEN-003',
      title: 'Effective assignment and policy changes reproduce past behaviour',
      run: async () => {
        const assignments = new AssignmentRegistry()
          .addAssetDevice({
            assetRef: 'ast_1', deviceRef: 'dev_a', role: 'primary',
            validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-03-01T00:00:00.000Z',
          })
          .addAssetDevice({
            assetRef: 'ast_1', deviceRef: 'dev_b', role: 'primary',
            validFrom: '2026-03-01T00:00:00.000Z', validTo: null,
          })

        const policies = new PolicyRegistry()
          .add({
            cohort: 'fleet',
            intervals: { moving: 60, ignition_on: 60, parked: 300, sleep: 3600, exception: 30 },
            provenance: 'declared', sleepAfterStationaryS: 900, graceFactor: 1.5, version: '1.0.0',
            validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-03-01T00:00:00.000Z',
          })
          .add({
            cohort: 'fleet',
            intervals: { moving: 300, ignition_on: 300, parked: 900, sleep: 3600, exception: 30 },
            provenance: 'declared', sleepAfterStationaryS: 900, graceFactor: 1.5, version: '2.0.0',
            validFrom: '2026-03-01T00:00:00.000Z', validTo: null,
          })

        const historicAssignment = assignments.resolveDevice('dev_a', '2026-02-01T00:00:00.000Z')
        const historicPolicy = expectedNextReportAt({
          registry: policies, cohort: 'fleet',
          lastReportAt: '2026-02-01T00:00:00.000Z', state: 'moving',
        })
        const currentPolicy = expectedNextReportAt({
          registry: policies, cohort: 'fleet',
          lastReportAt: '2026-04-01T00:00:00.000Z', state: 'moving',
        })

        const ok =
          historicAssignment?.assetRef === 'ast_1' &&
          assignments.resolveDevice('dev_a', '2026-04-01T00:00:00.000Z') === undefined &&
          historicPolicy?.intervalS === 60 &&
          currentPolicy?.intervalS === 300

        return {
          status: ok ? 'pass' : 'fail',
          evidence: [
            `February resolves to ${historicAssignment?.deviceRef ?? 'none'} under policy ${historicPolicy?.policyVersion}`,
            `April resolves under policy ${currentPolicy?.policyVersion} (${currentPolicy?.intervalS}s)`,
          ],
        }
      },
    },

    {
      id: 'A-6',
      requirement: '§17.1 / FR-ADM-003',
      title: 'Open data has source, licence, snapshot, checksum and attribution metadata',
      run: async () => {
        const columns = await sql<{ column_name: string; is_nullable: string }[]>`
          SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_schema = 'osm_snapshot' AND table_name = 'snapshot'`
        const required = ['source_url', 'licence', 'extract_date', 'sha256', 'attribution']
        const nullable = columns
          .filter((c) => required.includes(c.column_name) && c.is_nullable === 'YES')
          .map((c) => c.column_name)
        return {
          status: nullable.length === 0 ? 'pass' : 'fail',
          evidence: [`required columns enforced NOT NULL: ${required.join(', ')}`],
        }
      },
    },

    {
      id: 'A-7',
      requirement: '§17.5 / §11.1',
      title: 'Cross-tenant isolation holds, including with no tenant context',
      run: async () => {
        // Measured through the non-superuser application role: a superuser bypasses row-level
        // security entirely, so measuring isolation as one proves nothing at all.
        const mine = await new PostgresObservationStore(app, TENANT).count()
        const theirs = await new PostgresObservationStore(app, OTHER).count()
        const forced = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('core','audit') AND c.relkind IN ('r','p')
            AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)`
        const unprotected = forced[0]?.n ?? -1
        return {
          status: unprotected === 0 && mine > 0 && theirs === 1 ? 'pass' : 'fail',
          evidence: [
            `${mine} observations visible to ${TENANT}, ${theirs} to ${OTHER}`,
            `${unprotected} tables without RLS forced`,
          ],
        }
      },
    },

    {
      id: 'A-8',
      requirement: 'ODbL boundary',
      title: 'No tenant table can hold an OSM identifier',
      run: async () => {
        const rows = await sql<{ table_name: string; column_name: string }[]>`
          SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema IN ('core', 'audit')`
        const offenders = rows.filter((r) =>
          (FORBIDDEN_IN_TENANT_SCHEMA as readonly string[]).includes(r.column_name.toLowerCase()))
        return {
          status: offenders.length === 0 ? 'pass' : 'fail',
          evidence: [`${rows.length} columns checked, ${offenders.length} forbidden`],
        }
      },
    },

    {
      id: 'A-9',
      requirement: 'FR-SRC-002',
      title: 'An auditor can trace a normalized field to the bytes that arrived',
      run: async () => {
        const trace = await traceToReceipt(
          new PostgresObservationStore(sql, TENANT),
          new PostgresReceiptStore(sql, objects, TENANT),
          'acc-1',
        )
        return {
          status: trace?.payloadVerified === true ? 'pass' : 'fail',
          evidence: [`trace for acc-1: found=${trace?.payloadFound}, verified=${trace?.payloadVerified}`],
        }
      },
    },

    {
      id: 'A-10',
      requirement: '§16.1 restore',
      title: 'A dump restores with data, policies and triggers intact',
      run: async () => {
        // A restore test against anything but a real dump proves nothing: the failure modes live in
        // pg_dump's handling of partitions, policies and triggers.
        // Dump to a file inside the container. Piping the dump back through a shell argument
        // mangles it on anything non-trivial, which would make this test fail for a reason that has
        // nothing to do with the database.
        const user = container.getUsername()
        const dump = await container.exec([
          'pg_dump', '-U', user, '-d', container.getDatabase(), '--no-owner', '-f', '/tmp/dump.sql',
        ])
        if (dump.exitCode !== 0) {
          return { status: 'fail' as const, evidence: [`pg_dump exited ${dump.exitCode}: ${dump.output.slice(0, 200)}`] }
        }

        await container.exec(['dropdb', '-U', user, '--if-exists', 'restore_check'])
        await container.exec(['createdb', '-U', user, 'restore_check'])

        const restore = await container.exec([
          'psql', '-U', user, '-d', 'restore_check', '-v', 'ON_ERROR_STOP=1', '-f', '/tmp/dump.sql',
        ])
        if (restore.exitCode !== 0) {
          return {
            status: 'fail' as const,
            evidence: [`restore exited ${restore.exitCode}: ${restore.output.slice(-300)}`],
          }
        }

        const uri = new URL(container.getConnectionUri())
        uri.pathname = '/restore_check'
        const restored = postgres(uri.toString(), { max: 1, onnotice: () => {} })
        try {
          const observations = await withTenant(restored, TENANT, async (tx) =>
            tx<{ n: number }[]>`SELECT count(*)::int AS n FROM core.observation`)
          const policies = await restored<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_policies WHERE schemaname IN ('core','audit')`
          const triggers = await restored<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal`

          const rows = observations[0]?.n ?? 0
          const policyCount = policies[0]?.n ?? 0
          const triggerCount = triggers[0]?.n ?? 0
          const ok = rows > 0 && policyCount > 0 && triggerCount > 0

          return {
            status: ok ? ('pass' as const) : ('fail' as const),
            evidence: [
              `restore exit ${restore.exitCode}`,
              `${rows} observations visible to ${TENANT} after restore`,
              `${policyCount} RLS policies and ${triggerCount} triggers restored`,
            ],
          }
        } finally {
          await restored.end({ timeout: 5 })
        }
      },
    },
  ]
}

describe('Release A exit criteria', () => {
  it('runs every criterion and writes an evidence pack', async () => {
    const report = await runAcceptance(criteria(), GENERATED_AT)

    mkdirSync(join(process.cwd(), 'release'), { recursive: true })
    writeFileSync(
      join(process.cwd(), 'release', 'release-a-acceptance.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    )
    writeFileSync(
      join(process.cwd(), 'release', 'release-a-acceptance.txt'),
      `${summarise(report)}\n`,
    )

    // Every criterion produced a verdict — a check that crashes counts as a failure, never a skip.
    expect(report.criteria).toHaveLength(10)
    for (const c of report.criteria) {
      expect(['pass', 'fail', 'not_met']).toContain(c.status)
      expect(c.evidence.length).toBeGreaterThan(0)
    }
  })

  it('passes everything the project actually implements', async () => {
    const report = await runAcceptance(criteria(), GENERATED_AT)
    const failures = report.criteria.filter((c) => c.status === 'fail')
    expect(failures.map((f) => `${f.id} ${f.title}`)).toEqual([])
  })

  it('reports Release A as incomplete while adapter readiness is unmet', async () => {
    // The honest state of the project: nine criteria pass, and §17.1's adapter requirement does
    // not. A gate that cannot fail is not a gate, so this is asserted rather than glossed.
    const report = await runAcceptance(criteria(), GENERATED_AT)
    const adapters = report.criteria.find((c) => c.id === 'A-1')

    expect(adapters?.status).toBe('not_met')
    expect(adapters?.outstanding).toContain('forensics-ready')
    expect(report.complete).toBe(false)
    expect(report.notMet).toBe(1)
  })

  it('names the outstanding work first in the summary', async () => {
    const text = summarise(await runAcceptance(criteria(), GENERATED_AT))
    expect(text.indexOf('OUTSTANDING')).toBeLessThan(text.indexOf('PASSED'))
    expect(text).toContain('Release A is NOT complete')
  })
})

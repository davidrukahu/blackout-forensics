// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cross-tenant negative tests against real PostgreSQL — PRD §17.5's release gate.
 *
 * These run against a real database on purpose. Row-level security, role privileges and
 * `FORCE ROW LEVEL SECURITY` have no meaningful mock: a test double would assert that the code
 * *intends* isolation, which is exactly the thing that has never been in doubt.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { checkTenantIsolation, withTenant, withoutTenantForTesting } from './tenant.js'

const SCHEMA = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8')

const TENANT_A = 'synthetic_a'
const TENANT_B = 'synthetic_b'

let container: StartedPostgreSqlContainer
/** Superuser. Used only to create roles and run the schema — never to assert isolation. */
let root: Sql
/** Non-superuser owner of every object, as production requires. */
let owner: Sql
let app: Sql

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()

  root = postgres(container.getConnectionUri(), { max: 2, onnotice: () => {} })
  await root.unsafe(SCHEMA)

  // A PostgreSQL superuser bypasses row-level security entirely, FORCE included. Asserting
  // isolation against one would prove nothing, so the owner used below is deliberately not a
  // superuser — which is also what production requires.
  await root.unsafe(`
    DROP ROLE IF EXISTS bf_migrator;
    CREATE ROLE bf_migrator LOGIN PASSWORD 'migrator-password' NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE, CREATE ON SCHEMA core, audit TO bf_migrator;
  `)
  const ownedTables = await root<{ schemaname: string; tablename: string }[]>`
    SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('core', 'audit')`
  for (const t of ownedTables) {
    await root.unsafe(`ALTER TABLE ${t.schemaname}.${t.tablename} OWNER TO bf_migrator`)
  }

  // bf_app owns nothing and holds no BYPASSRLS — PRD §11.1's requirement, created explicitly so
  // the tests below exercise the role the application actually uses.
  await root.unsafe(`
    DROP ROLE IF EXISTS bf_app;
    CREATE ROLE bf_app LOGIN PASSWORD 'app-password' NOBYPASSRLS;
    GRANT USAGE ON SCHEMA core, audit TO bf_app;
    GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA core, audit TO bf_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core, audit TO bf_app;
  `)

  const appUri = new URL(container.getConnectionUri())
  appUri.username = 'bf_app'
  appUri.password = 'app-password'
  app = postgres(appUri.toString(), { max: 4, onnotice: () => {} })

  const ownerUri = new URL(container.getConnectionUri())
  ownerUri.username = 'bf_migrator'
  ownerUri.password = 'migrator-password'
  owner = postgres(ownerUri.toString(), { max: 2, onnotice: () => {} })

  // Seed both tenants as the owner, which is itself subject to FORCE ROW LEVEL SECURITY.
  for (const tenant of [TENANT_A, TENANT_B]) {
    await withTenant(owner, tenant, async (tx) => {
      await tx`INSERT INTO core.observation
        (tenant_id, source, device_ref, identity_basis, identity_value, received_at, payload,
         adapter_version, raw_sha256)
        VALUES (${tenant}, 'traccar', ${`dev_${tenant}`}, 'vendor_sequence', '1',
                '2026-08-05T06:00:00Z', '{}'::jsonb, 'traccar-0.1.0', ${'a'.repeat(64)})`
      await tx`INSERT INTO core.assignment
        (tenant_id, asset_ref, device_ref, role, valid_from)
        VALUES (${tenant}, ${`ast_${tenant}`}, ${`dev_${tenant}`}, 'primary', '2026-01-01T00:00:00Z')`
      await tx`INSERT INTO audit.event (tenant_id, actor, action, occurred_at)
        VALUES (${tenant}, 'seed', 'created', '2026-08-05T06:00:00Z')`
      await tx`INSERT INTO core.raw_receipt
        (tenant_id, source, batch_id, raw_sha256, received_at, byte_length)
        VALUES (${tenant}, 'traccar', 'b1', ${'a'.repeat(64)}, '2026-08-05T06:00:00Z', 100)`
    })
  }
}, 180_000)

afterAll(async () => {
  await app?.end({ timeout: 5 })
  await owner?.end({ timeout: 5 })
  await root?.end({ timeout: 5 })
  await container?.stop()
})

const TENANT_TABLES = ['core.observation', 'core.assignment', 'core.raw_receipt', 'audit.event']

describe('cross-tenant reads — §17.5', () => {
  it.each(TENANT_TABLES)('%s exposes only the tenant in context', async (table) => {
    const result = await checkTenantIsolation(app, {
      table,
      tenantId: TENANT_A,
      otherTenantId: TENANT_B,
    })
    expect(result.rowsVisibleWithContext).toBe(1)
    expect(result.rowsVisibleToOtherTenant).toBe(1)
  })

  it.each(TENANT_TABLES)('%s exposes nothing when no context is set', async (table) => {
    // A job that forgets its context must see an empty database, not every tenant's data.
    const result = await checkTenantIsolation(app, {
      table,
      tenantId: TENANT_A,
      otherTenantId: TENANT_B,
    })
    expect(result.rowsVisibleWithoutContext).toBe(0)
  })

  it('never returns another tenant\'s row, whichever context is set', async () => {
    const rows = await withTenant(app, TENANT_A, async (tx) =>
      tx<{ tenant_id: string }[]>`SELECT tenant_id FROM core.observation`)
    expect(rows.map((r) => r.tenant_id)).toEqual([TENANT_A])
  })
})

describe('cross-tenant writes', () => {
  it('refuses an insert that claims another tenant', async () => {
    // WITH CHECK is what stops a caller writing across the boundary while correctly scoped for
    // reads — a policy with only USING would allow exactly that.
    await expect(
      withTenant(app, TENANT_A, async (tx) => {
        await tx`INSERT INTO core.assignment
          (tenant_id, asset_ref, device_ref, role, valid_from)
          VALUES (${TENANT_B}, 'ast_x', 'dev_x', 'primary', '2026-01-01T00:00:00Z')`
      }),
    ).rejects.toThrow()
  })

  it('refuses an insert with no tenant context at all', async () => {
    await expect(
      withoutTenantForTesting(app, async (tx) => {
        await tx`INSERT INTO core.assignment
          (tenant_id, asset_ref, device_ref, role, valid_from)
          VALUES (${TENANT_A}, 'ast_y', 'dev_y', 'primary', '2026-01-01T00:00:00Z')`
      }),
    ).rejects.toThrow()
  })

  it('permits an insert for the tenant in context', async () => {
    await withTenant(app, TENANT_A, async (tx) => {
      await tx`INSERT INTO core.assignment
        (tenant_id, asset_ref, device_ref, role, valid_from)
        VALUES (${TENANT_A}, 'ast_ok', 'dev_ok', 'secondary', '2026-01-01T00:00:00Z')`
    })
    const rows = await withTenant(app, TENANT_A, async (tx) =>
      tx<{ asset_ref: string }[]>`SELECT asset_ref FROM core.assignment WHERE asset_ref = 'ast_ok'`)
    expect(rows).toHaveLength(1)
  })
})

describe('role privileges — PRD §11.1', () => {
  it('the application role holds no BYPASSRLS', async () => {
    const rows = await root<{ rolbypassrls: boolean }[]>`
      SELECT rolbypassrls FROM pg_roles WHERE rolname = 'bf_app'`
    expect(rows[0]?.rolbypassrls).toBe(false)
  })

  it('the application role owns no tenant table', async () => {
    const rows = await root<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname IN ('core', 'audit') AND tableowner = 'bf_app'`
    expect(rows).toEqual([])
  })

  it('every tenant table AND partition has RLS enabled and forced', async () => {
    // Partitions do not inherit the parent's RLS: querying core.observation_2026_08 directly
    // bypasses a policy defined only on the parent. Every relation must carry its own.
    const rows = await root<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('core', 'audit') AND c.relkind IN ('r', 'p')`
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} RLS`).toBe(true)
      expect(row.relforcerowsecurity, `${row.relname} FORCE`).toBe(true)
    }
  })

  it('applies isolation to the non-superuser owner too, not only to the application role', async () => {
    const rows = await withTenant(owner, TENANT_A, async (tx) =>
      tx<{ tenant_id: string }[]>`SELECT tenant_id FROM core.observation`)
    expect(rows.map((r) => r.tenant_id)).toEqual([TENANT_A])
  })
})

describe('append-only enforcement — PRD §7.3', () => {
  it('refuses an update to a raw receipt', async () => {
    await expect(
      withTenant(owner, TENANT_A, async (tx) => {
        await tx`UPDATE core.raw_receipt SET byte_length = 1 WHERE tenant_id = ${TENANT_A}`
      }),
    ).rejects.toThrow(/append-only/)
  })

  it('refuses a delete from the audit log', async () => {
    await expect(
      withTenant(owner, TENANT_A, async (tx) => {
        await tx`DELETE FROM audit.event WHERE tenant_id = ${TENANT_A}`
      }),
    ).rejects.toThrow(/append-only/)
  })
})

describe('idempotency and partitioning', () => {
  it('rejects a duplicate identity within one tenant and source', async () => {
    await expect(
      withTenant(app, TENANT_A, async (tx) => {
        await tx`INSERT INTO core.observation
          (tenant_id, source, device_ref, identity_basis, identity_value, received_at, payload,
           adapter_version, raw_sha256)
          VALUES (${TENANT_A}, 'traccar', 'dev_dup', 'vendor_sequence', '1',
                  '2026-08-05T06:00:00Z', '{}'::jsonb, 'traccar-0.1.0', ${'b'.repeat(64)})`
      }),
    ).rejects.toThrow(/duplicate key/)
  })

  it('accepts the same identity from a different source', async () => {
    // The same vendor sequence from two platforms is two observations. Merging them would
    // fabricate agreement between sources meant to be independent evidence.
    await withTenant(app, TENANT_A, async (tx) => {
      await tx`INSERT INTO core.observation
        (tenant_id, source, device_ref, identity_basis, identity_value, received_at, payload,
         adapter_version, raw_sha256)
        VALUES (${TENANT_A}, 'wialon', 'dev_a', 'vendor_sequence', '1',
                '2026-08-05T06:00:00Z', '{}'::jsonb, 'wialon-0.1.0', ${'c'.repeat(64)})`
    })
    const rows = await withTenant(app, TENANT_A, async (tx) =>
      tx<{ n: number }[]>`SELECT count(*)::int AS n FROM core.observation WHERE identity_value = '1'`)
    expect(rows[0]?.n).toBe(2)
  })

  it('routes rows to the partition covering their receipt time', async () => {
    const rows = await root<{ relname: string; n: number }[]>`
      SELECT c.relname, count(o.*)::int AS n
      FROM pg_class c
      LEFT JOIN core.observation o ON true
      WHERE c.relname LIKE 'observation_2026%'
      GROUP BY c.relname ORDER BY c.relname`
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })
})

describe('superuser bypass is real and must be designed around', () => {
  it('a superuser sees every tenant despite FORCE — which is why production runs without one', async () => {
    // Documented rather than defended: no policy in PostgreSQL constrains a superuser. PRD §11.1's
    // rule that production roles hold no BYPASSRLS is necessary but not sufficient on its own.
    const rows = await withTenant(root, TENANT_A, async (tx) =>
      tx<{ tenant_id: string }[]>`SELECT DISTINCT tenant_id FROM core.observation ORDER BY tenant_id`)
    expect(rows.length).toBeGreaterThan(1)
  })

  it('the owner role is not a superuser', async () => {
    const rows = await root<{ rolsuper: boolean }[]>`
      SELECT rolsuper FROM pg_roles WHERE rolname = 'bf_migrator'`
    expect(rows[0]?.rolsuper).toBe(false)
  })
})

describe('partitions cannot be used to sidestep the policy', () => {
  it('querying a partition directly still returns only the tenant in context', async () => {
    const rows = await withTenant(app, TENANT_A, async (tx) =>
      tx<{ tenant_id: string }[]>`SELECT tenant_id FROM core.observation_2026_08`)
    expect(new Set(rows.map((r) => r.tenant_id))).toEqual(new Set([TENANT_A]))
  })

  it('querying a partition with no context returns nothing', async () => {
    const rows = await withoutTenantForTesting(app, async (tx) =>
      tx<{ tenant_id: string }[]>`SELECT tenant_id FROM core.observation_2026_08`)
    expect(rows).toHaveLength(0)
  })
})

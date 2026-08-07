// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Postgres-backed implementations of the ingestion ports.
 *
 * The in-memory stores are the reference semantics; these must reproduce them exactly, against a
 * database that also enforces tenant isolation. Two contracts matter here and are both tested:
 *
 *   * **At-least-once ingestion, never exactly-once** (FR-EPI-005). No distributed source can
 *     promise exactly-once. What this achieves is *effectively once* for the same source event —
 *     a different, weaker, and actually keepable guarantee.
 *   * **Every attempt is recorded** (FR-SRC-003). One hundred replays of one payload yield one
 *     observation and one hundred receipts. Collapsing the receipts would erase the evidence that a
 *     source is resending, which is itself a diagnostic signal.
 */

import type { Sql } from 'postgres'

import { nextVersionFor, type ObservationVersion } from '../normalize/normalizer.js'
import type { ObjectStore } from './object-store.js'
import { withTenant } from './tenant.js'

export interface StoredReceipt {
  readonly rawSha256: string
  readonly source: string
  readonly tenantId: string
  readonly receivedAt: string
  readonly byteLength: number
  readonly batchId: string
}

export interface StoredQuarantine {
  readonly code: string
  readonly rowNumber: number
  readonly rowSha256: string
  readonly fieldPaths: readonly string[]
}

/**
 * Append-only receipt store.
 *
 * The payload goes to object storage keyed by its own hash; the row holds the reference plus the
 * evidence needed to prove the payload was not altered. An UPDATE or DELETE is refused by trigger,
 * not by convention.
 */
export class PostgresReceiptStore {
  constructor(
    private readonly sql: Sql,
    private readonly objects: ObjectStore,
    private readonly tenantId: string,
  ) {}

  async append(receipt: StoredReceipt, payload?: Buffer | string): Promise<void> {
    // Store bytes first. If the database write then fails, an orphaned object is harmless; a
    // receipt row pointing at bytes that were never stored is not.
    const objectKey = payload === undefined ? null : await this.objects.put(payload)

    await withTenant(this.sql, this.tenantId, async (tx) => {
      await tx`INSERT INTO core.raw_receipt
        (tenant_id, source, batch_id, raw_sha256, received_at, byte_length, object_key)
        VALUES (${receipt.tenantId}, ${receipt.source}, ${receipt.batchId}, ${receipt.rawSha256},
                ${receipt.receivedAt}, ${receipt.byteLength}, ${objectKey})`
    })
  }

  async count(): Promise<number> {
    return withTenant(this.sql, this.tenantId, async (tx) => {
      const rows = await tx`SELECT count(*)::int AS n FROM core.raw_receipt`
      return (rows[0] as unknown as { n: number }).n
    })
  }

  /**
   * Fetch the payload behind a receipt, verified.
   *
   * This is the auditor's path: from a normalized field, to its observation, to the receipt hash,
   * to the exact bytes that arrived. Verification is not optional on the way back.
   */
  async payloadFor(rawSha256: string): Promise<Buffer | undefined> {
    const exists = await withTenant(this.sql, this.tenantId, async (tx) => {
      const rows = await tx`SELECT object_key FROM core.raw_receipt
        WHERE raw_sha256 = ${rawSha256} AND object_key IS NOT NULL LIMIT 1`
      return (rows[0] as unknown as { object_key: string } | undefined)?.object_key
    })
    if (exists === undefined) return undefined
    return this.objects.get(exists)
  }
}

/** Canonical observations, first write wins. */
export class PostgresObservationStore {
  constructor(
    private readonly sql: Sql,
    private readonly tenantId: string,
  ) {}

  /**
   * Insert unless the idempotency key is already present.
   *
   * `ON CONFLICT DO NOTHING` on the unique index, so concurrency is resolved by the database rather
   * than by a read-then-write race. Two workers replaying the same batch cannot both win.
   */
  async putIfAbsent(
    key: string,
    observation: {
      source: string
      deviceRef: string
      assetRef?: string | null
      identityBasis: string
      identityValue: string
      receivedAt: string
      vendorReceivedAt?: string | null
      deviceTime?: string | null
      payload: unknown
      adapterVersion: string
      rawSha256: string
      version?: number
    },
  ): Promise<boolean> {
    void key
    return withTenant(this.sql, this.tenantId, async (tx) => {
      const rows = await tx`INSERT INTO core.observation
        (tenant_id, source, device_ref, asset_ref, identity_basis, identity_value, received_at,
         vendor_received_at, device_time, payload, adapter_version, raw_sha256, version)
        VALUES (${this.tenantId}, ${observation.source}, ${observation.deviceRef},
                ${observation.assetRef ?? null}, ${observation.identityBasis},
                ${observation.identityValue}, ${observation.receivedAt},
                ${observation.vendorReceivedAt ?? null}, ${observation.deviceTime ?? null},
                ${tx.json(observation.payload as never)}, ${observation.adapterVersion},
                ${observation.rawSha256}, ${observation.version ?? 1})
        ON CONFLICT (tenant_id, source, identity_basis, identity_value, received_at, version) DO NOTHING
        RETURNING id`
      return rows.length > 0
    })
  }

  async count(): Promise<number> {
    return withTenant(this.sql, this.tenantId, async (tx) => {
      const rows = await tx`SELECT count(*)::int AS n FROM core.observation`
      return (rows[0] as unknown as { n: number }).n
    })
  }

  /**
   * Every version of one observation, oldest first.
   *
   * Versions accumulate rather than replace: an episode classified from version 1 must stay
   * reproducible from version 1 (FR-TEL-007).
   */
  async versionsOf(identityValue: string): Promise<ObservationVersion[]> {
    return withTenant(this.sql, this.tenantId, async (tx) => {
      const rows = await tx`SELECT version, adapter_version, raw_sha256, payload, superseded
        FROM core.observation WHERE identity_value = ${identityValue} ORDER BY version`
      return (rows as unknown as {
        version: number; adapter_version: string; raw_sha256: string
        payload: Record<string, unknown>; superseded: boolean
      }[]).map((r) => ({
        version: r.version,
        adapterVersion: r.adapter_version,
        rawSha256: r.raw_sha256,
        payload: r.payload,
        superseded: r.superseded,
      }))
    })
  }

  /** The receipt hash behind an observation — the first hop of an audit trace. */
  async receiptHashFor(identityValue: string): Promise<string | undefined> {
    return withTenant(this.sql, this.tenantId, async (tx) => {
      const rows = await tx`SELECT raw_sha256 FROM core.observation
        WHERE identity_value = ${identityValue} LIMIT 1`
      return (rows[0] as unknown as { raw_sha256: string } | undefined)?.raw_sha256
    })
  }
}

export class PostgresQuarantineStore {
  constructor(
    private readonly sql: Sql,
    private readonly tenantId: string,
    private readonly context: { source: string; batchId: string; receivedAt: string },
  ) {}

  async append(row: StoredQuarantine): Promise<void> {
    await withTenant(this.sql, this.tenantId, async (tx) => {
      await tx`INSERT INTO core.quarantine
        (tenant_id, source, batch_id, code, row_number, row_sha256, field_paths, received_at)
        VALUES (${this.tenantId}, ${this.context.source}, ${this.context.batchId}, ${row.code},
                ${row.rowNumber}, ${row.rowSha256}, ${[...row.fieldPaths]},
                ${this.context.receivedAt})`
    })
  }

  async list(): Promise<StoredQuarantine[]> {
    return withTenant(this.sql, this.tenantId, async (tx) => {
      const rows = await tx`SELECT code, row_number, row_sha256, field_paths
        FROM core.quarantine ORDER BY id`
      return (rows as unknown as {
        code: string; row_number: number; row_sha256: string; field_paths: string[]
      }[]).map((r) => ({
        code: r.code,
        rowNumber: r.row_number,
        rowSha256: r.row_sha256,
        fieldPaths: r.field_paths,
      }))
    })
  }
}

export interface AuditTrace {
  readonly identityValue: string
  readonly rawSha256: string
  readonly payloadFound: boolean
  readonly payloadVerified: boolean
}

/**
 * Trace a normalized observation back to the exact bytes that arrived.
 *
 * This is the acceptance criterion for the whole ingestion path (FR-SRC-002), expressed as a
 * function so it can be run as a check rather than argued about in a design review.
 */
export async function traceToReceipt(
  observations: PostgresObservationStore,
  receipts: PostgresReceiptStore,
  identityValue: string,
): Promise<AuditTrace | undefined> {
  const rawSha256 = await observations.receiptHashFor(identityValue)
  if (rawSha256 === undefined) return undefined

  let payloadFound = false
  let payloadVerified = false
  try {
    const payload = await receipts.payloadFor(rawSha256)
    payloadFound = payload !== undefined
    // get() verifies before returning, so reaching here at all means the bytes hash correctly.
    payloadVerified = payloadFound
  } catch {
    payloadFound = true
    payloadVerified = false
  }

  return { identityValue, rawSha256, payloadFound, payloadVerified }
}

export interface RedecodeOutcome {
  readonly created: boolean
  readonly version?: number
  readonly reason?: 'already_decoded_by_this_adapter' | 'receipt_not_found' | 'decode_failed'
}

/**
 * Re-decode an existing receipt with a newer adapter, as a new version.
 *
 * The original is never touched. Re-running the *same* adapter version is refused: a replay is not
 * a second opinion, and a version that says nothing new is noise in an evidence record.
 */
export async function redecode(
  observations: PostgresObservationStore,
  receipts: PostgresReceiptStore,
  params: {
    identityValue: string
    adapterVersion: string
    decode: (payload: Buffer) => Record<string, unknown>
    source: string
    deviceRef: string
    receivedAt: string
  },
): Promise<RedecodeOutcome> {
  const existing = await observations.versionsOf(params.identityValue)
  if (existing.length === 0) return { created: false, reason: 'receipt_not_found' }

  const version = nextVersionFor(existing, params.adapterVersion)
  if (version === undefined) return { created: false, reason: 'already_decoded_by_this_adapter' }

  const rawSha256 = existing[0]!.rawSha256
  const payload = await receipts.payloadFor(rawSha256)
  if (payload === undefined) return { created: false, reason: 'receipt_not_found' }

  let decoded: Record<string, unknown>
  try {
    decoded = params.decode(payload)
  } catch {
    return { created: false, reason: 'decode_failed' }
  }

  const created = await observations.putIfAbsent('redecode', {
    source: params.source,
    deviceRef: params.deviceRef,
    identityBasis: 'vendor_sequence',
    identityValue: params.identityValue,
    receivedAt: params.receivedAt,
    payload: decoded,
    adapterVersion: params.adapterVersion,
    rawSha256,
    version,
  })

  return created ? { created: true, version } : { created: false, reason: 'already_decoded_by_this_adapter' }
}

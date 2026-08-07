// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: Apache-2.0

/**
 * Batch import: receipts in, canonical observations out, bad rows quarantined.
 *
 * The contract this implements, and the reason each part exists:
 *
 *  - Ingestion is **at-least-once**, never exactly-once (FR-EPI-005). Claiming exactly-once would be
 *    a promise no distributed source can keep. Idempotency makes it *effectively* once for the same
 *    source event, which is a different and achievable guarantee.
 *  - Replaying an identical payload 100 times yields one observation and 100 receipt attempts
 *    (FR-SRC-003). Both halves matter: collapsing the receipts would erase evidence that the source
 *    resent, which is itself a diagnostic signal.
 *  - A malformed row is quarantined without blocking valid rows from the same file (FR-SRC-005).
 *
 * Storage is behind ports so the Postgres-backed implementation can land with its own task without
 * this logic changing.
 */

import { validateCanonicalEvent } from '@blackout/spec'

import {
  createReceipt,
  deriveIdentity,
  idempotencyKey,
  sha256Hex,
  type RawReceipt,
} from './receipt.js'
import {
  quarantine,
  type QuarantineCode,
  type QuarantinedRow,
} from './quarantine.js'
import {
  formatFromFilename,
  readCsv,
  readNdjson,
  readParquet,
  type BatchFormat,
  type CandidateRow,
} from './readers.js'

/** Append-only store of what arrived. Every attempt is recorded, including duplicates. */
export interface ReceiptStore {
  append(receipt: RawReceipt): Promise<void>
  count(): Promise<number>
}

/** Canonical observations, keyed by idempotency key. First write wins; later ones are duplicates. */
export interface ObservationStore {
  /** Returns false when the key already exists, without overwriting. */
  putIfAbsent(key: string, observation: Record<string, unknown>): Promise<boolean>
  count(): Promise<number>
  get(key: string): Promise<Record<string, unknown> | undefined>
}

export interface QuarantineStore {
  append(row: QuarantinedRow): Promise<void>
  list(): Promise<readonly QuarantinedRow[]>
}

export interface ImportStores {
  readonly receipts: ReceiptStore
  readonly observations: ObservationStore
  readonly quarantine: QuarantineStore
}

export interface ImportOptions {
  readonly tenantId: string
  readonly source: string
  readonly batchId: string
  /** Supplied by the caller, never read from the clock — replays must be reproducible. */
  readonly receivedAt: string
  readonly format?: BatchFormat
  readonly filename?: string
  readonly verificationHeaders?: Record<string, string>
  /** Rows larger than this are quarantined rather than parsed. Defends the parser, not the disk. */
  readonly maxRowBytes?: number
}

export interface ImportResult {
  readonly batchId: string
  readonly rowsRead: number
  /** Observations written for the first time. */
  readonly accepted: number
  /** Rows that resolved to an already-known idempotency key. */
  readonly duplicates: number
  readonly quarantined: number
  /** Receipts appended — one per attempt, including duplicates. */
  readonly receipts: number
}

const DEFAULT_MAX_ROW_BYTES = 256 * 1024

function parseErrorToCode(parseError: NonNullable<CandidateRow['parseError']>): QuarantineCode {
  return parseError
}

/**
 * Import one batch payload.
 *
 * `payload` is the file's bytes for ndjson/csv, or a filesystem path for parquet — hyparquet needs
 * random access to the footer, so a Parquet file cannot be streamed as a string.
 */
export async function importBatch(
  payload: string,
  stores: ImportStores,
  options: ImportOptions,
): Promise<ImportResult> {
  const format =
    options.format ?? (options.filename !== undefined ? formatFromFilename(options.filename) : null)

  if (format === null) {
    throw new Error('cannot determine batch format: pass options.format or a recognised filename')
  }

  const maxRowBytes = options.maxRowBytes ?? DEFAULT_MAX_ROW_BYTES

  // The receipt covers the whole payload, hashed before anything interprets it. For Parquet the
  // payload is a path, so the file's own bytes are hashed by the reader step instead.
  const batchReceipt: RawReceipt = createReceipt({
    payload: format === 'parquet' ? options.filename ?? payload : payload,
    source: options.source,
    tenantId: options.tenantId,
    receivedAt: options.receivedAt,
    batchId: options.batchId,
    ...(options.verificationHeaders !== undefined
      ? { verificationHeaders: options.verificationHeaders }
      : {}),
  })
  await stores.receipts.append(batchReceipt)

  const rows: CandidateRow[] =
    format === 'ndjson'
      ? readNdjson(payload)
      : format === 'csv'
        ? readCsv(payload)
        : await readParquet(payload)

  let accepted = 0
  let duplicates = 0
  let quarantined = 0
  let receipts = 1

  for (const row of rows) {
    if (row.parseError !== null) {
      await stores.quarantine.append(
        quarantine({
          code: parseErrorToCode(row.parseError),
          rowNumber: row.rowNumber,
          rowSha256: row.rowSha256,
        }),
      )
      quarantined += 1
      continue
    }

    const value = row.value as Record<string, unknown>

    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxRowBytes) {
      await stores.quarantine.append(
        quarantine({ code: 'ROW_TOO_LARGE', rowNumber: row.rowNumber, rowSha256: row.rowSha256 }),
      )
      quarantined += 1
      continue
    }

    // A row claiming another tenant is a hard failure, not a normalization problem. The
    // authenticated context supplies the tenant; a body field cannot override it (PRD §10.5).
    if (typeof value['tenant_id'] === 'string' && value['tenant_id'] !== options.tenantId) {
      await stores.quarantine.append(
        quarantine({
          code: 'TENANT_MISMATCH',
          rowNumber: row.rowNumber,
          rowSha256: row.rowSha256,
          fieldPaths: ['/tenant_id'],
        }),
      )
      quarantined += 1
      continue
    }

    const validation = validateCanonicalEvent(value)
    if (!validation.valid) {
      await stores.quarantine.append(
        quarantine({
          code: 'SCHEMA_VALIDATION_FAILED',
          rowNumber: row.rowNumber,
          rowSha256: row.rowSha256,
          // Paths only. The values that failed are never copied into a diagnostic.
          fieldPaths: validation.errors.map((e) => e.path),
        }),
      )
      quarantined += 1
      continue
    }

    const identityField = value['event_identity'] as
      | { basis?: string; value?: string; algorithm?: string }
      | undefined

    // Trust the adapter's declared identity when it supplied one; derive otherwise. Deriving over
    // the top of a vendor id would discard the stronger basis.
    const identity =
      identityField?.basis !== undefined && identityField.value !== undefined
        ? {
            basis: identityField.basis as 'vendor_event_id' | 'vendor_sequence' | 'synthesised',
            value: identityField.value,
            ...(identityField.algorithm !== undefined ? { algorithm: identityField.algorithm } : {}),
          }
        : deriveIdentity({
            tenantId: options.tenantId,
            source: options.source,
            deviceRef: String(value['device_ref'] ?? ''),
            deviceTime: (value['device_time'] as string | null | undefined) ?? null,
            payloadHash: row.rowSha256,
          })

    const key = idempotencyKey(options.tenantId, options.source, identity)

    // Every row gets a receipt, including duplicates: the fact that a source resent is evidence,
    // and collapsing it would hide a misbehaving integration.
    await stores.receipts.append(
      createReceipt({
        payload: JSON.stringify(value),
        source: options.source,
        tenantId: options.tenantId,
        receivedAt: options.receivedAt,
        batchId: options.batchId,
      }),
    )
    receipts += 1

    const written = await stores.observations.putIfAbsent(key, {
      ...value,
      event_identity: identity,
      quality: {
        ...(value['quality'] as Record<string, unknown>),
        raw_sha256: (value['quality'] as { raw_sha256?: string })?.raw_sha256 ?? sha256Hex(JSON.stringify(value)),
      },
    })

    if (written) accepted += 1
    else duplicates += 1
  }

  return {
    batchId: options.batchId,
    rowsRead: rows.length,
    accepted,
    duplicates,
    quarantined,
    receipts,
  }
}

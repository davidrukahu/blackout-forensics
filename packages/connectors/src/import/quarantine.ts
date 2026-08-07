// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: Apache-2.0

/**
 * Safe rejection reasons.
 *
 * FR-SRC-005 requires parse failures to be quarantined without blocking valid rows from the same
 * source, and PRD §10.5 requires rejection codes to be structured and safe: they must never include
 * coordinates, raw packets, IMSI, ICCID or borrower data.
 *
 * That second rule is the reason this module exists rather than the obvious `catch (e) { return
 * e.message }`. An error message that echoes the offending row leaks precisely the data the whole
 * architecture is designed not to hold, into logs and diagnostic queues where it is least controlled.
 */

export type QuarantineCode =
  | 'MALFORMED_JSON'
  | 'MALFORMED_CSV_ROW'
  | 'MALFORMED_PARQUET'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'MISSING_REQUIRED_FIELD'
  | 'UNKNOWN_COLUMN'
  | 'UNPARSEABLE_TIMESTAMP'
  | 'TENANT_MISMATCH'
  | 'ROW_TOO_LARGE'
  | 'UNSUPPORTED_FORMAT'

export interface QuarantinedRow {
  readonly code: QuarantineCode
  /** 1-based row number within the file, so an operator can locate it in their own source. */
  readonly rowNumber: number
  /**
   * Field paths that failed, without their values. "/position/lat is invalid" is safe;
   * "/position/lat was -1.2864" is a coordinate leak.
   */
  readonly fieldPaths: readonly string[]
  /** Hash of the offending row, so it can be matched to the retained raw payload without echoing it. */
  readonly rowSha256: string
}

/** Field names whose values must never appear in a diagnostic message. */
const SENSITIVE_HINTS = [
  'lat', 'lon', 'latitude', 'longitude', 'imsi', 'iccid', 'imei', 'msisdn', 'phone',
  'name', 'address', 'plate', 'vin', 'borrower', 'raw', 'payload',
]

/**
 * Assert a diagnostic string carries no sensitive value.
 *
 * Used in tests and as a runtime guard on anything bound for a diagnostic queue. It errs towards
 * false positives: a message that merely mentions "latitude" is refused, because the cost of a
 * blocked diagnostic is trivial next to the cost of a leaked coordinate.
 */
export function isSafeDiagnostic(text: string): boolean {
  const lowered = text.toLowerCase()
  if (SENSITIVE_HINTS.some((hint) => lowered.includes(`${hint}=`) || lowered.includes(`"${hint}":`))) {
    return false
  }
  // Bare coordinate pairs, e.g. "-1.2864, 36.8172".
  if (/-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/.test(text)) return false
  // Long digit runs: IMEI (15), ICCID (19-20), MSISDN (11-15).
  if (/\d{11,}/.test(text)) return false
  return true
}

export function quarantine(params: {
  code: QuarantineCode
  rowNumber: number
  rowSha256: string
  fieldPaths?: readonly string[]
}): QuarantinedRow {
  return {
    code: params.code,
    rowNumber: params.rowNumber,
    rowSha256: params.rowSha256,
    fieldPaths: Object.freeze([...(params.fieldPaths ?? [])]),
  }
}

/** Human-readable, still safe. Suitable for a diagnostic queue shown to a data administrator. */
export function describeQuarantine(row: QuarantinedRow): string {
  const where = row.fieldPaths.length > 0 ? ` at ${row.fieldPaths.join(', ')}` : ''
  return `row ${row.rowNumber}: ${row.code}${where} (row hash ${row.rowSha256.slice(0, 12)})`
}

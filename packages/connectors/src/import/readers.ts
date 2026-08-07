// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: Apache-2.0

/**
 * Row readers for the three batch formats FR-SRC-001 requires.
 *
 * A reader's only job is to turn bytes into candidate rows plus the row's own hash. It never
 * validates, never normalizes and never throws on a bad row — a single malformed row must not stop
 * the file (FR-SRC-005).
 */

import { asyncBufferFromFile, parquetQuery } from 'hyparquet'

import { sha256Hex } from './receipt.js'

export interface CandidateRow {
  /** 1-based within the file. */
  readonly rowNumber: number
  readonly rowSha256: string
  /** Parsed object, or null when the row could not be parsed at all. */
  readonly value: Record<string, unknown> | null
  readonly parseError: 'MALFORMED_JSON' | 'MALFORMED_CSV_ROW' | 'MALFORMED_PARQUET' | null
}

export function readNdjson(text: string): CandidateRow[] {
  const rows: CandidateRow[] = []
  let rowNumber = 0

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    rowNumber += 1
    const rowSha256 = sha256Hex(trimmed)
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        rows.push({ rowNumber, rowSha256, value: null, parseError: 'MALFORMED_JSON' })
      } else {
        rows.push({ rowNumber, rowSha256, value: parsed as Record<string, unknown>, parseError: null })
      }
    } catch {
      rows.push({ rowNumber, rowSha256, value: null, parseError: 'MALFORMED_JSON' })
    }
  }
  return rows
}

/**
 * Split a CSV line, honouring quoted fields and doubled quotes.
 *
 * Deliberately not a general CSV library: vendor exports vary, and a dependency that silently
 * coerces types would defeat FR-TEL-001. Returns null when quoting is unbalanced.
 */
export function splitCsvLine(line: string): string[] | null {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (inQuotes) return null
  fields.push(current)
  return fields
}

/**
 * Read CSV into flat rows.
 *
 * Values stay strings. Nothing is coerced here — an empty cell becomes `undefined` (absent), never
 * an empty string, zero or false, because those are different states (FR-TEL-002). Interpretation
 * belongs to the adapter, which knows what the vendor means.
 */
export function readCsv(text: string): CandidateRow[] {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  const headerLine = lines[0]
  if (headerLine === undefined) return []

  const headers = splitCsvLine(headerLine)
  if (headers === null) return []

  const rows: CandidateRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string
    const rowNumber = i
    const rowSha256 = sha256Hex(line)
    const fields = splitCsvLine(line)

    if (fields === null || fields.length !== headers.length) {
      rows.push({ rowNumber, rowSha256, value: null, parseError: 'MALFORMED_CSV_ROW' })
      continue
    }

    const value: Record<string, unknown> = {}
    headers.forEach((header, index) => {
      const raw = fields[index] ?? ''
      // Absent stays absent. Only an explicit "null" means reported-as-unknown.
      if (raw === '') return
      value[header] = raw === 'null' ? null : raw
    })
    rows.push({ rowNumber, rowSha256, value, parseError: null })
  }
  return rows
}

export async function readParquet(filePath: string): Promise<CandidateRow[]> {
  try {
    const file = await asyncBufferFromFile(filePath)
    const records = (await parquetQuery({ file })) as Record<string, unknown>[]
    return records.map((record, index) => ({
      rowNumber: index + 1,
      rowSha256: sha256Hex(JSON.stringify(record)),
      value: record,
      parseError: null,
    }))
  } catch {
    // A corrupt footer or unsupported encoding fails the whole file — unlike CSV and NDJSON,
    // Parquet cannot be read row-wise past a structural error.
    return [{ rowNumber: 1, rowSha256: '', value: null, parseError: 'MALFORMED_PARQUET' }]
  }
}

export type BatchFormat = 'ndjson' | 'csv' | 'parquet'

export function formatFromFilename(filename: string): BatchFormat | null {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.ndjson') || lower.endsWith('.jsonl')) return 'ndjson'
  if (lower.endsWith('.csv')) return 'csv'
  if (lower.endsWith('.parquet')) return 'parquet'
  return null
}

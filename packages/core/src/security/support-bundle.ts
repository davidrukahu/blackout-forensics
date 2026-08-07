// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Safe support bundles and log redaction — §17.5, FR-ADM-005.
 *
 * The claim to prove is negative: exact location and personal identifiers never appear in logs,
 * metrics or support bundles. Negative claims need two layers here:
 *
 *   * **Allowlist construction.** A support bundle is built from named diagnostic fields —
 *     versions, counts, health, timings. Nothing outside the list can enter, so a new field
 *     leaking is a code review question, not a runtime accident.
 *   * **Pattern scan on the way out.** The serialized bundle (and any log line routed through
 *     `safeLogLine`) is scanned for coordinate pairs, phone numbers, IMEIs and emails. The scan
 *     catches what the allowlist cannot: a "safe" count field that someone stuffed a device
 *     position into. Detection throws — a support bundle that might leak does not exist.
 */

export interface LeakFinding {
  readonly kind: 'coordinates' | 'msisdn' | 'imei' | 'email' | 'lat_lon_field'
  readonly excerpt: string
}

// Nairobi is around (-1.3, 36.8): realistic coordinates have 4+ decimals. Two such numbers near
// each other, or an explicit lat/lon key, is treated as a position regardless of intent.
const COORDINATE_PAIR = /-?\d{1,3}\.\d{4,}\s*[,;]\s*-?\d{1,3}\.\d{4,}/
const LAT_LON_FIELD = /"(lat|latitude|lon|lng|longitude)"\s*:\s*-?\d{1,3}\.\d{3,}/i
const MSISDN = /(?:\+?254|0)7\d{8}/
const IMEI = /\b\d{15}\b/
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/

export function scanForSensitive(text: string): LeakFinding[] {
  const findings: LeakFinding[] = []
  const push = (kind: LeakFinding['kind'], match: RegExpExecArray | null): void => {
    if (match !== null) findings.push({ kind, excerpt: match[0].slice(0, 40) })
  }
  push('coordinates', COORDINATE_PAIR.exec(text))
  push('lat_lon_field', LAT_LON_FIELD.exec(text))
  push('msisdn', MSISDN.exec(text))
  push('imei', IMEI.exec(text))
  push('email', EMAIL.exec(text))
  return findings
}

export class LeakDetectedError extends Error {
  constructor(readonly findings: readonly LeakFinding[]) {
    super(
      `refusing to emit: ${findings.map((f) => f.kind).join(', ')} detected. A support bundle ` +
        'that might leak does not exist (§17.5).',
    )
    this.name = 'LeakDetectedError'
  }
}

/** The whole safe-bundle vocabulary. A field not named here cannot enter a bundle. */
export const SAFE_SUPPORT_FIELDS = [
  'app_version',
  'schema_version',
  'rule_version',
  'fact_vocabulary_version',
  'node_version',
  'uptime_s',
  'tenant_count',
  'episode_counts_by_state',
  'queue_depth',
  'ingest_rate_per_s',
  'quarantine_count',
  'last_backup_at',
  'backup_health',
  'db_pool_in_use',
  'memory_rss_mb',
  'errors_last_24h',
] as const
export type SafeSupportField = (typeof SAFE_SUPPORT_FIELDS)[number]

export interface SupportBundle {
  readonly generatedAt: string
  readonly fields: Partial<Record<SafeSupportField, unknown>>
}

export function buildSupportBundle(
  diagnostics: Record<string, unknown>,
  generatedAt: string,
): SupportBundle {
  const fields: Partial<Record<SafeSupportField, unknown>> = {}
  for (const field of SAFE_SUPPORT_FIELDS) {
    if (field in diagnostics) fields[field] = diagnostics[field]
  }

  const bundle: SupportBundle = { generatedAt, fields }
  const findings = scanForSensitive(JSON.stringify(bundle))
  if (findings.length > 0) throw new LeakDetectedError(findings)
  return bundle
}

/**
 * Route log lines through this and positions cannot reach the log: sensitive matches are
 * replaced field-by-field, and the redaction is visible — a log that silently dropped a line
 * would hide the very bug that put the position there.
 */
export function safeLogLine(line: string): string {
  let out = line
  for (const pattern of [COORDINATE_PAIR, LAT_LON_FIELD, MSISDN, IMEI, EMAIL]) {
    const global = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`)
    out = out.replace(global, '[REDACTED]')
  }
  return out
}

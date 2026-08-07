// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The redaction guard.
 *
 * The entire delivery model turns on one property of the findings bundle: it must be **anonymous**,
 * not merely pseudonymised. Kenya's Data Protection Act defines a processor by processing on behalf
 * of a controller, so a vendor that never touches raw telemetry is probably outside it — but a
 * vendor that receives pseudonymised personal data receives it for its own purposes and becomes a
 * **controller**, which is strictly worse than being a processor and carries no instruction defence.
 *
 * Kenya publishes no k-anonymity number, no minimum cohort size and no spatial resolution. The
 * standard is outcome-based, and reg 35(d) imposes a positive duty to *test* that re-identification
 * is impossible. So the thresholds below are **Modeled**, they ship inside the bundle manifest with
 * their reasoning, and the test is part of the product rather than a review step.
 *
 * Everything here fails closed. A bundle that cannot be proven safe is not emitted.
 */

/** Finest permitted H3 resolution. Res 6 averages ~36 km² — a city district, not a street. */
export const MAX_H3_RESOLUTION = 6

/**
 * Minimum distinct devices behind any published row.
 *
 * Modeled. Chosen above the commonly cited k=5 because movement data is unusually re-identifiable:
 * a single home-to-work pattern is close to unique, so a cohort that would be adequate for, say,
 * age bands is not adequate here.
 */
export const MIN_COHORT_SIZE = 25

/** Coarsest permitted time bucket. Hourly is the finest; daily is the default. */
export const MIN_TIME_BUCKET_S = 3600

export type RedactionViolationCode =
  | 'COORDINATE_PRESENT'
  | 'H3_TOO_FINE'
  | 'COHORT_BELOW_FLOOR'
  | 'IDENTIFIER_PRESENT'
  | 'TIME_BUCKET_TOO_FINE'
  | 'FIELD_NOT_ALLOWLISTED'
  | 'ROW_LEVEL_DATA'

export interface RedactionViolation {
  readonly code: RedactionViolationCode
  /** Where in the bundle, as a path. Never the offending value. */
  readonly path: string
  readonly detail: string
}

/**
 * Fields permitted in a bundle. Anything else is refused.
 *
 * An allow-list rather than a deny-list, because a deny-list fails open: the field nobody thought of
 * is exactly the one that leaks.
 */
export const BUNDLE_FIELD_ALLOWLIST: readonly string[] = [
  // Manifest
  'bundle_version', 'generated_at', 'container_version', 'analyser_versions', 'tenant_label',
  'source_labels', 'period_start', 'period_end', 'thresholds', 'reasoning', 'content_hashes',
  // Cohort keys — labels only, never identifiers
  'vendor', 'model', 'firmware', 'source', 'day', 'hour_bucket', 'h3_cell', 'h3_resolution',
  // Measures
  'denominator', 'numerator', 'excluded', 'exclusion_reasons', 'device_count', 'observation_count',
  'count', 'p50', 'p95', 'p99', 'min', 'max',
  'field_group', 'completeness', 'platform_lag_s', 'total_lag_s', 'device_to_vendor_lag_s',
  'duplicate_rate', 'out_of_order_rate', 'backfill_rate', 'impossible_value_counts',
  'episode_type', 'episode_count', 'duration_s', 'suppressed_count', 'weak_basis_count',
  'devices_with_episodes', 'devices_observed', 'assignment_coverage', 'unmapped_device_count',
  'destructive_settings', 'retention_findings', 'blocking_findings',
  'setting', 'effect', 'enabled', 'default_enabled', 'raw_days', 'customer_reducible', 'sufficient',
]

const COORDINATE_KEYS = ['lat', 'lon', 'latitude', 'longitude', 'coordinates', 'position', 'geometry']
const IDENTIFIER_KEYS = [
  'device_ref', 'asset_ref', 'sim_ref', 'imei', 'iccid', 'imsi', 'msisdn', 'phone', 'serial',
  'plate', 'vin', 'borrower', 'name', 'address', 'event_id', 'event_identity', 'raw_sha256',
]

/**
 * Parents whose immediate children are dictionary keys chosen at runtime — analyser names,
 * exclusion reasons, section names — rather than field names from a fixed vocabulary. The
 * allow-list cannot govern them, but the keys themselves are still scanned, because a dictionary
 * keyed on a device reference would leak just as effectively as a field named after one.
 */
const OPAQUE_KEY_PARENTS = [
  'analyser_versions', 'content_hashes', 'thresholds', 'exclusion_reasons',
  'impossible_value_counts',
]

/** A decimal that looks like a coordinate: 4+ decimal places is ~11 m or better. */
const COORDINATE_LIKE = /^-?\d{1,3}\.\d{4,}$/
/** IMEI (15), ICCID (19–20), MSISDN (11–15). */
const LONG_IDENTIFIER = /^\d{11,}$/

function walk(
  value: unknown,
  path: string,
  visit: (v: unknown, p: string, key: string | null) => void,
  key: string | null = null,
): void {
  visit(value, path, key)
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}/${i}`, visit, null))
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walk(v, `${path}/${k}`, visit, k)
  }
}

/**
 * Prove a bundle carries nothing that could re-identify a person or a vehicle.
 *
 * This is the reg 35(d) test, run inside the container before anything is written.
 */
export function checkRedaction(bundle: unknown): RedactionViolation[] {
  const violations: RedactionViolation[] = []

  walk(bundle, '', (value, path, key) => {
    if (key !== null) {
      const lowered = key.toLowerCase()

      if (COORDINATE_KEYS.includes(lowered)) {
        violations.push({
          code: 'COORDINATE_PRESENT',
          path,
          detail: `field "${key}" carries position data; bundles publish H3 cells only`,
        })
      }

      if (IDENTIFIER_KEYS.includes(lowered)) {
        violations.push({
          code: 'IDENTIFIER_PRESENT',
          path,
          detail:
            `field "${key}" is a device, asset or subscriber identifier. A tenant-keyed pseudonym ` +
            'is still a re-identifier in the customer\'s hands, which is what would make this ' +
            'bundle personal data.',
        })
      }

      if (lowered === 'h3_resolution' && typeof value === 'number' && value > MAX_H3_RESOLUTION) {
        violations.push({
          code: 'H3_TOO_FINE',
          path,
          detail: `resolution ${value} exceeds the permitted maximum of ${MAX_H3_RESOLUTION}`,
        })
      }

      if (lowered === 'device_count' && typeof value === 'number' && value > 0 && value < MIN_COHORT_SIZE) {
        violations.push({
          code: 'COHORT_BELOW_FLOOR',
          path,
          detail: `row covers ${value} devices, below the floor of ${MIN_COHORT_SIZE}`,
        })
      }

      // Structural keys carry no data: the two containers, and the section names the caller
      // chooses. The allow-list governs the field names *inside* a section, which is where a value
      // could actually leak.
      const segments = path.split('/').filter(Boolean)
      const depth = segments.length
      const parent = segments[depth - 2] ?? ''
      const structural =
        (depth === 1 && (lowered === 'manifest' || lowered === 'sections')) ||
        (depth === 2 && path.startsWith('/sections/')) ||
        OPAQUE_KEY_PARENTS.includes(parent)

      // A dictionary key is not governed by the allow-list, but it is still a string that could
      // itself be an identifier.
      if (OPAQUE_KEY_PARENTS.includes(parent)) {
        if (COORDINATE_LIKE.test(key)) {
          violations.push({ code: 'COORDINATE_PRESENT', path, detail: 'dictionary key looks like a coordinate' })
        }
        if (LONG_IDENTIFIER.test(key)) {
          violations.push({ code: 'IDENTIFIER_PRESENT', path, detail: 'dictionary key looks like an identifier' })
        }
      }

      if (!structural && !BUNDLE_FIELD_ALLOWLIST.includes(key) && Number.isNaN(Number(key))) {
        violations.push({
          code: 'FIELD_NOT_ALLOWLISTED',
          path,
          detail: `field "${key}" is not on the bundle allow-list`,
        })
      }
    }

    if (typeof value === 'string') {
      if (COORDINATE_LIKE.test(value)) {
        violations.push({ code: 'COORDINATE_PRESENT', path, detail: 'value looks like a coordinate' })
      }
      if (LONG_IDENTIFIER.test(value)) {
        violations.push({ code: 'IDENTIFIER_PRESENT', path, detail: 'value looks like an IMEI, ICCID or MSISDN' })
      }
    }

    // A raw number with sub-degree precision in the coordinate range is the other way a position
    // leaks: not as a labelled field, but as an unlabelled value in an array.
    if (typeof value === 'number' && key === null && Number.isFinite(value)) {
      const abs = Math.abs(value)
      const decimals = String(value).split('.')[1]?.length ?? 0
      if (abs > 0 && abs <= 180 && decimals >= 4) {
        violations.push({
          code: 'COORDINATE_PRESENT',
          path,
          detail: 'unlabelled numeric value has coordinate-like precision',
        })
      }
    }
  })

  return violations
}

/** Coarsen a fix to a publishable H3 cell. Never returns a finer resolution than permitted. */
export function coarsenToCell(
  lat: number,
  lon: number,
  resolution: number,
  latLngToCell: (lat: number, lng: number, res: number) => string,
): { h3_cell: string; h3_resolution: number } {
  const res = Math.min(resolution, MAX_H3_RESOLUTION)
  return { h3_cell: latLngToCell(lat, lon, res), h3_resolution: res }
}

/** Drop rows below the cohort floor rather than rounding them — suppression, not approximation. */
export function suppressSmallCohorts<T extends { device_count: number }>(
  rows: readonly T[],
): { published: T[]; suppressed: number } {
  const published = rows.filter((r) => r.device_count >= MIN_COHORT_SIZE)
  return { published, suppressed: rows.length - published.length }
}

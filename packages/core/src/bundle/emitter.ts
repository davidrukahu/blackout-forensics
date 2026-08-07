// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Findings bundle emitter.
 *
 * Builds the only artefact that leaves the customer's environment, proves it is safe, and refuses to
 * emit anything it cannot prove. The customer sees a complete contents listing and approves it
 * before release — they see everything that would leave, before it leaves.
 */

import { createHash } from 'node:crypto'

import {
  MAX_H3_RESOLUTION,
  MIN_COHORT_SIZE,
  MIN_TIME_BUCKET_S,
  checkRedaction,
  suppressSmallCohorts,
  type RedactionViolation,
} from './redaction.js'

export const BUNDLE_VERSION = '0.1.0'

export interface BundleThresholds {
  readonly max_h3_resolution: number
  readonly min_cohort_size: number
  readonly min_time_bucket_s: number
}

export interface BundleManifest {
  readonly bundle_version: string
  readonly generated_at: string
  readonly container_version: string
  readonly analyser_versions: Readonly<Record<string, string>>
  /** A label the customer chooses, never a tenant identifier from the fact store. */
  readonly tenant_label: string
  readonly source_labels: readonly string[]
  readonly period_start: string
  readonly period_end: string
  readonly thresholds: BundleThresholds
  /**
   * Why these thresholds. Kenya publishes none, so the reasoning ships with the bundle and must be
   * defensible to a Data Protection Officer rather than merely implemented.
   */
  readonly reasoning: readonly string[]
  readonly content_hashes: Readonly<Record<string, string>>
}

export interface FindingsBundle {
  readonly manifest: BundleManifest
  readonly sections: Readonly<Record<string, unknown>>
}

export interface EmitResult {
  readonly ok: boolean
  readonly bundle?: FindingsBundle
  readonly violations: readonly RedactionViolation[]
  /** Everything the customer will see listed before approving release. */
  readonly contentsListing: readonly string[]
  readonly suppressedRows: number
}

const DEFAULT_REASONING: readonly string[] = [
  'Kenya\'s Data Protection Act sets an outcome-based standard: it publishes no k-anonymity value, ' +
    'no minimum cohort size and no spatial resolution. These thresholds are therefore modeled, not ' +
    'derived from published guidance, and are stated here so they can be argued with.',
  `H3 resolution ${MAX_H3_RESOLUTION} averages roughly 36 km² — a city district rather than a ` +
    'street. Finer cells would begin to describe individual routes.',
  `A cohort floor of ${MIN_COHORT_SIZE} devices sits above the commonly cited k=5 because movement ` +
    'data is unusually re-identifiable: a single home-to-work pattern is close to unique, so a ' +
    'cohort adequate for age bands is not adequate here.',
  'No row-level records, no coordinates at any precision, and no device, SIM or asset identifiers — ' +
    'not even pseudonymous ones. A tenant-keyed pseudonym remains a re-identifier in the ' +
    'customer\'s hands, which is precisely what would make this bundle personal data and the ' +
    'recipient a controller.',
  'Rows below the cohort floor are suppressed rather than rounded. Rounding a small cohort ' +
    'preserves its existence, which is itself disclosive.',
]

function hashSection(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * Build and verify a bundle.
 *
 * Fails closed: if the redaction check finds anything, no bundle is returned. There is no override,
 * because the situation where someone wants one is exactly the situation where the check is right.
 */
export function emitBundle(params: {
  tenantLabel: string
  sourceLabels: readonly string[]
  periodStart: string
  periodEnd: string
  generatedAt: string
  containerVersion: string
  analyserVersions: Record<string, string>
  sections: Record<string, unknown>
  reasoning?: readonly string[]
}): EmitResult {
  // Suppress small cohorts before anything else, so the redaction check sees what would ship.
  let suppressedRows = 0
  const sections: Record<string, unknown> = {}

  for (const [name, section] of Object.entries(params.sections)) {
    if (Array.isArray(section) && section.every((r) => typeof r === 'object' && r !== null && 'device_count' in r)) {
      const { published, suppressed } = suppressSmallCohorts(
        section as { device_count: number }[],
      )
      sections[name] = published
      suppressedRows += suppressed
    } else {
      sections[name] = section
    }
  }

  const manifest: BundleManifest = {
    bundle_version: BUNDLE_VERSION,
    generated_at: params.generatedAt,
    container_version: params.containerVersion,
    analyser_versions: { ...params.analyserVersions },
    tenant_label: params.tenantLabel,
    source_labels: [...params.sourceLabels],
    period_start: params.periodStart,
    period_end: params.periodEnd,
    thresholds: {
      max_h3_resolution: MAX_H3_RESOLUTION,
      min_cohort_size: MIN_COHORT_SIZE,
      min_time_bucket_s: MIN_TIME_BUCKET_S,
    },
    reasoning: params.reasoning ?? DEFAULT_REASONING,
    content_hashes: Object.fromEntries(
      Object.entries(sections).map(([name, value]) => [name, hashSection(value)]),
    ),
  }

  const bundle: FindingsBundle = { manifest, sections }
  const violations = checkRedaction(bundle)

  const contentsListing = [
    `manifest — bundle ${BUNDLE_VERSION}, generated ${params.generatedAt}`,
    `period — ${params.periodStart} to ${params.periodEnd}`,
    `thresholds — H3 res ≤ ${MAX_H3_RESOLUTION}, cohort ≥ ${MIN_COHORT_SIZE} devices`,
    ...Object.entries(sections).map(([name, value]) => {
      const rows = Array.isArray(value) ? value.length : 1
      return `${name} — ${rows} row${rows === 1 ? '' : 's'}, sha256 ${manifest.content_hashes[name]?.slice(0, 12)}`
    }),
    suppressedRows > 0
      ? `${suppressedRows} row(s) suppressed for falling below the cohort floor`
      : 'no rows suppressed',
  ]

  if (violations.length > 0) {
    return { ok: false, violations, contentsListing, suppressedRows }
  }

  return { ok: true, bundle, violations: [], contentsListing, suppressedRows }
}

/** Serialize an approved bundle. Re-checks first — approval is not a bypass. */
export function serializeBundle(bundle: FindingsBundle): string {
  const violations = checkRedaction(bundle)
  if (violations.length > 0) {
    throw new Error(
      `refusing to serialize: ${violations.length} redaction violation(s), first at ${violations[0]?.path}`,
    )
  }
  return JSON.stringify(bundle, null, 2)
}

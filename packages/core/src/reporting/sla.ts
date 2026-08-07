// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SLA, quality and value reporting — PRD §6.12.
 *
 * Two separations carry the section. Telemetry SLA (did the tracker and platform deliver?) and
 * internal recovery SLA (did we review and act in time?) are different questions answered from
 * different denominators, and the report type keeps them in different objects so no heading can
 * blend them (FR-RPT-001). And no corridor or peer pattern may be called a *carrier* SLA without
 * the carrier's identity and contract in hand (FR-RPT-002) — enforced as a language check over
 * the rendered report, because the failure mode is a label, not a number.
 *
 * Every metric definition is versioned data (FR-RPT-004), every report carries the FR-RPT-003
 * manifest with an integrity hash over its own canonical serialization, and cohort comparisons
 * are suppressed or marked insufficient below the sample floor (FR-RPT-005) — a small cohort is
 * an anecdote wearing a percentage.
 */

import { createHash } from 'node:crypto'

import { percentiles, type Denominated } from '../analysers/distribution.js'

export const METRIC_DEFINITIONS_VERSION = '1.0.0'

/** FR-RPT-004: the metric set, defined as data so definitions version with the report. */
export const METRIC_DEFINITIONS: readonly {
  readonly id: string
  readonly definition: string
}[] = [
  { id: 'delivery_lag_p50_s', definition: 'nearest-rank p50 of received_at - device_time, seconds, over accepted events' },
  { id: 'delivery_lag_p95_s', definition: 'nearest-rank p95 of received_at - device_time, seconds, over accepted events' },
  { id: 'episodes_per_1000_asset_hours', definition: 'opened episodes x 1000 / active asset-hours in window' },
  { id: 'episode_duration_p50_s', definition: 'nearest-rank p50 of closed episode durations, seconds' },
  { id: 'episode_duration_p95_s', definition: 'nearest-rank p95 of closed episode durations, seconds' },
  { id: 'backfill_completeness', definition: 'late-arriving records accepted / expected during gaps (Denominated)' },
  { id: 'repeated_episode_rate', definition: 'devices with >1 episode in window / devices with >=1 episode (Denominated)' },
  { id: 'unresolved_aging_open', definition: 'count of unresolved cases by age bucket, reported separately (FR-OUT-004)' },
  { id: 'retraction_rate', definition: 'retracted episodes / opened episodes in window (Denominated)' },
  { id: 'time_to_review_p50_s', definition: 'nearest-rank p50 of first-review-at - opened-at, seconds (recovery SLA)' },
  { id: 'time_to_action_p95_s', definition: 'nearest-rank p95 of action-start - opened-at, seconds (recovery SLA)' },
] as const

export interface TelemetrySla {
  readonly deliveryLagP50S: number | null
  readonly deliveryLagP95S: number | null
  readonly episodesPer1000AssetHours: number | null
  readonly episodeDurationP50S: number | null
  readonly episodeDurationP95S: number | null
  readonly backfillCompleteness: Denominated
  readonly repeatedEpisodeRate: Denominated
  readonly retractionRate: Denominated
}

export interface RecoverySla {
  readonly timeToReviewP50S: number | null
  readonly timeToActionP95S: number | null
  readonly unresolvedAging: readonly { readonly bucket: string; readonly count: number }[]
}

/** FR-RPT-003: the mandatory manifest. A report without one does not exist. */
export interface ReportManifest {
  readonly reportId: string
  readonly generatedAt: string
  readonly window: { readonly from: string; readonly to: string }
  readonly denominators: Readonly<Record<string, number>>
  readonly exclusions: readonly { readonly reason: string; readonly count: number }[]
  readonly clockBasis: 'device_time' | 'received_at' | 'mixed'
  readonly completeness: Denominated
  readonly ruleVersion: string
  readonly factVocabularyVersion: string
  readonly mapSnapshotId: string | null
  readonly metricDefinitionsVersion: string
  /** sha256 over the canonical report body; verified on every reproduction. */
  readonly integritySha256: string
}

export interface CohortComparison {
  readonly dimension: 'vendor' | 'model' | 'firmware' | 'installer' | 'sim'
  readonly key: string
  readonly sampleSize: number
  readonly status: 'reported' | 'insufficient'
  /** Present only when the floor is met. */
  readonly episodesPer1000AssetHours?: number
}

export interface SlaReport {
  readonly telemetry: TelemetrySla
  readonly recovery: RecoverySla
  readonly cohorts: readonly CohortComparison[]
  readonly manifest: ReportManifest
}

export const COHORT_SAMPLE_FLOOR = 8

export interface SlaReportInput {
  readonly reportId: string
  readonly generatedAt: string
  readonly window: { readonly from: string; readonly to: string }
  readonly deliveryLagsS: readonly number[]
  readonly episodeDurationsS: readonly number[]
  readonly openedEpisodes: number
  readonly retractedEpisodes: number
  readonly activeAssetHours: number
  readonly devicesWithEpisodes: number
  readonly devicesWithRepeats: number
  readonly backfill: Denominated
  readonly completeness: Denominated
  readonly exclusions: readonly { readonly reason: string; readonly count: number }[]
  readonly clockBasis: 'device_time' | 'received_at' | 'mixed'
  readonly ruleVersion: string
  readonly factVocabularyVersion: string
  readonly mapSnapshotId: string | null
  readonly timeToReviewS: readonly number[]
  readonly timeToActionS: readonly number[]
  readonly unresolvedAging: readonly { readonly bucket: string; readonly count: number }[]
  readonly cohorts: readonly {
    readonly dimension: CohortComparison['dimension']
    readonly key: string
    readonly sampleSize: number
    readonly episodes: number
    readonly assetHours: number
  }[]
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function buildSlaReport(input: SlaReportInput): SlaReport {
  const lag = percentiles([...input.deliveryLagsS])
  const duration = percentiles([...input.episodeDurationsS])
  const review = percentiles([...input.timeToReviewS])
  const action = percentiles([...input.timeToActionS])

  const telemetry: TelemetrySla = {
    deliveryLagP50S: lag.p50,
    deliveryLagP95S: lag.p95,
    episodesPer1000AssetHours:
      input.activeAssetHours === 0 ? null : (input.openedEpisodes * 1000) / input.activeAssetHours,
    episodeDurationP50S: duration.p50,
    episodeDurationP95S: duration.p95,
    backfillCompleteness: input.backfill,
    repeatedEpisodeRate: {
      denominator: input.devicesWithEpisodes,
      numerator: input.devicesWithRepeats,
      excluded: 0,
      exclusionReasons: {},
    },
    retractionRate: {
      denominator: input.openedEpisodes,
      numerator: input.retractedEpisodes,
      excluded: 0,
      exclusionReasons: {},
    },
  }

  const recovery: RecoverySla = {
    timeToReviewP50S: review.p50,
    timeToActionP95S: action.p95,
    unresolvedAging: input.unresolvedAging,
  }

  // FR-RPT-005: below the floor, the comparison is marked insufficient and carries no rate at
  // all — a suppressed number cannot be quoted.
  const cohorts: CohortComparison[] = input.cohorts.map((cohort) =>
    cohort.sampleSize < COHORT_SAMPLE_FLOOR
      ? {
          dimension: cohort.dimension,
          key: cohort.key,
          sampleSize: cohort.sampleSize,
          status: 'insufficient',
        }
      : {
          dimension: cohort.dimension,
          key: cohort.key,
          sampleSize: cohort.sampleSize,
          status: 'reported',
          episodesPer1000AssetHours:
            cohort.assetHours === 0 ? 0 : (cohort.episodes * 1000) / cohort.assetHours,
        },
  )

  const body = { telemetry, recovery, cohorts }
  const manifest: ReportManifest = {
    reportId: input.reportId,
    generatedAt: input.generatedAt,
    window: input.window,
    denominators: {
      accepted_events: input.deliveryLagsS.length,
      opened_episodes: input.openedEpisodes,
      active_asset_hours: input.activeAssetHours,
      devices_with_episodes: input.devicesWithEpisodes,
    },
    exclusions: input.exclusions,
    clockBasis: input.clockBasis,
    completeness: input.completeness,
    ruleVersion: input.ruleVersion,
    factVocabularyVersion: input.factVocabularyVersion,
    mapSnapshotId: input.mapSnapshotId,
    metricDefinitionsVersion: METRIC_DEFINITIONS_VERSION,
    integritySha256: sha256Canonical(body),
  }

  return { ...body, manifest }
}

/** Re-derive the hash from the body; a reproduced report must match its manifest. */
export function verifyReportIntegrity(report: SlaReport): boolean {
  return (
    sha256Canonical({
      telemetry: report.telemetry,
      recovery: report.recovery,
      cohorts: report.cohorts,
    }) === report.manifest.integritySha256
  )
}

// ------------------------------------------------------------------ FR-RPT-002: language guard

export class UnsupportedCarrierClaimError extends Error {
  constructor(readonly phrase: string) {
    super(
      `"${phrase}" labels a pattern as a carrier SLA without the carrier identity and contract ` +
        '(FR-RPT-002). A corridor or peer pattern is evidence about coverage, not a contract breach.',
    )
    this.name = 'UnsupportedCarrierClaimError'
  }
}

const CARRIER_SLA_PATTERN = /carrier\s+sla|carrier\s+breach|network\s+operator\s+sla/i

export function assertCarrierClaimSupported(
  text: string,
  support?: { readonly carrierIdentity: string; readonly contractRef: string },
): void {
  const match = CARRIER_SLA_PATTERN.exec(text)
  if (match !== null && support === undefined) {
    throw new UnsupportedCarrierClaimError(match[0])
  }
}

// ------------------------------------------------------------------ FR-RPT-007: exports

/** Deterministic CSV: one metric per row, definitions version in the header. */
export function reportToCsv(report: SlaReport): string {
  const esc = (v: string): string => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)
  const rows: string[][] = [
    ['section', 'metric', 'value', 'denominator'],
    ['manifest', 'report_id', report.manifest.reportId, ''],
    ['manifest', 'metric_definitions_version', report.manifest.metricDefinitionsVersion, ''],
    ['manifest', 'integrity_sha256', report.manifest.integritySha256, ''],
    ['manifest', 'clock_basis', report.manifest.clockBasis, ''],
    ['manifest', 'rule_version', report.manifest.ruleVersion, ''],
    ['telemetry', 'delivery_lag_p50_s', String(report.telemetry.deliveryLagP50S ?? ''), String(report.manifest.denominators['accepted_events'])],
    ['telemetry', 'delivery_lag_p95_s', String(report.telemetry.deliveryLagP95S ?? ''), String(report.manifest.denominators['accepted_events'])],
    ['telemetry', 'episodes_per_1000_asset_hours', String(report.telemetry.episodesPer1000AssetHours ?? ''), String(report.manifest.denominators['active_asset_hours'])],
    ['telemetry', 'retraction_rate', `${report.telemetry.retractionRate.numerator}/${report.telemetry.retractionRate.denominator}`, String(report.telemetry.retractionRate.denominator)],
    ['recovery', 'time_to_review_p50_s', String(report.recovery.timeToReviewP50S ?? ''), ''],
    ['recovery', 'time_to_action_p95_s', String(report.recovery.timeToActionP95S ?? ''), ''],
    ...report.cohorts.map((cohort) => [
      'cohort',
      `${cohort.dimension}:${cohort.key}`,
      cohort.status === 'insufficient'
        ? 'insufficient sample'
        : String(cohort.episodesPer1000AssetHours),
      String(cohort.sampleSize),
    ]),
    ...report.recovery.unresolvedAging.map((aging) => [
      'recovery', `unresolved_${aging.bucket}`, String(aging.count), '',
    ]),
  ]
  return rows.map((row) => row.map(esc).join(',')).join('\n')
}

export interface SignedReport {
  readonly payload: string
  readonly sha256: string
  readonly signature: string
  readonly signedAt: string
  readonly keyId: string
}

/**
 * Signed JSON evidence export. The signer is injected — production uses the release key held by
 * the operator; tests use a throwaway — and verification needs only the public key.
 */
export function signReport(
  report: SlaReport,
  signer: { readonly keyId: string; sign(payload: Buffer): Buffer },
  signedAt: string,
): SignedReport {
  const payload = JSON.stringify(report)
  return {
    payload,
    sha256: createHash('sha256').update(payload).digest('hex'),
    signature: signer.sign(Buffer.from(payload)).toString('base64'),
    signedAt,
    keyId: signer.keyId,
  }
}

export function verifySignedReport(
  signed: SignedReport,
  verify: (payload: Buffer, signature: Buffer) => boolean,
): { readonly intact: boolean; readonly report: SlaReport | null } {
  const hashOk = createHash('sha256').update(signed.payload).digest('hex') === signed.sha256
  const signatureOk = verify(Buffer.from(signed.payload), Buffer.from(signed.signature, 'base64'))
  if (!hashOk || !signatureOk) return { intact: false, report: null }
  const report = JSON.parse(signed.payload) as SlaReport
  return { intact: verifyReportIntegrity(report), report }
}

/**
 * Minimal deterministic PDF (FR-RPT-007): one page of report lines, byte-stable for a given
 * report so the export hash reproduces. Deliberately dependency-free — a PDF library that
 * embeds timestamps would break reproducibility for typography.
 */
export function reportToPdf(report: SlaReport): Buffer {
  const lines = [
    `Blackout Forensics SLA report ${report.manifest.reportId}`,
    `Window ${report.manifest.window.from} to ${report.manifest.window.to} (${report.manifest.clockBasis})`,
    `Integrity sha256 ${report.manifest.integritySha256}`,
    '',
    'TELEMETRY SLA (tracker and platform delivery)',
    `  delivery lag p50/p95: ${report.telemetry.deliveryLagP50S ?? 'n/a'} / ${report.telemetry.deliveryLagP95S ?? 'n/a'} s`,
    `  episodes per 1000 asset-hours: ${report.telemetry.episodesPer1000AssetHours?.toFixed(3) ?? 'n/a'}`,
    `  retractions: ${report.telemetry.retractionRate.numerator}/${report.telemetry.retractionRate.denominator}`,
    '',
    'INTERNAL RECOVERY SLA (review and action)',
    `  time to review p50: ${report.recovery.timeToReviewP50S ?? 'n/a'} s`,
    `  time to action p95: ${report.recovery.timeToActionP95S ?? 'n/a'} s`,
    '',
    'COHORTS (floor-gated)',
    ...report.cohorts.map((cohort) =>
      `  ${cohort.dimension}:${cohort.key} n=${cohort.sampleSize} ${
        cohort.status === 'insufficient'
          ? 'insufficient sample'
          : (cohort.episodesPer1000AssetHours as number).toFixed(3)
      }`,
    ),
  ]

  const escapePdf = (line: string): string =>
    line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
  const content = [
    'BT', '/F1 10 Tf', '12 TL', '40 800 Td',
    ...lines.map((line) => `(${escapePdf(line)}) Tj T*`),
    'ET',
  ].join('\n')

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ]

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefAt = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * §6.12: separated SLAs, the mandatory manifest, floor-gated cohorts, language guard, and
 * exports whose hashes reproduce (§17.4's done-condition for reports).
 */

import { generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  COHORT_SAMPLE_FLOOR,
  METRIC_DEFINITIONS,
  UnsupportedCarrierClaimError,
  assertCarrierClaimSupported,
  buildSlaReport,
  reportToCsv,
  reportToPdf,
  signReport,
  verifyReportIntegrity,
  verifySignedReport,
  type SlaReportInput,
} from './sla.js'

const INPUT: SlaReportInput = {
  reportId: 'rpt-2026-08',
  generatedAt: '2026-08-08T00:00:00.000Z',
  window: { from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' },
  deliveryLagsS: [2, 3, 3, 4, 5, 6, 8, 9, 12, 40],
  episodeDurationsS: [600, 1200, 5400],
  openedEpisodes: 4,
  retractedEpisodes: 1,
  activeAssetHours: 8000,
  devicesWithEpisodes: 3,
  devicesWithRepeats: 1,
  backfill: { denominator: 20, numerator: 18, excluded: 2, exclusionReasons: { quarantined: 2 } },
  completeness: { denominator: 100, numerator: 97, excluded: 3, exclusionReasons: { quarantined: 3 } },
  exclusions: [{ reason: 'maintenance window (FR-POL-004)', count: 1 }],
  clockBasis: 'device_time',
  ruleVersion: '1.1.0',
  factVocabularyVersion: '1.0.0',
  mapSnapshotId: null,
  timeToReviewS: [1800, 3600, 9000],
  timeToActionS: [7200, 90000],
  unresolvedAging: [{ bucket: '7d', count: 1 }, { bucket: '30d', count: 0 }],
  cohorts: [
    { dimension: 'vendor', key: 'teltonika', sampleSize: 12, episodes: 3, assetHours: 6000 },
    { dimension: 'model', key: 'GV75', sampleSize: 3, episodes: 2, assetHours: 900 },
  ],
}

describe('FR-RPT-001: the two SLAs never share an object', () => {
  it('telemetry and recovery metrics live under separate headings with separate denominators', () => {
    const report = buildSlaReport(INPUT)
    expect(report.telemetry.deliveryLagP95S).toBe(40)
    expect(report.recovery.timeToActionP95S).toBe(90000)
    expect(Object.keys(report.telemetry)).not.toContain('timeToReviewP50S')
    expect(Object.keys(report.recovery)).not.toContain('deliveryLagP50S')
  })
})

describe('FR-RPT-003: the manifest', () => {
  it('carries denominator, exclusions, clock basis, completeness, rule version, snapshot and hash', () => {
    const { manifest } = buildSlaReport(INPUT)
    expect(manifest.denominators['accepted_events']).toBe(10)
    expect(manifest.exclusions[0]!.reason).toContain('maintenance')
    expect(manifest.clockBasis).toBe('device_time')
    expect(manifest.completeness.numerator).toBe(97)
    expect(manifest.ruleVersion).toBe('1.1.0')
    expect(manifest.mapSnapshotId).toBeNull()
    expect(manifest.integritySha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('§17.4: content and manifest hash reproduce; tampering is detected', () => {
    const a = buildSlaReport(INPUT)
    const b = buildSlaReport(INPUT)
    expect(a).toEqual(b)
    expect(verifyReportIntegrity(a)).toBe(true)
    const tampered = {
      ...a,
      telemetry: { ...a.telemetry, deliveryLagP95S: 5 },
    }
    expect(verifyReportIntegrity(tampered)).toBe(false)
  })
})

describe('FR-RPT-004: the metric set is versioned data', () => {
  it('defines every §6.12 metric', () => {
    const ids = METRIC_DEFINITIONS.map((m) => m.id)
    for (const required of [
      'delivery_lag_p50_s', 'delivery_lag_p95_s', 'episodes_per_1000_asset_hours',
      'backfill_completeness', 'repeated_episode_rate', 'unresolved_aging_open', 'retraction_rate',
    ]) {
      expect(ids).toContain(required)
    }
  })
})

describe('FR-RPT-005: cohort floors', () => {
  it('reports the big cohort, marks the small one insufficient with no rate to quote', () => {
    const report = buildSlaReport(INPUT)
    const vendor = report.cohorts.find((c) => c.key === 'teltonika')!
    const model = report.cohorts.find((c) => c.key === 'GV75')!
    expect(vendor.status).toBe('reported')
    expect(vendor.episodesPer1000AssetHours).toBe(0.5)
    expect(model.status).toBe('insufficient')
    expect(model).not.toHaveProperty('episodesPer1000AssetHours')
    expect(model.sampleSize).toBeLessThan(COHORT_SAMPLE_FLOOR)
  })
})

describe('FR-RPT-002: carrier-SLA language', () => {
  it('rejects the label without identity and contract; passes with both or without the claim', () => {
    expect(() => assertCarrierClaimSupported('corridor pattern suggests a carrier SLA breach'))
      .toThrow(UnsupportedCarrierClaimError)
    expect(() =>
      assertCarrierClaimSupported('carrier SLA measured under contract', {
        carrierIdentity: 'Safaricom PLC', contractRef: 'MSA-2026-011',
      }),
    ).not.toThrow()
    expect(() => assertCarrierClaimSupported('coverage weakness on this corridor')).not.toThrow()
    // The rendered exports must pass the same check.
    const report = buildSlaReport(INPUT)
    expect(() => assertCarrierClaimSupported(reportToCsv(report))).not.toThrow()
  })
})

describe('FR-RPT-007: exports', () => {
  it('CSV is deterministic, carries the integrity hash, and quotes no suppressed cohort rate', () => {
    const report = buildSlaReport(INPUT)
    const csv = reportToCsv(report)
    expect(csv).toBe(reportToCsv(buildSlaReport(INPUT)))
    expect(csv).toContain(report.manifest.integritySha256)
    expect(csv).toContain('model:GV75,insufficient sample')
  })

  it('signed JSON round-trips through verification and detects tampering', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const report = buildSlaReport(INPUT)
    const signed = signReport(
      report,
      { keyId: 'test-key', sign: (payload) => edSign(null, payload, privateKey) },
      '2026-08-08T00:00:00.000Z',
    )
    const verify = (payload: Buffer, signature: Buffer): boolean =>
      edVerify(null, payload, publicKey, signature)

    const ok = verifySignedReport(signed, verify)
    expect(ok.intact).toBe(true)
    expect(ok.report?.manifest.reportId).toBe('rpt-2026-08')

    const tampered = { ...signed, payload: signed.payload.replace('"rpt-2026-08"', '"rpt-forged"') }
    expect(verifySignedReport(tampered, verify).intact).toBe(false)
  })

  it('the PDF is byte-stable and well-formed enough to open', () => {
    const report = buildSlaReport(INPUT)
    const a = reportToPdf(report)
    const b = reportToPdf(report)
    expect(a.equals(b)).toBe(true)
    expect(a.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4')
    expect(a.toString('latin1')).toContain('%%EOF')
    expect(a.toString('latin1')).toContain('INTERNAL RECOVERY SLA')
  })
})

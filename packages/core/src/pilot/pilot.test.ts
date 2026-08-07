// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A complete pilot, end to end, against the synthetic corpus — the §18 done-condition.
 *
 * The run itself is the test: lock, guard, seal, evaluate after the window closes, and produce
 * a report that separates observed from target with sample size and uncertainty on every rate.
 * The dry-run report lands in release/pilot-dry-run.json.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildCorpus } from '../evaluation/corpus.js'
import {
  PILOT_LABEL_GUIDE,
  RuleVersionDriftError,
  SealedHoldoutError,
  ShadowModeError,
  WindowOverlapError,
  assignInterval,
  assertRulesUnchanged,
  evaluatePilot,
  guardShadowDecision,
  lockPilot,
  pilotReport,
  type TimedCase,
} from './pilot.js'

const protocol = () =>
  lockPilot({
    id: 'pilot-dry-run',
    calibration: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-15T00:00:00.000Z' },
    holdout: { from: '2026-09-15T00:00:00.000Z', to: '2026-09-29T00:00:00.000Z' },
    labelGuideReviewedBy: 'independent-reviewer (engaged for the pilot)',
    labelGuideReviewedAt: '2026-08-30T00:00:00.000Z',
    lockedAt: '2026-08-31T00:00:00.000Z',
  })

/** The corpus with per-seed timestamps: even seeds land in calibration, odd in holdout. */
function timedCorpus(): TimedCase[] {
  const seeds = [11, 23, 37, 41, 53, 67, 71, 83, 97, 101]
  return buildCorpus({ seeds }).map((labelled, index) => ({
    ...labelled,
    occurredAt:
      index % 2 === 0
        ? new Date(Date.parse('2026-09-02T00:00:00.000Z') + index * 3_600_000).toISOString()
        : new Date(Date.parse('2026-09-16T00:00:00.000Z') + index * 3_600_000).toISOString(),
  }))
}

describe('the label guide', () => {
  it('covers every §22 code and warns against the parking-label misuse', () => {
    expect(PILOT_LABEL_GUIDE).toHaveLength(17)
    const unresolved = PILOT_LABEL_GUIDE.find((entry) => entry.code === 'OUT-UNRESOLVED')!
    expect(unresolved.guidance).toContain('not use as a parking label')
  })
})

describe('protocol locking', () => {
  it('refuses overlapping or reversed windows', () => {
    expect(() =>
      lockPilot({
        id: 'x',
        calibration: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-20T00:00:00.000Z' },
        holdout: { from: '2026-09-15T00:00:00.000Z', to: '2026-09-29T00:00:00.000Z' },
        labelGuideReviewedBy: 'r', labelGuideReviewedAt: '2026-08-30T00:00:00.000Z',
        lockedAt: '2026-08-31T00:00:00.000Z',
      }),
    ).toThrow(WindowOverlapError)
  })

  it('captures every shipped rule version, and drift is detected', () => {
    const locked = protocol()
    expect(Object.keys(locked.lockedRuleVersions).length).toBeGreaterThanOrEqual(9)
    expect(() => assertRulesUnchanged(locked)).not.toThrow()

    const drifted = {
      ...locked,
      lockedRuleVersions: { ...locked.lockedRuleVersions, 'rule.h-power.external-cut': '0.9.0' },
    }
    expect(() => assertRulesUnchanged(drifted)).toThrow(RuleVersionDriftError)
  })
})

describe('shadow mode', () => {
  it('classification-only decisions pass; world-affecting approvals throw', () => {
    const locked = protocol()
    expect(() => guardShadowDecision(locked, 'classify_explained')).not.toThrow()
    expect(() => guardShadowDecision(locked, 'authorize_field_verification')).toThrow(ShadowModeError)
    expect(() => guardShadowDecision(locked, 'authorize_recovery_action')).toThrow(ShadowModeError)
  })
})

describe('the sealed holdout', () => {
  it('cannot be evaluated before the window closes', () => {
    expect(() => evaluatePilot(protocol(), timedCorpus(), '2026-09-20T00:00:00.000Z')).toThrow(
      SealedHoldoutError,
    )
  })
})

describe('the complete dry run', () => {
  it('evaluates both intervals after close and produces the go/no-go report', () => {
    const locked = protocol()
    const cases = timedCorpus()
    const evaluation = evaluatePilot(locked, cases, '2026-09-29T00:00:00.000Z')

    expect(evaluation.calibration.n + evaluation.holdout.n).toBe(cases.length)
    expect(evaluation.excluded).toBe(0)
    expect(evaluation.holdout.classifier.precision.denominator).toBeGreaterThanOrEqual(0)

    const report = pilotReport({
      protocol: locked,
      evaluation,
      // Floors a real pilot would use; the sample floor is set where business plan §14.2 puts
      // it — above what ten synthetic seeds can supply, so the dry run must come back
      // conditional on sample size rather than faking a go.
      targets: { holdoutPrecisionFloor: 0.5, holdoutRecallFloor: 0.5, minHoldoutCases: 100 },
      roi: {
        observed: { casesReviewed: evaluation.holdout.n, falseDispatchesAvoided: 12 },
        modeled: { dispatchCostKes: 1500, recoveryValueKes: 180_000 },
      },
      generatedAt: '2026-09-29T00:00:00.000Z',
    })

    // Observed and target are separate objects; ROI separates observed from modeled and labels
    // the product as modeled.
    expect(report.observed).not.toBe(report.targets)
    expect(report.roi.note).toContain('MODELED')
    expect(report.roi.modeledSavingKes).toBe(18_000)

    // The synthetic corpus is deliberately too small for a real verdict: the report must say
    // conditional-on-sample-size, not fake a go.
    expect(report.goNoGo.verdict).toBe('conditional')
    expect(report.goNoGo.reasons.some((reason) => reason.includes('interval bounds'))).toBe(true)

    // Every quoted rate carries denominator and interval.
    const precision = report.observed.holdout.classifier.precision
    expect(precision.denominator).toBeGreaterThanOrEqual(0)
    if (precision.denominator > 0) {
      expect(precision.ci95Lower).not.toBeNull()
      expect(precision.ci95Upper).not.toBeNull()
    }

    mkdirSync(join(process.cwd(), 'release'), { recursive: true })
    writeFileSync(
      join(process.cwd(), 'release', 'pilot-dry-run.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    )
  })

  it('cases outside both windows are excluded and counted, never silently used', () => {
    const locked = protocol()
    const stray: TimedCase = { ...timedCorpus()[0]!, occurredAt: '2026-10-05T00:00:00.000Z' }
    const evaluation = evaluatePilot(locked, [stray], '2026-09-29T00:00:00.000Z')
    expect(evaluation.excluded).toBe(1)
    expect(assignInterval(locked, stray.occurredAt)).toBe('outside')
  })
})

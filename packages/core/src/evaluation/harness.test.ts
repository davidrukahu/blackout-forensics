// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest'

import { buildCorpus } from './corpus.js'
import {
  BASELINES,
  evaluateDecider,
  classifierDecider,
  rate,
  runHarness,
  wilsonUpperBound,
} from './harness.js'

const SEEDS = [11, 23, 37, 41, 53, 67, 71, 83, 97, 101]
const corpus = buildCorpus({ seeds: SEEDS })

describe('the corpus', () => {
  it('spans every scenario at every seed, labels riding beside the facts', () => {
    expect(corpus.length).toBe(14 * SEEDS.length)
    for (const c of corpus) {
      expect(c.truth.scenario).toBe(c.scenario)
      // Truth never leaks into the facts a decider sees.
      expect(JSON.stringify(c.facts)).not.toContain('trueCause')
    }
  })

  it('is deterministic — the same seeds rebuild the same corpus', () => {
    expect(JSON.stringify(buildCorpus({ seeds: [11] }))).toBe(
      JSON.stringify(buildCorpus({ seeds: [11] })),
    )
  })
})

describe('the harness runs the comparison FR-CLS-010 requires', () => {
  const report = runHarness(corpus)

  it('reports the classifier beside every baseline, never alone', () => {
    expect(report.deciders.map((d) => d.name)).toEqual([
      'classifier', 'fixed_timeout', 'power_loss_alert', 'vendor_volume',
    ])
    expect(report.incremental.map((i) => i.baseline)).toEqual([
      'fixed_timeout', 'power_loss_alert', 'vendor_volume',
    ])
  })

  it('every rate carries its interval and its denominators', () => {
    for (const decider of report.deciders) {
      for (const metric of [decider.precision, decider.recall, decider.flaggedRate]) {
        expect(metric.denominator).toBeGreaterThanOrEqual(0)
        if (metric.denominator > 0) {
          expect(metric.ci95Lower).not.toBeNull()
          expect(metric.ci95Upper).not.toBeNull()
          expect(metric.ci95Lower!).toBeLessThanOrEqual(metric.value!)
          expect(metric.ci95Upper!).toBeGreaterThanOrEqual(metric.value!)
        }
      }
    }
  })

  it('the classifier beats the fixed timeout on precision — the baseline flags everything', () => {
    const classifier = report.deciders.find((d) => d.name === 'classifier')!
    const timeout = report.deciders.find((d) => d.name === 'fixed_timeout')!

    // The timeout rule flags every silence it sees and misses the one real incident — the
    // power-cut device keeps reporting on battery, so there is no silence to time out on. The
    // classifier flags only direct evidence. That asymmetry, not any absolute rate, is the claim.
    expect(timeout.flaggedRate.value!).toBeGreaterThan(classifier.flaggedRate.value!)
    expect(timeout.recall.value!).toBe(0)
    expect(classifier.precision.value!).toBeGreaterThan(timeout.precision.value!)
  })

  it('states incremental value with interval discipline, not point-estimate bravado', () => {
    const timeoutDelta = report.incremental.find((i) => i.baseline === 'fixed_timeout')!
    expect(timeoutDelta.precisionDelta).not.toBeNull()
    expect(timeoutDelta.precisionDelta!).toBeGreaterThan(0)
    // clearlyBetter demands non-overlapping intervals; whatever it says must follow from the CIs.
    const classifier = report.deciders.find((d) => d.name === 'classifier')!
    const timeout = report.deciders.find((d) => d.name === 'fixed_timeout')!
    expect(timeoutDelta.clearlyBetterPrecision).toBe(
      classifier.precision.ci95Lower! > timeout.precision.ci95Upper!,
    )
  })

  it('the power-loss baseline ties the classifier where its alert is the whole story', () => {
    // On a corpus whose only urgent truth is a power disconnect, the power-alert baseline is
    // exactly right — and the harness must say so rather than flatter the classifier. The
    // classifier earns its keep on everything else: suppression, unknowns, review routing.
    const classifier = report.deciders.find((d) => d.name === 'classifier')!
    const powerAlert = report.deciders.find((d) => d.name === 'power_loss_alert')!
    expect(powerAlert.recall.value).toBe(1)
    expect(classifier.recall.value).toBe(1)
    expect(report.incremental.find((i) => i.baseline === 'power_loss_alert')!.clearlyBetterPrecision)
      .toBe(false)
  })

  it('counts unknown as its own column, never as an error', () => {
    expect(report.unknownRate.value).not.toBeNull()
    expect(report.unknownRate.value!).toBeGreaterThan(0)
    expect(report.unknownRate.denominator).toBe(corpus.length)
  })

  it('reports review rate — the workload the classifier creates', () => {
    expect(report.reviewRate.denominator).toBe(corpus.length)
    // Only direct-evidence rules demand review; most of the corpus should not.
    expect(report.reviewRate.value!).toBeLessThan(0.5)
  })

  it('breaks metrics down by hypothesis with both denominators visible', () => {
    const power = report.byHypothesis.find((h) => h.hypothesis === 'H-POWER')
    expect(power).toBeDefined()
    expect(power!.recall.value).toBe(1)
    expect(power!.precision.denominator).toBeGreaterThan(0)
  })

  it('carries the synthetic-corpus caveat in the report itself', () => {
    expect(report.caveat).toContain('synthetic')
    expect(report.caveat).toContain('no field accuracy')
  })
})

describe('harness mechanics', () => {
  it('an empty flagged set yields null precision, not zero', () => {
    const metrics = evaluateDecider('never', () => false, corpus)
    expect(metrics.precision.value).toBeNull()
    expect(metrics.flaggedRate.value).toBe(0)
  })

  it('rate() refuses to fabricate over an empty denominator', () => {
    expect(rate(0, 0).value).toBeNull()
    expect(rate(0, 0).ci95Lower).toBeNull()
  })

  it('wilson bounds bracket the point estimate for any sample', () => {
    for (const [successes, trials] of [[0, 10], [3, 7], [10, 10], [50, 200]] as const) {
      const p = successes / trials
      expect(wilsonUpperBound(successes, trials)).toBeGreaterThanOrEqual(p)
      expect(wilsonUpperBound(successes, trials)).toBeLessThanOrEqual(1)
    }
  })

  it('the deciders are pure: same facts, same answer', () => {
    for (const c of corpus.slice(0, 20)) {
      expect(classifierDecider(c.facts)).toBe(classifierDecider(c.facts))
      for (const baseline of Object.values(BASELINES)) {
        expect(baseline(c.facts)).toBe(baseline(c.facts))
      }
    }
  })
})

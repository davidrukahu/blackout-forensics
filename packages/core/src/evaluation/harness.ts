// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The baseline comparison harness — FR-CLS-010 and §15.3.
 *
 * Every advanced classifier is compared to the simple baselines a customer could run with a
 * spreadsheet: fixed timeout, power-loss-alert, vendor-volume. The product's own decision record
 * commits to "willingness to narrow or stop" if a simple rule performs as well — this harness is
 * where that question stops being rhetorical.
 *
 * §15.3's disciplines, enforced in the shape of the output:
 *   * unknown is a valid safe outcome, counted in its own column, never as an error;
 *   * every rate carries its Wilson interval, because a rate without one invites reading 3-of-4 as
 *     75% with a straight face;
 *   * incremental value is reported against each baseline — a classifier that merely ties the
 *     timeout rule has not earned its complexity.
 */

import { wilsonLowerBound } from '../geo/corridor.js'
import { classify, type ClassificationResult } from '../rules/classify.js'
import { CONTRADICTIONS, RULE_PACKAGES } from '../rules/packages.js'
import { FACT_VOCABULARY_VERSION, type FactSet } from '../rules/facts.js'
import type { LabelledCase } from './corpus.js'

/** Wilson upper bound, the mirror of the lower one the corridor module already carries. */
export function wilsonUpperBound(successes: number, trials: number): number {
  if (trials === 0) return 1
  const z = 1.96
  const p = successes / trials
  const denominator = 1 + (z * z) / trials
  const centre = p + (z * z) / (2 * trials)
  const margin = z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))
  return Math.min(1, (centre + margin) / denominator)
}

export interface Rate {
  readonly numerator: number
  readonly denominator: number
  readonly value: number | null
  readonly ci95Lower: number | null
  readonly ci95Upper: number | null
}

export function rate(numerator: number, denominator: number): Rate {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
    ci95Lower: denominator === 0 ? null : wilsonLowerBound(numerator, denominator),
    ci95Upper: denominator === 0 ? null : wilsonUpperBound(numerator, denominator),
  }
}

/**
 * The decision under evaluation: "this episode needs urgent review now."
 *
 * Ground truth for it is a direct device-side incident — in the current corpus, a power
 * disconnect. Everything else, including genuinely unknown causes, is truth-negative for URGENCY
 * specifically: dispatching on an unknown is exactly what FR-CLS-007 exists to prevent.
 */
export type UrgencyDecider = (facts: FactSet) => boolean

const URGENT_TRUTH_CAUSES = new Set(['power_disconnect'])

export const BASELINES: Readonly<Record<string, UrgencyDecider>> = {
  /** Any detected gap is urgent. The rule most customers start with. */
  fixed_timeout: (facts) => facts['episode.type']?.status === 'available',
  /** Urgent exactly when a power-cut alert arrived. */
  power_loss_alert: (facts) => {
    const fact = facts['power.cut_alert_present']
    return fact?.status === 'available' && fact.value === true
  },
  /** Urgent when several peers went silent together — volume as alarm. */
  vendor_volume: (facts) => {
    const fact = facts['source.independent_devices']
    return fact?.status === 'available' && typeof fact.value === 'number' && fact.value >= 3
  },
}

export const classifierDecider: UrgencyDecider = (facts) =>
  classifierResult(facts).urgentEligible

export function classifierResult(facts: FactSet): ClassificationResult {
  return classify({
    facts,
    packages: RULE_PACKAGES,
    contradictions: CONTRADICTIONS,
    at: '2026-09-01T00:00:00.000Z',
    factVocabularyVersion: FACT_VOCABULARY_VERSION,
  })
}

export interface DeciderMetrics {
  readonly name: string
  readonly precision: Rate
  readonly recall: Rate
  readonly flaggedRate: Rate
}

export function evaluateDecider(
  name: string,
  decider: UrgencyDecider,
  cases: readonly LabelledCase[],
): DeciderMetrics {
  let truePositives = 0
  let flagged = 0
  let truthPositives = 0

  for (const c of cases) {
    const predicted = decider(c.facts)
    const actual = URGENT_TRUTH_CAUSES.has(c.truth.trueCause)
    if (predicted) flagged += 1
    if (actual) truthPositives += 1
    if (predicted && actual) truePositives += 1
  }

  return {
    name,
    precision: rate(truePositives, flagged),
    recall: rate(truePositives, truthPositives),
    flaggedRate: rate(flagged, cases.length),
  }
}

export interface HypothesisMetrics {
  readonly hypothesis: string
  readonly precision: Rate
  readonly recall: Rate
}

/** Which fired hypothesis would be the right call for each ground-truth cause. */
const TRUTH_TO_HYPOTHESIS: Readonly<Record<string, string>> = {
  expected_sleep: 'H-EXPECTED',
  gnss_only_loss: 'H-GNSS',
  power_disconnect: 'H-POWER',
  device_fault: 'H-DEVICE',
  network_incident: 'H-NETWORK',
  vendor_ingestion_delay: 'H-VENDOR',
}

export interface HarnessReport {
  readonly caseCount: number
  readonly caveat: string
  readonly deciders: readonly DeciderMetrics[]
  /** Classifier minus baseline, on the CI-guarded reading of each metric. */
  readonly incremental: readonly {
    readonly baseline: string
    readonly precisionDelta: number | null
    readonly recallDelta: number | null
    /** True only when the classifier's CI lower bound clears the baseline's upper bound. */
    readonly clearlyBetterPrecision: boolean
  }[]
  readonly byHypothesis: readonly HypothesisMetrics[]
  readonly reviewRate: Rate
  readonly unknownRate: Rate
}

/**
 * Run the full comparison.
 *
 * "Clearly better" demands non-overlapping intervals, not a bigger point estimate: on a synthetic
 * corpus the honest headline is usually "not yet distinguishable", and saying so is the point.
 */
export function runHarness(cases: readonly LabelledCase[]): HarnessReport {
  const classifierMetrics = evaluateDecider('classifier', classifierDecider, cases)
  const baselineMetrics = Object.entries(BASELINES).map(([name, decider]) =>
    evaluateDecider(name, decider, cases),
  )

  let reviewFlagged = 0
  let unknowns = 0
  const perHypothesis = new Map<string, { tp: number; fired: number; truth: number }>()

  for (const c of cases) {
    const result = classifierResult(c.facts)
    if (result.hypotheses.some((h) => h.humanReview)) reviewFlagged += 1
    if (result.unknown !== null) unknowns += 1

    const expected = TRUTH_TO_HYPOTHESIS[c.truth.trueCause]
    const firedCodes = new Set(result.hypotheses.map((h) => h.code as string))
    for (const code of new Set([...firedCodes, ...(expected === undefined ? [] : [expected])])) {
      const entry = perHypothesis.get(code) ?? { tp: 0, fired: 0, truth: 0 }
      if (firedCodes.has(code)) entry.fired += 1
      if (expected === code) {
        entry.truth += 1
        if (firedCodes.has(code)) entry.tp += 1
      }
      perHypothesis.set(code, entry)
    }
  }

  return {
    caseCount: cases.length,
    caveat:
      'measured on the synthetic reference corpus: these numbers describe behaviour against ' +
      'generated scenarios and their generator\'s assumptions, and no field accuracy is claimed ' +
      'from them (§15.3, biz plan §5.2)',
    deciders: [classifierMetrics, ...baselineMetrics],
    incremental: baselineMetrics.map((baseline) => ({
      baseline: baseline.name,
      precisionDelta:
        classifierMetrics.precision.value === null || baseline.precision.value === null
          ? null
          : classifierMetrics.precision.value - baseline.precision.value,
      recallDelta:
        classifierMetrics.recall.value === null || baseline.recall.value === null
          ? null
          : classifierMetrics.recall.value - baseline.recall.value,
      clearlyBetterPrecision:
        classifierMetrics.precision.ci95Lower !== null &&
        baseline.precision.ci95Upper !== null &&
        classifierMetrics.precision.ci95Lower > baseline.precision.ci95Upper,
    })),
    byHypothesis: [...perHypothesis.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([hypothesis, counts]) => ({
        hypothesis,
        precision: rate(counts.tp, counts.fired),
        recall: rate(counts.tp, counts.truth),
      })),
    reviewRate: rate(reviewFlagged, cases.length),
    unknownRate: rate(unknowns, cases.length),
  }
}

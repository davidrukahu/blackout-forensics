// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pilot protocol instrumentation — PRD §18, business plan §14.2.
 *
 * A pilot is an experiment, and the instrumentation exists to keep it one:
 *
 *   * **Time separation is structural.** Calibration and holdout windows may not overlap, the
 *     holdout must follow calibration, and holdout labels are sealed — evaluating them before
 *     the window closes throws. Peeking is the failure mode that turns a pilot into a demo.
 *   * **Rules are locked.** The protocol records every rule id and version at lock time;
 *     evaluation refuses to run against drifted versions. A pilot that quietly upgraded its
 *     rules mid-run measured two systems and can report on neither.
 *   * **Shadow means shadow.** In shadow mode the queue observes and classifies; any attempt to
 *     approve a world-affecting decision throws. No application-triggered field action, by
 *     construction rather than by promising.
 *   * **The report separates observed from target**, and every rate carries its denominator and
 *     Wilson interval. A go/no-go that quotes a point estimate over eleven cases is marketing.
 */

import { RULE_PACKAGES } from '../rules/packages.js'
import { decisionById } from '../queue/decisions.js'
import { OUTCOME_TAXONOMY } from '../queue/outcomes.js'
import { classifierDecider, evaluateDecider, BASELINES, type DeciderMetrics } from '../evaluation/harness.js'
import type { LabelledCase } from '../evaluation/corpus.js'

// ------------------------------------------------------------------ label guide

export interface LabelGuideEntry {
  readonly code: string
  readonly meaning: string
  readonly confirmationSource: string
  readonly guidance: string
}

/**
 * The labelling guide reviewers work from — one entry per §22 code, with the judgement call each
 * code actually involves. Independent review of this guide is a named governance act recorded on
 * the protocol, not a property of the text.
 */
export const PILOT_LABEL_GUIDE: readonly LabelGuideEntry[] = OUTCOME_TAXONOMY.map((outcome) => ({
  code: outcome.code,
  meaning: outcome.meaning,
  confirmationSource: outcome.confirmationSource,
  guidance:
    outcome.code === 'OUT-UNRESOLVED'
      ? 'Use when review is COMPLETE and the cause still is not established. Do not use as a parking label for unfinished review — that is an open case, not an outcome.'
      : outcome.code === 'OUT-UNKNOWN'
        ? 'Use when the evidence needed to label no longer exists or was never collected. Record what was missing.'
        : `Label only with the confirmation source in hand (${outcome.confirmationSource}). A plausible story without the record is OUT-UNRESOLVED, not this code.`,
}))

// ------------------------------------------------------------------ protocol

export interface PilotWindow {
  readonly from: string
  readonly to: string
}

export interface PilotProtocol {
  readonly id: string
  readonly mode: 'shadow'
  readonly calibration: PilotWindow
  readonly holdout: PilotWindow
  /** Every rule id → version, captured at lock time. Evaluation refuses drift. */
  readonly lockedRuleVersions: Readonly<Record<string, string>>
  readonly labelGuideReviewedBy: string
  readonly labelGuideReviewedAt: string
  readonly lockedAt: string
}

export class WindowOverlapError extends Error {
  constructor() {
    super(
      'calibration and holdout windows must be time-separated with holdout strictly after ' +
        'calibration — anything else lets calibration see the answers',
    )
    this.name = 'WindowOverlapError'
  }
}

export class SealedHoldoutError extends Error {
  constructor(readonly opensAt: string) {
    super(
      `the holdout is sealed until ${opensAt}: evaluating it early is how a pilot becomes a demo`,
    )
    this.name = 'SealedHoldoutError'
  }
}

export class RuleVersionDriftError extends Error {
  constructor(readonly drifted: readonly string[]) {
    super(
      `rule versions drifted since the pilot locked: ${drifted.join(', ')}. A pilot that ` +
        'upgraded its rules mid-run measured two systems and can report on neither.',
    )
    this.name = 'RuleVersionDriftError'
  }
}

export class ShadowModeError extends Error {
  constructor(readonly decisionId: string) {
    super(
      `"${decisionId}" is world-affecting and this pilot runs in shadow mode: the application ` +
        'triggers no field action during a pilot (PRD §18)',
    )
    this.name = 'ShadowModeError'
  }
}

export function lockPilot(params: {
  readonly id: string
  readonly calibration: PilotWindow
  readonly holdout: PilotWindow
  readonly labelGuideReviewedBy: string
  readonly labelGuideReviewedAt: string
  readonly lockedAt: string
}): PilotProtocol {
  if (
    Date.parse(params.calibration.from) >= Date.parse(params.calibration.to) ||
    Date.parse(params.holdout.from) >= Date.parse(params.holdout.to) ||
    Date.parse(params.holdout.from) < Date.parse(params.calibration.to)
  ) {
    throw new WindowOverlapError()
  }
  const lockedRuleVersions = Object.fromEntries(
    RULE_PACKAGES.map((rule) => [rule.id, rule.version]),
  )
  return {
    id: params.id,
    mode: 'shadow',
    calibration: params.calibration,
    holdout: params.holdout,
    lockedRuleVersions,
    labelGuideReviewedBy: params.labelGuideReviewedBy,
    labelGuideReviewedAt: params.labelGuideReviewedAt,
    lockedAt: params.lockedAt,
  }
}

export function assignInterval(
  protocol: PilotProtocol,
  occurredAt: string,
): 'calibration' | 'holdout' | 'outside' {
  const t = Date.parse(occurredAt)
  if (t >= Date.parse(protocol.calibration.from) && t < Date.parse(protocol.calibration.to)) {
    return 'calibration'
  }
  if (t >= Date.parse(protocol.holdout.from) && t < Date.parse(protocol.holdout.to)) {
    return 'holdout'
  }
  return 'outside'
}

/** The shadow-queue guard: approving a world-affecting decision during a pilot throws. */
export function guardShadowDecision(protocol: PilotProtocol, decisionId: string): void {
  if (protocol.mode === 'shadow' && decisionById(decisionId).worldAffecting) {
    throw new ShadowModeError(decisionId)
  }
}

export function assertRulesUnchanged(protocol: PilotProtocol): void {
  const drifted: string[] = []
  for (const rule of RULE_PACKAGES) {
    const locked = protocol.lockedRuleVersions[rule.id]
    if (locked === undefined || locked !== rule.version) {
      drifted.push(`${rule.id}: locked ${locked ?? 'nothing'}, current ${rule.version}`)
    }
  }
  for (const id of Object.keys(protocol.lockedRuleVersions)) {
    if (!RULE_PACKAGES.some((rule) => rule.id === id)) {
      drifted.push(`${id}: locked but no longer shipped`)
    }
  }
  if (drifted.length > 0) throw new RuleVersionDriftError(drifted)
}

// ------------------------------------------------------------------ evaluation and report

export interface TimedCase extends LabelledCase {
  readonly occurredAt: string
}

export interface PilotEvaluation {
  readonly calibration: {
    readonly n: number
    readonly classifier: DeciderMetrics
    readonly baselines: readonly DeciderMetrics[]
  }
  readonly holdout: {
    readonly n: number
    readonly classifier: DeciderMetrics
    readonly baselines: readonly DeciderMetrics[]
  }
  readonly excluded: number
}

export function evaluatePilot(
  protocol: PilotProtocol,
  cases: readonly TimedCase[],
  now: string,
): PilotEvaluation {
  assertRulesUnchanged(protocol)
  if (Date.parse(now) < Date.parse(protocol.holdout.to)) {
    throw new SealedHoldoutError(protocol.holdout.to)
  }

  const calibration = cases.filter((c) => assignInterval(protocol, c.occurredAt) === 'calibration')
  const holdout = cases.filter((c) => assignInterval(protocol, c.occurredAt) === 'holdout')
  const excluded = cases.length - calibration.length - holdout.length

  const evaluate = (subset: readonly TimedCase[]) => ({
    n: subset.length,
    classifier: evaluateDecider('classifier', classifierDecider, subset),
    baselines: Object.entries(BASELINES).map(([name, decider]) =>
      evaluateDecider(name, decider, subset),
    ),
  })

  return { calibration: evaluate(calibration), holdout: evaluate(holdout), excluded }
}

export interface PilotTargets {
  /** e.g. business plan §14.2: precision the pilot must demonstrate on holdout. */
  readonly holdoutPrecisionFloor: number
  readonly holdoutRecallFloor: number
  readonly minHoldoutCases: number
}

export interface RoiInputs {
  /** Observed during the pilot. */
  readonly observed: {
    readonly casesReviewed: number
    readonly falseDispatchesAvoided: number
  }
  /** Modeled, supplied by the customer, never presented as measured. */
  readonly modeled: {
    readonly dispatchCostKes: number
    readonly recoveryValueKes: number
  }
}

export interface PilotReport {
  readonly pilotId: string
  readonly generatedAt: string
  readonly ruleVersions: Readonly<Record<string, string>>
  readonly observed: PilotEvaluation
  readonly targets: PilotTargets
  readonly roi: {
    readonly observed: RoiInputs['observed']
    readonly modeled: RoiInputs['modeled']
    readonly modeledSavingKes: number
    readonly note: string
  }
  readonly goNoGo: {
    readonly verdict: 'go' | 'conditional' | 'no_go'
    readonly reasons: readonly string[]
  }
}

export function pilotReport(params: {
  readonly protocol: PilotProtocol
  readonly evaluation: PilotEvaluation
  readonly targets: PilotTargets
  readonly roi: RoiInputs
  readonly generatedAt: string
}): PilotReport {
  const { evaluation, targets } = params
  const holdout = evaluation.holdout
  const reasons: string[] = []

  if (holdout.n < targets.minHoldoutCases) {
    reasons.push(
      `holdout has ${holdout.n} case(s); the protocol requires ${targets.minHoldoutCases} — the interval bounds below are too wide to decide on`,
    )
  }
  const precision = holdout.classifier.precision
  const recall = holdout.classifier.recall
  // Decide on the cautious end of the interval, never the point estimate.
  if (precision.ci95Lower !== null && precision.ci95Lower < targets.holdoutPrecisionFloor) {
    reasons.push(
      `holdout precision ${precision.value?.toFixed(2) ?? 'n/a'} (95% CI lower ${precision.ci95Lower.toFixed(2)}, n=${precision.denominator}) does not clear the ${targets.holdoutPrecisionFloor} floor at the cautious end`,
    )
  }
  if (recall.ci95Lower !== null && recall.ci95Lower < targets.holdoutRecallFloor) {
    reasons.push(
      `holdout recall ${recall.value?.toFixed(2) ?? 'n/a'} (95% CI lower ${recall.ci95Lower.toFixed(2)}, n=${recall.denominator}) does not clear the ${targets.holdoutRecallFloor} floor at the cautious end`,
    )
  }

  const verdict: PilotReport['goNoGo']['verdict'] =
    reasons.length === 0 ? 'go' : holdout.n < targets.minHoldoutCases ? 'conditional' : 'no_go'

  return {
    pilotId: params.protocol.id,
    generatedAt: params.generatedAt,
    ruleVersions: params.protocol.lockedRuleVersions,
    observed: evaluation,
    targets,
    roi: {
      observed: params.roi.observed,
      modeled: params.roi.modeled,
      modeledSavingKes:
        params.roi.observed.falseDispatchesAvoided * params.roi.modeled.dispatchCostKes,
      note:
        'MODELED saving = observed avoided dispatches x customer-supplied cost. The dispatch cost and recovery value are inputs, not measurements, and must be shown as such (FR-RPT-006).',
    },
    goNoGo: { verdict, reasons },
  }
}

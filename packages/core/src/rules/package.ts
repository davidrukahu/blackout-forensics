// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Rule packages: the declarative form, the three-valued evaluator, and validation.
 *
 * The thirteen contents PRD §8.3 mandates map onto the package shape as follows:
 *   1  rule identifier and semantic version        → id, version
 *   2  purpose and applicable hypothesis           → purpose, hypothesis
 *   3  required and optional evidence fields       → requiredFacts, optionalFacts
 *   4  capability preconditions                    → required-fact availability (manifest-driven)
 *   5  time and cohort windows                     → governance.effectiveFrom / effectiveTo
 *   6  positive and negative conditions            → positive, negative
 *   7  counterevidence conditions                  → counterevidence
 *   8  evidence strength produced                  → produces.strength (and family)
 *   9  priority effect                             → priorityEffect (named factor — §5.3 forbids
 *                                                    hidden scores)
 *   10 human review requirement                    → humanReview
 *   11 test fixtures and expected results          → fixtures (executed by validation, not merely
 *                                                    stored)
 *   12 owner, reviewers and approval date          → governance.owner / technicalReviewer /
 *                                                    riskApprover / approvedOn
 *   13 effective period and rollback reference     → governance.effectiveFrom/To / rollbackTo
 *
 * Evaluation is three-valued (ticket 37). A rule whose required facts are unavailable is
 * NOT-APPLICABLE, and the missing facts become FR-CLS-003's missing-expected-evidence list. "We
 * could not check" never collapses into "we checked and found nothing".
 */

import type { EvidenceFamily, EvidenceItem, EvidenceStrength } from '../evidence.js'
import { isVocabularyFact, type FactSet, type FactValue } from './facts.js'

export type HypothesisCode =
  | 'H-EXPECTED' | 'H-GNSS' | 'H-VENDOR' | 'H-NETWORK' | 'H-CORRIDOR'
  | 'H-POWER' | 'H-DEVICE' | 'H-TAMPER' | 'H-UNKNOWN'

export const HYPOTHESIS_CODES: readonly HypothesisCode[] = [
  'H-EXPECTED', 'H-GNSS', 'H-VENDOR', 'H-NETWORK', 'H-CORRIDOR',
  'H-POWER', 'H-DEVICE', 'H-TAMPER', 'H-UNKNOWN',
]

export type Predicate =
  | { readonly fact: string; readonly op: 'eq' | 'neq'; readonly value: FactValue }
  | { readonly fact: string; readonly op: 'gte' | 'lte'; readonly value: number }
  | { readonly fact: string; readonly op: 'in'; readonly values: readonly FactValue[] }
  | { readonly anyOf: readonly Predicate[] }

export interface CounterCondition {
  readonly when: Predicate
  readonly summary: string
}

export interface RuleFixture {
  readonly name: string
  readonly facts: FactSet
  readonly expected: 'fired' | 'did_not_fire' | 'not_applicable'
}

export interface RuleGovernance {
  readonly owner: string
  /** §3.3: publication needs a technical reviewer AND a risk or operations approver — two people. */
  readonly technicalReviewer: string
  readonly riskApprover: string
  readonly approvedOn: string
  readonly effectiveFrom: string
  readonly effectiveTo: string | null
  readonly rollbackTo: string | null
}

export interface RulePackage {
  readonly id: string
  readonly version: string
  readonly purpose: string
  readonly hypothesis: Exclude<HypothesisCode, 'H-UNKNOWN'>
  readonly requiredFacts: readonly string[]
  readonly optionalFacts: readonly string[]
  readonly positive: readonly Predicate[]
  readonly negative: readonly Predicate[]
  readonly counterevidence: readonly CounterCondition[]
  readonly produces: {
    readonly family: EvidenceFamily
    readonly strength: EvidenceStrength
    readonly summary: string
  }
  readonly priorityEffect: {
    readonly factor: string
    readonly effect: 'raise' | 'lower' | 'none'
  }
  readonly humanReview: boolean
  readonly fixtures: readonly RuleFixture[]
  readonly governance: RuleGovernance
}

export interface CounterNote {
  readonly summary: string
}

export type RuleOutcome =
  | {
      readonly kind: 'fired'
      readonly evidence: EvidenceItem
      readonly counterevidence: readonly CounterNote[]
      readonly missingExpected: readonly string[]
    }
  | { readonly kind: 'did_not_fire'; readonly missingExpected: readonly string[] }
  | { readonly kind: 'not_applicable'; readonly missingFacts: readonly string[] }

type Tri = true | false | 'unknown'

function evalPredicate(predicate: Predicate, facts: FactSet, unknownFacts: Set<string>): Tri {
  if ('anyOf' in predicate) {
    let sawUnknown = false
    for (const branch of predicate.anyOf) {
      const result = evalPredicate(branch, facts, unknownFacts)
      if (result === true) return true
      if (result === 'unknown') sawUnknown = true
    }
    return sawUnknown ? 'unknown' : false
  }

  const fact = facts[predicate.fact]
  if (fact === undefined || fact.status === 'unavailable') {
    unknownFacts.add(predicate.fact)
    return 'unknown'
  }

  const value = fact.value
  switch (predicate.op) {
    case 'eq': return value === predicate.value
    case 'neq': return value !== predicate.value
    case 'gte': return typeof value === 'number' && value >= predicate.value
    case 'lte': return typeof value === 'number' && value <= predicate.value
    case 'in': return predicate.values.includes(value)
  }
}

/**
 * Evaluate one rule against a fact set.
 *
 * Semantics, in order:
 *   - Any REQUIRED fact unavailable → not_applicable, listing every missing required fact.
 *   - Positive conditions must all hold. A positive condition touching an unavailable OPTIONAL
 *     fact evaluates unknown, which does not fire — and the fact is recorded as missing expected
 *     evidence rather than silently ignored.
 *   - A negative condition that holds blocks firing. One that is unknown does not block — you
 *     cannot prove a negative from a fact you could not read — but is recorded as missing.
 *   - Counterevidence is evaluated even when the rule fires, because FR-CLS-003 requires
 *     counterevidence to be shown beside supporting evidence, not only when it wins.
 */
export function evaluateRule(rule: RulePackage, facts: FactSet): RuleOutcome {
  const missingRequired = rule.requiredFacts.filter((name) => {
    const fact = facts[name]
    return fact === undefined || fact.status === 'unavailable'
  })
  if (missingRequired.length > 0) {
    return { kind: 'not_applicable', missingFacts: missingRequired }
  }

  const unknownTouched = new Set<string>()

  let firedPositive = true
  for (const predicate of rule.positive) {
    const result = evalPredicate(predicate, facts, unknownTouched)
    if (result !== true) firedPositive = false
  }

  let blocked = false
  for (const predicate of rule.negative) {
    if (evalPredicate(predicate, facts, unknownTouched) === true) blocked = true
  }

  const missingExpected = [
    ...new Set([
      ...unknownTouched,
      ...rule.optionalFacts.filter((name) => {
        const fact = facts[name]
        return fact === undefined || fact.status === 'unavailable'
      }),
    ]),
  ].sort()

  if (!firedPositive || blocked) {
    return { kind: 'did_not_fire', missingExpected }
  }

  const counterevidence: CounterNote[] = []
  for (const condition of rule.counterevidence) {
    if (evalPredicate(condition.when, facts, unknownTouched) === true) {
      counterevidence.push({ summary: condition.summary })
    }
  }

  return {
    kind: 'fired',
    evidence: {
      family: rule.produces.family,
      strength: rule.produces.strength,
      summary: rule.produces.summary,
    },
    counterevidence,
    missingExpected,
  }
}

// ---------------------------------------------------------------- prohibited wording

/**
 * §8.1's prohibited-conclusion column plus §11.5, as substrings a package may never contain.
 *
 * Checked against every human-readable string in the package. The list errs broad — "borrower"
 * blocks any sentence about a borrower, because there is no sentence about a borrower this system
 * is entitled to produce.
 */
export const GLOBAL_PROHIBITED: readonly string[] = [
  'borrower', 'theft', 'stolen', 'culpab', 'asset is safe', 'no coverage',
  'carrier-confirmed', 'exact path', 'repossess', 'immobili',
]

export const PROHIBITED_BY_HYPOTHESIS: Readonly<Partial<Record<HypothesisCode, readonly string[]>>> = {
  'H-GNSS': ['cellular outage'],
  'H-VENDOR': ['operator outage', 'mobile operator'],
  'H-NETWORK': ['confirmed outage'],
  'H-CORRIDOR': ['path taken'],
  'H-TAMPER': ['confirmed tamper'],
}

/** §11.5: H-TAMPER uses this exact phrase, no paraphrase. */
export const TAMPER_REQUIRED_PHRASE = 'device telemetry supports possible tracker interference'

// ---------------------------------------------------------------- validation

export interface RuleViolation {
  readonly rule: string
  readonly code: string
  readonly detail: string
}

const SEMVER = /^\d+\.\d+\.\d+$/

/**
 * Validate a package: the thirteen contents, the closed vocabulary, prohibited wording — and the
 * fixtures, which are executed rather than merely counted. A fixture that no longer produces its
 * expected outcome is a violation, so a package cannot drift from its own stated behaviour.
 */
export function validateRulePackage(rule: RulePackage): RuleViolation[] {
  const violations: RuleViolation[] = []
  const violate = (code: string, detail: string): void => {
    violations.push({ rule: rule.id, code, detail })
  }

  if (!SEMVER.test(rule.version)) violate('version', `"${rule.version}" is not a semantic version`)
  if (rule.purpose.trim() === '') violate('purpose', 'purpose is empty')
  if (!HYPOTHESIS_CODES.includes(rule.hypothesis)) {
    violate('hypothesis', `unknown hypothesis ${rule.hypothesis}`)
  }

  for (const name of [...rule.requiredFacts, ...rule.optionalFacts]) {
    if (!isVocabularyFact(name)) {
      violate('vocabulary', `fact "${name}" is not in the closed vocabulary — extending it is its own reviewed change`)
    }
  }

  const referenced = new Set<string>()
  const collect = (predicate: Predicate): void => {
    if ('anyOf' in predicate) predicate.anyOf.forEach(collect)
    else referenced.add(predicate.fact)
  }
  rule.positive.forEach(collect)
  rule.negative.forEach(collect)
  rule.counterevidence.forEach((c) => collect(c.when))

  const declared = new Set([...rule.requiredFacts, ...rule.optionalFacts])
  for (const name of referenced) {
    if (!declared.has(name)) {
      violate('undeclared-fact', `condition references "${name}" which is neither required nor optional`)
    }
  }

  if (rule.hypothesis === 'H-CORRIDOR' && rule.produces.strength === 'direct') {
    // Ticket 40: H-CORRIDOR confidence never exceeds corroborated — a recurring corridor is a
    // reason to look, never proof about a specific episode.
    violate('corridor-strength', 'H-CORRIDOR may not produce direct evidence')
  }

  if (rule.produces.strength === 'direct' && !rule.humanReview) {
    violate('review', 'a rule producing direct evidence can support urgent action and must require human review')
  }

  if (rule.priorityEffect.factor.trim() === '') {
    violate('priority-factor', '§5.3 forbids hidden scores: the priority factor must be named')
  }

  if (rule.fixtures.length < 2) {
    violate('fixtures', 'at least one firing and one non-firing fixture are required')
  }
  for (const fixture of rule.fixtures) {
    const outcome = evaluateRule(rule, fixture.facts)
    if (outcome.kind !== fixture.expected) {
      violate('fixture-drift', `fixture "${fixture.name}" expected ${fixture.expected} but produced ${outcome.kind}`)
    }
  }

  const governance = rule.governance
  if (governance.owner.trim() === '') violate('governance', 'owner is empty')
  if (governance.technicalReviewer.trim() === '' || governance.riskApprover.trim() === '') {
    violate('governance', '§3.3 requires a technical reviewer and a risk or operations approver')
  }
  if (governance.technicalReviewer === governance.riskApprover) {
    violate('governance', 'the technical reviewer and risk approver must be different people')
  }
  if (governance.approvedOn.trim() === '' || governance.effectiveFrom.trim() === '') {
    violate('governance', 'approval date and effective period are required')
  }

  const prohibited = [
    ...GLOBAL_PROHIBITED,
    ...(PROHIBITED_BY_HYPOTHESIS[rule.hypothesis] ?? []),
  ]
  const texts = [
    rule.purpose,
    rule.produces.summary,
    ...rule.counterevidence.map((c) => c.summary),
  ]
  for (const text of texts) {
    const lowered = text.toLowerCase()
    for (const phrase of prohibited) {
      if (lowered.includes(phrase)) {
        violate('prohibited-wording', `"${phrase}" may not appear: ${text.slice(0, 60)}`)
      }
    }
  }

  if (rule.hypothesis === 'H-TAMPER' && rule.produces.summary !== TAMPER_REQUIRED_PHRASE) {
    violate('tamper-phrase', `§11.5 requires the exact phrase "${TAMPER_REQUIRED_PHRASE}"`)
  }

  return violations
}

/** Whether a package is effective at an instant — half-open, like every interval in this system. */
export function isEffectiveAt(rule: RulePackage, at: string): boolean {
  const t = Date.parse(at)
  if (t < Date.parse(rule.governance.effectiveFrom)) return false
  return rule.governance.effectiveTo === null || t < Date.parse(rule.governance.effectiveTo)
}

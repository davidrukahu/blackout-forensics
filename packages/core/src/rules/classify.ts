// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The classifier: every effective rule package over one fact set, producing the record FR-CLS-003
 * requires — evidence, counterevidence, missing expected evidence, confidence band and rule version,
 * for every non-unknown result.
 *
 * Multiple hypotheses coexist (FR-CLS-004): a platform delay and a weak corridor prior are both
 * statements about the same gap, and forcing a single label would manufacture certainty. H-UNKNOWN
 * is not a rule but the classifier's own conclusion when nothing fired — evidence missing,
 * conflicting or below threshold is a valid result, never an error (PRD §1.2).
 *
 * Two rules here were rewritten after adversarial verification demonstrated them broken:
 *
 *   * Suppression is decided PER FIRED ENTRY, never per hypothesis code. The first version kept a
 *     code-keyed map, so suppressing a weak inference also suppressed a direct alert that happened
 *     to share its hypothesis — the exact §17.2 violation the design document called absolute.
 *   * Urgency has VALENCE. Evidence whose own priority effect is 'lower' explains a gap; letting it
 *     corroborate urgency meant two benign explanations could jointly demand a field dispatch.
 *     Only evidence arguing FOR anomaly (effect 'raise') can support urgent action.
 */

import { canSupportUrgentAction, type EvidenceItem, type EvidenceStrength } from '../evidence.js'
import type { FactSet } from './facts.js'
import {
  evaluateRule,
  isEffectiveAt,
  validateRulePackage,
  type CounterNote,
  type HypothesisCode,
  type Predicate,
  type RulePackage,
} from './package.js'
import type { Contradiction } from './packages.js'

export interface ClassifiedHypothesis {
  readonly code: HypothesisCode
  readonly ruleId: string
  readonly ruleVersion: string
  /** §8.2's band. Suppression and material counterevidence can lower it; nothing raises it. */
  readonly band: EvidenceStrength
  readonly evidence: EvidenceItem
  readonly counterevidence: readonly CounterNote[]
  readonly missingExpected: readonly string[]
  readonly humanReview: boolean
  /** Set when a contradicting hypothesis suppressed this one. Direct evidence is never suppressed. */
  readonly suppressedBy: HypothesisCode | null
}

export interface InapplicableRule {
  readonly code: HypothesisCode
  readonly ruleId: string
  /** FR-CLS-003's missing expected evidence: what could not be checked, by name. */
  readonly missingFacts: readonly string[]
}

export interface PriorityFactor {
  readonly factor: string
  readonly effect: 'raise' | 'lower' | 'none'
  readonly fromRule: string
}

export interface ClassificationResult {
  readonly hypotheses: readonly ClassifiedHypothesis[]
  /** Present when no hypothesis fired: the valid safe outcome, with what was missing. */
  readonly unknown: {
    readonly code: 'H-UNKNOWN'
    readonly reason: string
    readonly missingExpected: readonly string[]
  } | null
  readonly notApplicable: readonly InapplicableRule[]
  /** §5.3: priority is a versioned policy result made from named factors, never a hidden score. */
  readonly priorityFactors: readonly PriorityFactor[]
  /** FR-CLS-007 via the shared evidence threshold, over non-suppressed 'raise' evidence only. */
  readonly urgentEligible: boolean
  readonly factVocabularyVersion: string
}

type Tri = true | false | 'unknown'

/** Tri-state predicate check for `unless` clauses: an unread exception is not a checked one. */
function predicateTri(predicate: Predicate, facts: FactSet): Tri {
  if ('anyOf' in predicate) {
    let sawUnknown = false
    for (const branch of predicate.anyOf) {
      const result = predicateTri(branch, facts)
      if (result === true) return true
      if (result === 'unknown') sawUnknown = true
    }
    return sawUnknown ? 'unknown' : false
  }
  const fact = facts[predicate.fact]
  if (fact === undefined || fact.status === 'unavailable') return 'unknown'
  const value = fact.value
  switch (predicate.op) {
    case 'eq': return value === predicate.value
    case 'neq': return value !== predicate.value
    case 'gte': return typeof value === 'number' && value >= predicate.value
    case 'lte': return typeof value === 'number' && value <= predicate.value
    case 'in': return predicate.values.includes(value)
  }
}

const BAND_RANK: Readonly<Record<EvidenceStrength, number>> = {
  direct: 3,
  corroborated: 2,
  weak: 1,
  indeterminate: 0,
}

/** A cap, not an assignment: suppression can only lower a band (finding L11). */
function capBand(band: EvidenceStrength, cap: EvidenceStrength): EvidenceStrength {
  return BAND_RANK[band] <= BAND_RANK[cap] ? band : cap
}

/** Packages already validated this process — validation executes fixtures, so run it once each. */
const validated = new WeakSet<object>()

export class InvalidRulePackageError extends Error {
  constructor(readonly ruleId: string, readonly violations: readonly { code: string; detail: string }[]) {
    super(
      `refusing to classify with invalid package ${ruleId}: ${violations
        .map((v) => v.code)
        .join(', ')}. The governance invariants hold at runtime, not only in the test suite.`,
    )
    this.name = 'InvalidRulePackageError'
  }
}

export function classify(params: {
  readonly facts: FactSet
  readonly packages: readonly RulePackage[]
  readonly contradictions: readonly Contradiction[]
  /** Episode time — rules are filtered to those effective then, so replay uses the rules of the day. */
  readonly at: string
  readonly factVocabularyVersion: string
}): ClassificationResult {
  // A malformed timestamp would silently drop every closed-window rule and keep every open one —
  // a plausible-looking classification from the wrong era (finding L13). Refuse instead.
  if (Number.isNaN(Date.parse(params.at))) {
    throw new Error(`classify() requires a parseable timestamp, got "${params.at}"`)
  }

  for (const rule of params.packages) {
    if (validated.has(rule)) continue
    const violations = validateRulePackage(rule)
    if (violations.length > 0) throw new InvalidRulePackageError(rule.id, violations)
    validated.add(rule)
  }

  const effective = params.packages.filter((rule) => isEffectiveAt(rule, params.at))

  // Two effective versions of one rule id would double-fire a hypothesis and misattribute its
  // priority factor (findings M18/L0). Overlapping windows are a governance defect; say so.
  const seenIds = new Set<string>()
  for (const rule of effective) {
    if (seenIds.has(rule.id)) {
      throw new Error(
        `two versions of ${rule.id} are simultaneously effective at ${params.at}: their ` +
          'governance windows overlap, which publication should have prevented',
      )
    }
    seenIds.add(rule.id)
  }

  interface FiredEntry {
    rule: RulePackage
    evidence: EvidenceItem
    counterevidence: CounterNote[]
    missingExpected: readonly string[]
    suppressedBy: HypothesisCode | null
  }

  const fired: FiredEntry[] = []
  const notApplicable: InapplicableRule[] = []
  const allMissing = new Set<string>()

  for (const rule of effective) {
    const outcome = evaluateRule(rule, params.facts)
    if (outcome.kind === 'fired') {
      fired.push({
        rule,
        evidence: outcome.evidence,
        counterevidence: [...outcome.counterevidence],
        missingExpected: outcome.missingExpected,
        suppressedBy: null,
      })
      outcome.missingExpected.forEach((name) => allMissing.add(name))
    } else if (outcome.kind === 'not_applicable') {
      notApplicable.push({
        code: rule.hypothesis,
        ruleId: rule.id,
        missingFacts: outcome.missingFacts,
      })
      outcome.missingFacts.forEach((name) => allMissing.add(name))
    } else {
      outcome.missingExpected.forEach((name) => allMissing.add(name))
    }
  }

  // Suppression, per fired entry. Direct evidence is never suppressed (§17.2): it gains a visible
  // note and loses nothing — not its band, not its urgency, not its priority factor.
  const firedCodes = new Set<HypothesisCode>(fired.map((f) => f.rule.hypothesis))

  for (const contradiction of params.contradictions) {
    if (!firedCodes.has(contradiction.suppressor) || !firedCodes.has(contradiction.suppressed)) {
      continue
    }

    const unlessResults = contradiction.unless.map((p) => predicateTri(p, params.facts))
    if (unlessResults.includes(true)) continue
    const unlessUnknown = unlessResults.includes('unknown')

    for (const entry of fired) {
      if (entry.rule.hypothesis !== contradiction.suppressed) continue

      if (entry.evidence.strength === 'direct') {
        entry.counterevidence.push({
          summary:
            `a ${contradiction.suppressor} incident is concurrently active; this direct signal ` +
            'is preserved and shown alongside it',
        })
        continue
      }

      if (unlessUnknown) {
        // The exception could not be read. Suppressing anyway would collapse "could not check"
        // into "checked and found false" — the inversion FR-CLS-006 forbids (finding M16).
        entry.counterevidence.push({
          summary:
            `suppression by ${contradiction.suppressor} withheld: its exception condition could ` +
            'not be evaluated from the available facts',
        })
        continue
      }

      entry.suppressedBy = contradiction.suppressor
      entry.counterevidence.push({ summary: `suppressed: ${contradiction.rationale}` })
    }
  }

  const hypotheses: ClassifiedHypothesis[] = fired.map((entry) => {
    let band: EvidenceStrength = entry.evidence.strength
    if (entry.suppressedBy !== null) band = capBand(band, 'weak')
    else if (band === 'corroborated' && entry.counterevidence.length > 0) band = 'weak'

    return {
      code: entry.rule.hypothesis,
      ruleId: entry.rule.id,
      ruleVersion: entry.rule.version,
      band,
      evidence: entry.evidence,
      counterevidence: entry.counterevidence,
      missingExpected: entry.missingExpected,
      humanReview: entry.rule.humanReview,
      suppressedBy: entry.suppressedBy,
    }
  })

  // Urgency, with valence. Evidence whose priority effect is 'lower' explains the gap — it argues
  // AGAINST dispatch, and cannot simultaneously corroborate a case for one. Only non-suppressed
  // 'raise' evidence reaches the shared FR-CLS-007 threshold.
  const admissible: EvidenceItem[] = []
  for (const [index, entry] of fired.entries()) {
    if (entry.suppressedBy !== null) continue
    if (entry.rule.priorityEffect.effect !== 'raise') continue
    admissible.push({ ...entry.evidence, strength: (hypotheses[index] as ClassifiedHypothesis).band })
  }
  const urgentEligible = canSupportUrgentAction(admissible)

  const priorityFactors: PriorityFactor[] = fired.map((entry) => ({
    factor: entry.rule.priorityEffect.factor,
    // A suppressed hypothesis no longer moves priority; the factor stays visible with no effect,
    // so the queue can show what was considered and set aside rather than hiding it.
    effect: entry.suppressedBy === null ? entry.rule.priorityEffect.effect : 'none',
    fromRule: entry.rule.id,
  }))

  const unknown =
    hypotheses.length === 0
      ? {
          code: 'H-UNKNOWN' as const,
          reason: 'evidence is missing, conflicting or below threshold',
          missingExpected: [...allMissing].sort(),
        }
      : null

  return {
    hypotheses,
    unknown,
    notApplicable,
    priorityFactors,
    urgentEligible,
    factVocabularyVersion: params.factVocabularyVersion,
  }
}

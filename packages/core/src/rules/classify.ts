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
 */

import { canSupportUrgentAction, type EvidenceItem, type EvidenceStrength } from '../evidence.js'
import type { FactSet } from './facts.js'
import {
  evaluateRule,
  isEffectiveAt,
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
  /** FR-CLS-007 via the shared evidence threshold: suppressed hypotheses cannot contribute. */
  readonly urgentEligible: boolean
  readonly factVocabularyVersion: string
}

function predicateHolds(predicate: Predicate, facts: FactSet): boolean {
  if ('anyOf' in predicate) return predicate.anyOf.some((p) => predicateHolds(p, facts))
  const fact = facts[predicate.fact]
  if (fact === undefined || fact.status === 'unavailable') return false
  const value = fact.value
  switch (predicate.op) {
    case 'eq': return value === predicate.value
    case 'neq': return value !== predicate.value
    case 'gte': return typeof value === 'number' && value >= predicate.value
    case 'lte': return typeof value === 'number' && value <= predicate.value
    case 'in': return predicate.values.includes(value)
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
  const effective = params.packages.filter((rule) => isEffectiveAt(rule, params.at))

  const fired: {
    rule: RulePackage
    evidence: EvidenceItem
    counterevidence: CounterNote[]
    missingExpected: readonly string[]
  }[] = []
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

  // Suppression. Direct evidence is never suppressed (§17.2): a source-wide incident earns a note
  // on a direct signal, and nothing more — the note is visible, the signal survives intact.
  const firedCodes = new Set<HypothesisCode>(fired.map((f) => f.rule.hypothesis))
  const suppression = new Map<HypothesisCode, HypothesisCode>()

  for (const contradiction of params.contradictions) {
    if (!firedCodes.has(contradiction.suppressor) || !firedCodes.has(contradiction.suppressed)) {
      continue
    }
    if (contradiction.unless.some((p) => predicateHolds(p, params.facts))) continue

    for (const entry of fired) {
      if (entry.rule.hypothesis !== contradiction.suppressed) continue
      if (entry.evidence.strength === 'direct') {
        entry.counterevidence.push({
          summary:
            `a ${contradiction.suppressor} incident is concurrently active; this direct signal ` +
            'is preserved and shown alongside it',
        })
      } else {
        suppression.set(contradiction.suppressed, contradiction.suppressor)
        entry.counterevidence.push({
          summary: `suppressed: ${contradiction.rationale}`,
        })
      }
    }
  }

  const hypotheses: ClassifiedHypothesis[] = fired.map((entry) => {
    const suppressedBy = suppression.get(entry.rule.hypothesis) ?? null

    // §8.2: corroborated requires material counterevidence to be absent. Direct is a statement
    // about the source's design, not about agreement, and stays direct.
    let band: EvidenceStrength = entry.evidence.strength
    if (suppressedBy !== null) band = 'weak'
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
      suppressedBy,
    }
  })

  // Urgent eligibility over the surviving evidence: a suppressed hypothesis cannot contribute,
  // and the shared threshold already refuses weak-only sets (FR-CLS-007) and cell priors.
  const admissible = hypotheses
    .filter((h) => h.suppressedBy === null)
    .map((h) => ({ ...h.evidence, strength: h.band }))
  const urgentEligible = canSupportUrgentAction(admissible)

  const priorityFactors: PriorityFactor[] = hypotheses.map((h) => {
    const rule = effective.find((r) => r.id === h.ruleId) as RulePackage
    return {
      factor: rule.priorityEffect.factor,
      // A suppressed hypothesis no longer moves priority; the factor stays visible with no effect,
      // so the queue can show what was considered and set aside rather than hiding it.
      effect: h.suppressedBy === null ? rule.priorityEffect.effect : 'none',
      fromRule: rule.id,
    }
  })

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

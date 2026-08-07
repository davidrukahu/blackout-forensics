// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Classification diff — the artefact a rule-change approver actually signs.
 *
 * Ticket 37: per-rule fixtures prove a rule does what its author claims; they cannot catch what the
 * author did not think of, which is where real regressions live. Publication therefore runs the full
 * rule set over the labelled corpus and diffs every classification against the previous published
 * version. The approver signs off on the list of changed classifications — and §15.5's "regression
 * in a published rule without approved explanation" becomes mechanical: an unexplained change is a
 * failing gate, not a judgement call.
 */

import type { ClassificationResult } from './classify.js'

/** One scenario's classification, reduced to what an approver compares. */
export interface ClassificationSummary {
  readonly fired: readonly string[]
  readonly bands: Readonly<Record<string, string>>
  readonly suppressed: readonly string[]
  readonly unknown: boolean
  readonly urgentEligible: boolean
}

export type ClassificationSnapshot = Readonly<Record<string, ClassificationSummary>>

export function summariseClassification(result: ClassificationResult): ClassificationSummary {
  const bands: Record<string, string> = {}
  for (const h of result.hypotheses) bands[h.code] = h.band
  return {
    fired: result.hypotheses.map((h) => h.code).sort(),
    bands,
    suppressed: result.hypotheses
      .filter((h) => h.suppressedBy !== null)
      .map((h) => h.code)
      .sort(),
    unknown: result.unknown !== null,
    urgentEligible: result.urgentEligible,
  }
}

export interface ClassificationChange {
  readonly scenario: string
  readonly kind: 'added' | 'removed' | 'changed'
  readonly before: ClassificationSummary | null
  readonly after: ClassificationSummary | null
}

/**
 * Every scenario whose classification differs between two published states.
 *
 * Symmetric and total: a scenario that vanished from the corpus is a change too, because a
 * regression can hide as easily in a deleted case as in an altered one.
 */
export function diffClassifications(
  before: ClassificationSnapshot,
  after: ClassificationSnapshot,
): ClassificationChange[] {
  const changes: ClassificationChange[] = []
  const scenarios = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()

  for (const scenario of scenarios) {
    const b = before[scenario] ?? null
    const a = after[scenario] ?? null
    if (b === null) changes.push({ scenario, kind: 'added', before: null, after: a })
    else if (a === null) changes.push({ scenario, kind: 'removed', before: b, after: null })
    else if (JSON.stringify(b) !== JSON.stringify(a)) {
      changes.push({ scenario, kind: 'changed', before: b, after: a })
    }
  }
  return changes
}

// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Evidence primitives shared by classification, cells and reporting.
 *
 * Extracted from the OpenCellID module when the rule engine landed, because ticket 37 requires the
 * rule vocabulary to fold these in rather than duplicate them — two definitions of "corroborated"
 * would eventually disagree, and the disagreement would surface as an urgent case that one path
 * allows and another forbids.
 */

export type EvidenceStrength = 'direct' | 'corroborated' | 'weak' | 'indeterminate'

/** Independent families of evidence. Two facts from one family are not corroboration. */
export type EvidenceFamily =
  | 'device_signal'
  | 'platform_health'
  | 'peer_devices'
  | 'route_history'
  | 'reviewed_outcome'
  | 'policy_match'
  | 'cell_prior'

export interface EvidenceItem {
  readonly family: EvidenceFamily
  readonly strength: EvidenceStrength
  readonly summary: string
}

/**
 * Whether an evidence set can support an urgent, field-affecting action.
 *
 * FR-CLS-007 requires direct evidence, or corroboration across independent families. The rule is
 * written so that cell evidence cannot contribute to the threshold at all — not weighted low, but
 * excluded — because a weight can always be tuned upward by someone who wants a case to clear the
 * bar, and the whole point is that it must not be tunable.
 */
export function canSupportUrgentAction(evidence: readonly EvidenceItem[]): boolean {
  const admissible = evidence.filter((e) => e.family !== 'cell_prior')

  if (admissible.some((e) => e.strength === 'direct')) return true

  const corroboratingFamilies = new Set(
    admissible.filter((e) => e.strength === 'corroborated').map((e) => e.family),
  )
  return corroboratingFamilies.size >= 2
}

export interface ActionabilityExplanation {
  readonly actionable: boolean
  readonly reason: string
  /** Evidence that counted, and evidence that was present but could not count. */
  readonly counted: readonly EvidenceItem[]
  readonly excluded: readonly EvidenceItem[]
}

/** The same decision, with its reasoning — what the UI must show rather than a bare verdict. */
export function explainActionability(
  evidence: readonly EvidenceItem[],
): ActionabilityExplanation {
  const counted = evidence.filter((e) => e.family !== 'cell_prior')
  const excluded = evidence.filter((e) => e.family === 'cell_prior')
  const actionable = canSupportUrgentAction(evidence)

  const direct = counted.filter((e) => e.strength === 'direct')
  const families = new Set(counted.filter((e) => e.strength === 'corroborated').map((e) => e.family))

  const reason = actionable
    ? direct.length > 0
      ? `direct evidence from ${direct[0]!.family}`
      : `corroborated across ${families.size} independent evidence families`
    : excluded.length > 0
      ? 'no direct or independently corroborated evidence; a cell prior is present but is context ' +
        'only and cannot meet the threshold on its own'
      : 'no direct or independently corroborated evidence'

  return { actionable, reason, counted, excluded }
}

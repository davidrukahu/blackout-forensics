// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OpenCellID as optional weak context.
 *
 * Two requirements govern this module, and both exist because cell data invites exactly the wrong
 * inference:
 *
 *   * **FR-CLS-005** — OpenCellID is weak context unless customer telemetry corroborates it, and
 *     removing it entirely must not turn an unsupported case into an actionable one.
 *   * **FR-CLS-006** — the absence of an OpenCellID record is *no evidence*, not evidence of no
 *     coverage. The database is a volunteer-contributed sample; a cell nobody has driven past is
 *     missing from it, and a cell that does not exist is also missing from it. Nothing distinguishes
 *     those two cases, so neither may be asserted.
 *
 * PRD §2.1 states the underlying limits plainly: coordinates are averaged from reception
 * measurements and are not precise, and one physical tower can contain several logical cells. A cell
 * record therefore locates *where a device was heard from*, approximately, and never the device.
 */

export type EvidenceStrength = 'direct' | 'corroborated' | 'weak' | 'indeterminate'

/** Independent families of evidence. Two facts from one family are not corroboration. */
export type EvidenceFamily =
  | 'device_signal'
  | 'platform_health'
  | 'peer_devices'
  | 'route_history'
  | 'reviewed_outcome'
  | 'cell_prior'

export interface EvidenceItem {
  readonly family: EvidenceFamily
  readonly strength: EvidenceStrength
  readonly summary: string
}

export interface CellKey {
  readonly mcc: number
  readonly mnc: number
  readonly lac: number
  readonly cellId: number
}

export interface CellRecord extends CellKey {
  readonly lat: number
  readonly lon: number
  readonly rangeM: number | null
  readonly samples: number | null
}

/**
 * The result of a lookup.
 *
 * `no_record` is deliberately not an error and deliberately not an empty success: it is a distinct
 * state that downstream code must handle as *unknown*. Collapsing it into "not found, therefore no
 * coverage" is the single most likely misuse of this data.
 */
export type CellLookupResult =
  | { readonly status: 'found'; readonly record: CellRecord; readonly snapshotId: string }
  | { readonly status: 'no_record'; readonly key: CellKey }
  | { readonly status: 'layer_disabled' }

export interface CellLookup {
  find(key: CellKey): Promise<CellLookupResult>
}

/** The layer is optional and off unless a snapshot has been activated. */
export class DisabledCellLookup implements CellLookup {
  async find(): Promise<CellLookupResult> {
    return { status: 'layer_disabled' }
  }
}

export const OPENCELLID_ATTRIBUTION = '© OpenCellID contributors, licensed under CC BY-SA 4.0'

export type CellAcquisition = 'self_hosted_download' | 'commercial_provider' | 'community_api'

export class ForbiddenAcquisitionError extends Error {
  constructor(readonly acquisition: string) {
    super(
      `refusing to use OpenCellID via "${acquisition}": the community API is not permitted for ` +
        'commercial production without contributing data or being whitelisted, and access may be ' +
        'withdrawn at any time. Use a self-hosted snapshot or a commercial provider.',
    )
    this.name = 'ForbiddenAcquisitionError'
  }
}

/** Acquisition routes permitted in production. */
export function assertAcquisitionPermitted(acquisition: CellAcquisition): void {
  if (acquisition === 'community_api') throw new ForbiddenAcquisitionError(acquisition)
}

/**
 * Turn a lookup into evidence.
 *
 * A found record is always `weak`, never more — no amount of sample count promotes it, because the
 * limit is what the measurement *is*, not how many times it was taken. A missing record produces no
 * evidence item at all rather than a negative one.
 */
export function cellEvidenceFrom(result: CellLookupResult): EvidenceItem | undefined {
  if (result.status !== 'found') return undefined
  return {
    family: 'cell_prior',
    strength: 'weak',
    summary:
      `serving cell has a community-contributed location prior within ` +
      `${result.record.rangeM ?? 'an unstated'} m, averaged from reception measurements`,
  }
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

/**
 * How a missing record must be described.
 *
 * Provided as a function so the wording is not left to whoever writes the UI: "no coverage" and
 * "not in the database" are different claims, and only one of them is supportable.
 */
export function describeAbsence(result: CellLookupResult): string {
  switch (result.status) {
    case 'no_record':
      return (
        'no community-contributed record exists for this cell. This says nothing about whether ' +
        'coverage existed: the database is a volunteer-contributed sample, and an unvisited cell ' +
        'and a non-existent cell are indistinguishable in it.'
      )
    case 'layer_disabled':
      return 'the optional cell layer is not enabled for this tenant.'
    case 'found':
      return 'a record exists.'
  }
}

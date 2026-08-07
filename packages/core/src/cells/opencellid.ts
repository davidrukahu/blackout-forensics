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

// Evidence primitives moved to ../evidence.ts when the rule engine landed — ticket 37 requires the
// rule vocabulary to fold these in rather than duplicate them. Re-exported here so existing
// importers keep working; the definitions live in one place.
export {
  canSupportUrgentAction,
  explainActionability,
} from '../evidence.js'
export type {
  ActionabilityExplanation,
  EvidenceFamily,
  EvidenceItem,
  EvidenceStrength,
} from '../evidence.js'
import type { EvidenceItem as _EvidenceItem } from '../evidence.js'

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
export function cellEvidenceFrom(result: CellLookupResult): _EvidenceItem | undefined {
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

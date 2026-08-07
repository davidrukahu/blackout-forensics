// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The review queue, PRD §9.2 and FR-QUE-001, as a domain model the UI renders but never decides.
 *
 * Three commitments live here rather than in the screen:
 *
 *   * **No borrower identity.** A queue item is built from episode, classification and assignment
 *     data only — the type has no field a borrower name could occupy, so the screen cannot leak
 *     what the model never carries.
 *   * **No hidden score** (§5.3). Priority is a tier computed from named factors, each shown with
 *     the direction it pushed. The computation is these factors and nothing else; a factor that
 *     is not in the list did not contribute.
 *   * **Optimistic assignment with conflict detection** (§9.2). Assignment carries the version the
 *     assigner saw. A version mismatch returns the conflicting state for the UI to re-render —
 *     never a silent overwrite of a colleague's claim.
 */

import type { EvidenceStrength } from '../evidence.js'
import type { ClassificationResult, PriorityFactor } from '../rules/classify.js'
import { currentVersion, type Episode } from '../episodes/lifecycle.js'

/** §9.2's queue buckets. `overdue` is a due-state, not a lifecycle state — it can overlay any. */
export type QueueBucket = 'provisional' | 'awaiting_data' | 'review_required' | 'classified'

export type DueState = 'not_due' | 'due' | 'overdue'

export type PriorityTier = 'urgent' | 'elevated' | 'routine'

export interface QueuePriority {
  readonly tier: PriorityTier
  /** Every factor that was considered, with its direction — the §5.3 "no hidden score" contract. */
  readonly factors: readonly PriorityFactor[]
  /** The single sentence the queue row shows. Derived from the factors, never free-typed. */
  readonly reason: string
}

export interface QueueItem {
  readonly episodeId: string
  /** Asset reference only — never a borrower name, phone or account (FR-QUE-001). */
  readonly assetRef: string
  readonly deviceRef: string
  readonly bucket: QueueBucket
  readonly episodeType: string
  readonly startAt: string
  readonly ageS: number
  readonly priority: QueuePriority
  /** Highest unsuppressed evidence band, or null when the classification is unknown. */
  readonly band: EvidenceStrength | null
  /** The last observation that survives quality checks — what an analyst may rely on. */
  readonly lastDefensibleObservationAt: string | null
  readonly source: string
  readonly owner: string | null
  /** Optimistic-concurrency token. Any mutation must present the version it saw. */
  readonly version: number
  readonly dueAt: string
  readonly dueState: DueState
  /** Data-quality warnings the analyst must see before relying on the row (§9.2). */
  readonly warnings: readonly string[]
}

export interface QueuePolicy {
  /** Review due this long after an episode opens, by tier. */
  readonly dueAfterS: Readonly<Record<PriorityTier, number>>
  /** How far past due before a row is overdue rather than merely due. */
  readonly overdueGraceS: number
}

export const DEFAULT_QUEUE_POLICY: QueuePolicy = {
  dueAfterS: { urgent: 2 * 3600, elevated: 8 * 3600, routine: 24 * 3600 },
  overdueGraceS: 3600,
}

const BAND_RANK: Readonly<Record<EvidenceStrength, number>> = {
  direct: 3,
  corroborated: 2,
  weak: 1,
  indeterminate: 0,
}

/** §5.3: the tier follows mechanically from the named factors. Nothing else may move it. */
export function computePriority(
  classification: ClassificationResult,
  ageS: number,
  policy: QueuePolicy,
): QueuePriority {
  const factors: PriorityFactor[] = [...classification.priorityFactors]

  if (classification.urgentEligible) {
    factors.push({ factor: 'urgent_eligible_evidence', effect: 'raise', fromRule: 'evidence_threshold' })
  }
  if (classification.unknown !== null) {
    factors.push({ factor: 'classification_unknown', effect: 'none', fromRule: 'queue_policy' })
  }
  if (ageS > policy.dueAfterS.routine) {
    factors.push({ factor: 'episode_age_exceeds_routine_window', effect: 'raise', fromRule: 'queue_policy' })
  }

  const raises = factors.filter((f) => f.effect === 'raise')
  const tier: PriorityTier = classification.urgentEligible
    ? 'urgent'
    : raises.length > 0
      ? 'elevated'
      : 'routine'

  const reason =
    raises.length > 0
      ? `${tier}: ${raises.map((f) => f.factor.replaceAll('_', ' ')).join('; ')}`
      : `routine: no factor raised priority (${factors.length} considered)`

  return { tier, factors, reason }
}

export function dueStateFor(
  dueAt: string,
  now: string,
  policy: QueuePolicy,
): DueState {
  const overBy = Date.parse(now) - Date.parse(dueAt)
  if (overBy <= 0) return 'not_due'
  return overBy > policy.overdueGraceS * 1000 ? 'overdue' : 'due'
}

function bucketFor(episode: Episode): QueueBucket {
  const state = currentVersion(episode).state
  switch (state) {
    case 'provisional':
      return 'provisional'
    case 'monitoring':
      return 'awaiting_data'
    case 'review_required':
      return 'review_required'
    default:
      return 'classified'
  }
}

export interface BuildQueueItemInput {
  readonly episode: Episode
  readonly classification: ClassificationResult
  readonly source: string
  readonly assetRef: string
  readonly lastDefensibleObservationAt: string | null
  readonly owner: string | null
  readonly version: number
  readonly warnings?: readonly string[]
  readonly now: string
  readonly policy?: QueuePolicy
}

export function buildQueueItem(input: BuildQueueItemInput): QueueItem {
  const { episode, classification, now } = input
  const policy = input.policy ?? DEFAULT_QUEUE_POLICY
  const current = currentVersion(episode)
  const ageS = Math.max(0, Math.round((Date.parse(now) - Date.parse(current.startAt)) / 1000))

  const priority = computePriority(classification, ageS, policy)

  const unsuppressed = classification.hypotheses.filter((h) => h.suppressedBy === null)
  const band =
    unsuppressed.length === 0
      ? null
      : unsuppressed.reduce((best, h) => (BAND_RANK[h.band] > BAND_RANK[best] ? h.band : best), unsuppressed[0]!.band)

  const warnings = [...(input.warnings ?? [])]
  if (current.clockBasis === 'received_at') {
    warnings.push('boundaries rest on receipt time: the device clock was unusable')
  }
  if (classification.unknown !== null) {
    warnings.push(`classification is unknown: ${classification.unknown.reason}`)
  }

  const dueAt = new Date(
    Date.parse(current.startAt) + policy.dueAfterS[priority.tier] * 1000,
  ).toISOString()

  return {
    episodeId: episode.id,
    assetRef: input.assetRef,
    deviceRef: episode.deviceRef,
    bucket: bucketFor(episode),
    episodeType: current.type,
    startAt: current.startAt,
    ageS,
    priority,
    band,
    lastDefensibleObservationAt: input.lastDefensibleObservationAt,
    source: input.source,
    owner: input.owner,
    version: input.version,
    dueAt,
    dueState: dueStateFor(dueAt, now, policy),
    warnings,
  }
}

// ------------------------------------------------------------------ optimistic assignment

export type AssignmentOutcome =
  | { readonly kind: 'assigned'; readonly owner: string; readonly version: number }
  | {
      /** The row moved under the assigner. Their view is re-rendered with the current state. */
      readonly kind: 'conflict'
      readonly currentOwner: string | null
      readonly currentVersion: number
    }

export function assign(
  current: { readonly owner: string | null; readonly version: number },
  request: { readonly owner: string; readonly expectedVersion: number },
): AssignmentOutcome {
  if (request.expectedVersion !== current.version) {
    return { kind: 'conflict', currentOwner: current.owner, currentVersion: current.version }
  }
  return { kind: 'assigned', owner: request.owner, version: current.version + 1 }
}

// ------------------------------------------------------------------ bulk actions

/** The only actions §9.2 allows in bulk: low-impact, reversible, no evidentiary consequence. */
export const BULK_ACTIONS = ['assign_owner', 'add_note'] as const
export type BulkAction = (typeof BULK_ACTIONS)[number]

export interface BulkRefusal {
  readonly episodeId: string
  readonly reason: string
}

/**
 * Bulk eligibility is per-row and deny-by-default: an action outside the allowlist, an urgent
 * row, or a row with direct evidence is refused individually, and the refusals are returned so
 * the analyst sees exactly which rows were excluded and why — a bulk action that silently skips
 * rows teaches analysts the checkbox lies.
 */
export function checkBulk(
  action: string,
  items: readonly QueueItem[],
): { readonly eligible: readonly QueueItem[]; readonly refused: readonly BulkRefusal[] } {
  if (!(BULK_ACTIONS as readonly string[]).includes(action)) {
    return {
      eligible: [],
      refused: items.map((item) => ({
        episodeId: item.episodeId,
        reason: `"${action}" is not a low-impact bulk action`,
      })),
    }
  }

  const eligible: QueueItem[] = []
  const refused: BulkRefusal[] = []
  for (const item of items) {
    if (item.priority.tier === 'urgent') {
      refused.push({ episodeId: item.episodeId, reason: 'urgent rows require individual review' })
    } else if (item.band === 'direct') {
      refused.push({ episodeId: item.episodeId, reason: 'direct evidence requires individual review' })
    } else {
      eligible.push(item)
    }
  }
  return { eligible, refused }
}

// ------------------------------------------------------------------ saved views

export interface SavedView {
  readonly id: string
  readonly name: string
  readonly filters: {
    readonly bucket?: QueueBucket
    readonly dueState?: DueState
    readonly tier?: PriorityTier
    readonly owner?: string | null
    readonly source?: string
  }
  readonly sort: 'due_first' | 'newest' | 'oldest'
}

/** Views every deployment starts with. Analysts can add their own; these cannot be deleted. */
export const BUILTIN_VIEWS: readonly SavedView[] = [
  { id: 'view-due', name: 'Due and overdue', filters: { dueState: 'overdue' }, sort: 'due_first' },
  { id: 'view-review', name: 'Review required', filters: { bucket: 'review_required' }, sort: 'due_first' },
  { id: 'view-unowned', name: 'Unassigned', filters: { owner: null }, sort: 'oldest' },
  { id: 'view-urgent', name: 'Urgent tier', filters: { tier: 'urgent' }, sort: 'oldest' },
]

export function applyView(view: SavedView, items: readonly QueueItem[]): QueueItem[] {
  const { filters } = view
  const filtered = items.filter((item) => {
    if (filters.bucket !== undefined && item.bucket !== filters.bucket) return false
    if (filters.tier !== undefined && item.priority.tier !== filters.tier) return false
    if (filters.source !== undefined && item.source !== filters.source) return false
    if (filters.owner !== undefined && item.owner !== filters.owner) return false
    if (filters.dueState === 'overdue' && item.dueState === 'not_due') return false
    if (filters.dueState === 'due' && item.dueState !== 'due') return false
    if (filters.dueState === 'not_due' && item.dueState !== 'not_due') return false
    return true
  })

  const bySort: Record<SavedView['sort'], (a: QueueItem, b: QueueItem) => number> = {
    due_first: (a, b) => a.dueAt.localeCompare(b.dueAt) || a.episodeId.localeCompare(b.episodeId),
    newest: (a, b) => b.startAt.localeCompare(a.startAt) || a.episodeId.localeCompare(b.episodeId),
    oldest: (a, b) => a.startAt.localeCompare(b.startAt) || a.episodeId.localeCompare(b.episodeId),
  }
  return filtered.sort(bySort[view.sort])
}

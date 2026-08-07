// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Episode lifecycle and revisions.
 *
 * Implements PRD §5.2's state machine and FR-EPI-003/004/006, on top of the six decisions in the
 * watermark model. The governing principle from that decision runs through everything here:
 * **late data produces the same result as timely data**. The outcome depends on what the records
 * say, not on when they happened to arrive — which is what makes replay meaningful and what lets a
 * vendor be told "no, we would not have called this two incidents if your platform had been faster".
 *
 * Every version is appended, never mutated. §7.3 makes reviewer decisions immutable and corrections
 * additive, so an episode is its history rather than its current row.
 */

import type { EpisodeType } from './sampler.js'

export type EpisodeState =
  | 'provisional'
  | 'monitoring'
  | 'review_required'
  | 'classified'
  | 'action_open'
  | 'resolved'
  | 'retracted'

/**
 * Permitted transitions, straight from PRD §5.2.
 *
 * `resolved` and `retracted` lead only to `classified` — that edge is the "controlled reopening"
 * §5.2 names, and it is the only way back out of a terminal state.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<EpisodeState, readonly EpisodeState[]>> = {
  provisional: ['monitoring', 'review_required', 'retracted'],
  monitoring: ['review_required', 'classified', 'retracted'],
  review_required: ['classified', 'monitoring', 'retracted'],
  classified: ['action_open', 'resolved', 'classified'],
  action_open: ['resolved', 'classified'],
  resolved: ['classified'],
  retracted: ['classified'],
}

export type RevisionCause =
  | 'opened'
  | 'evidence_updated'
  | 'late_data_closed'
  | 'late_data_retracted'
  | 'late_data_split'
  | 'human_decision'
  | 'controlled_reopening'

export interface EpisodeVersion {
  readonly version: number
  readonly state: EpisodeState
  readonly type: EpisodeType
  readonly startAt: string
  /** Null while the episode is still open. */
  readonly endAt: string | null
  readonly cause: RevisionCause
  /** Every transition records actor, time and reason (PRD §5.2). */
  readonly actor: string
  readonly reason: string
  readonly at: string
  /** The version this one supersedes, so a history is a chain rather than a set. */
  readonly supersedes: number | null
  readonly clockBasis: 'device_time' | 'received_at'
  readonly policyVersion: string
}

export interface RecordedAction {
  readonly kind: 'field_verification' | 'vendor_ticket' | 'escalation'
  readonly at: string
  readonly reference: string
}

export interface Episode {
  readonly id: string
  readonly deviceRef: string
  readonly versions: readonly EpisodeVersion[]
  /** Actions taken in the world. Their existence changes how revisions are governed. */
  readonly actions: readonly RecordedAction[]
  /** When this episode stops being freely revisable. */
  readonly finalisationWatermarkAt: string
}

export const currentVersion = (episode: Episode): EpisodeVersion =>
  episode.versions[episode.versions.length - 1] as EpisodeVersion

export const currentState = (episode: Episode): EpisodeState => currentVersion(episode).state

export class IllegalTransitionError extends Error {
  constructor(readonly from: EpisodeState, readonly to: EpisodeState) {
    super(
      `illegal transition ${from} → ${to}: PRD §5.2 does not permit it. A state machine that can be ` +
        'talked into any transition is documentation, not a control.',
    )
    this.name = 'IllegalTransitionError'
  }
}

export class ApprovalRequiredError extends Error {
  constructor(readonly episodeId: string, readonly actionCount: number) {
    super(
      `episode ${episodeId} is finalised and has ${actionCount} recorded action(s): revision ` +
        'requires controlled reopening. Silently rewriting it would rewrite the justification for ' +
        'something that already happened in the world.',
    )
    this.name = 'ApprovalRequiredError'
  }
}

/** Past the finalisation watermark, an episode stops being freely revisable. */
export function isFinalised(episode: Episode, now: string): boolean {
  return Date.parse(now) >= Date.parse(episode.finalisationWatermarkAt)
}

/**
 * Whether a revision needs approval.
 *
 * Gated on whether anything happened in the world, not on elapsed time. A retraction nobody acted on
 * is the record becoming more accurate; requiring approval for that manufactures a queue of
 * rubber-stamps and devalues the control where it matters.
 */
export function requiresApproval(episode: Episode, now: string): boolean {
  return isFinalised(episode, now) && episode.actions.length > 0
}

export interface TransitionRequest {
  readonly to: EpisodeState
  readonly cause: RevisionCause
  readonly actor: string
  readonly reason: string
  readonly at: string
  readonly type?: EpisodeType
  readonly endAt?: string | null
  /** Set when the caller holds an approval for a controlled reopening. */
  readonly approvedBy?: string
}

/**
 * Append a new version.
 *
 * Throws rather than returning a result: an illegal transition or an unapproved revision is a
 * programming error or a bypass attempt, and both should stop the caller rather than be handled.
 */
export function transition(episode: Episode, request: TransitionRequest, now: string): Episode {
  const from = currentState(episode)

  if (!ALLOWED_TRANSITIONS[from].includes(request.to)) {
    throw new IllegalTransitionError(from, request.to)
  }

  if (requiresApproval(episode, now) && request.approvedBy === undefined) {
    throw new ApprovalRequiredError(episode.id, episode.actions.length)
  }

  const previous = currentVersion(episode)
  const next: EpisodeVersion = {
    version: previous.version + 1,
    state: request.to,
    type: request.type ?? previous.type,
    startAt: previous.startAt,
    endAt: request.endAt === undefined ? previous.endAt : request.endAt,
    cause: request.approvedBy !== undefined ? 'controlled_reopening' : request.cause,
    actor: request.approvedBy ?? request.actor,
    reason: request.approvedBy !== undefined
      ? `${request.reason} (controlled reopening approved by ${request.approvedBy})`
      : request.reason,
    at: request.at,
    supersedes: previous.version,
    clockBasis: previous.clockBasis,
    policyVersion: previous.policyVersion,
  }

  return { ...episode, versions: [...episode.versions, next] }
}

// ---------------------------------------------------------------- late data

export interface LateReport {
  readonly at: string
  /** A report that fails quality checks cannot confirm recovery. */
  readonly valid: boolean
}

export interface ConfirmationPolicy {
  /** Reports required before an episode may close. */
  readonly requiredReports: number
  /** The expected reporting interval in force, in seconds. */
  readonly expectedIntervalS: number
}

/**
 * Whether a run of reports demonstrates recovery.
 *
 * Both conditions, because either alone is gameable. A device that dumps its buffer and dies again
 * satisfies a count; a lone straggler at each end satisfies a duration. Requiring the reports to
 * span a full expected interval means the device has shown it is reporting *on policy* again.
 */
export function confirmsRecovery(
  reports: readonly LateReport[],
  policy: ConfirmationPolicy,
): boolean {
  const valid = reports.filter((r) => r.valid).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  if (valid.length < policy.requiredReports) return false

  const first = valid[0] as LateReport
  const last = valid[valid.length - 1] as LateReport
  const spanS = (Date.parse(last.at) - Date.parse(first.at)) / 1000
  return spanS >= policy.expectedIntervalS
}

export type LateDataOutcome =
  | { readonly kind: 'no_change'; readonly reason: string }
  | { readonly kind: 'closed'; readonly endAt: string }
  | { readonly kind: 'retracted'; readonly reason: string }
  | { readonly kind: 'split'; readonly atStart: string; readonly atEnd: string }
  | { readonly kind: 'annotated'; readonly reason: string }

/**
 * Decide what late data does to an episode.
 *
 * The split rule is the same confirmation rule used for closing — deliberately, so the two cannot
 * drift apart and start disagreeing. An interruption splits the episode if and only if it would have
 * closed the episode had it arrived on time.
 */
export function evaluateLateData(
  episode: Episode,
  reports: readonly LateReport[],
  policy: ConfirmationPolicy,
): LateDataOutcome {
  const version = currentVersion(episode)
  const gapStart = Date.parse(version.startAt)
  const gapEnd = version.endAt === null ? Number.POSITIVE_INFINITY : Date.parse(version.endAt)

  const inside = reports
    .filter((r) => {
      const t = Date.parse(r.at)
      return t > gapStart && t < gapEnd
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))

  if (inside.length === 0) {
    const after = reports.filter((r) => Date.parse(r.at) >= gapEnd)
    if (after.length > 0 && confirmsRecovery(after, policy)) {
      const firstValid = after.filter((r) => r.valid)[0]
      // endAt is the first confirming report, never the moment confirmation completed: otherwise
      // every duration is inflated by the confirmation window.
      return { kind: 'closed', endAt: (firstValid ?? after[0] as LateReport).at }
    }
    return { kind: 'no_change', reason: 'no late records fall inside or after this episode' }
  }

  // Records covering the whole gap mean the gap never happened.
  const coversStart = Date.parse((inside[0] as LateReport).at) - gapStart
  if (confirmsRecovery(inside, policy) && coversStart < policy.expectedIntervalS * 1000) {
    return { kind: 'retracted', reason: 'buffered records show the device was reporting throughout' }
  }

  if (confirmsRecovery(inside, policy)) {
    return {
      kind: 'split',
      atStart: (inside[0] as LateReport).at,
      atEnd: (inside[inside.length - 1] as LateReport).at,
    }
  }

  return {
    kind: 'annotated',
    reason:
      `${inside.length} late record(s) fall inside the gap but do not satisfy the confirmation ` +
      'policy, so the episode is annotated rather than split — the same rule that governs closing',
  }
}

/**
 * Apply an outcome, producing the next version(s).
 *
 * A split produces two episodes and marks the original superseded rather than mutating it, so the
 * lineage of a report that counted one incident stays reconstructible.
 */
export function applyLateData(
  episode: Episode,
  outcome: LateDataOutcome,
  context: { actor: string; at: string; now: string; approvedBy?: string },
): { episodes: Episode[]; changed: boolean } {
  const approval = context.approvedBy !== undefined ? { approvedBy: context.approvedBy } : {}

  switch (outcome.kind) {
    case 'no_change':
    case 'annotated':
      return { episodes: [episode], changed: false }

    case 'closed':
      return {
        episodes: [
          transition(episode, {
            to: 'classified', cause: 'late_data_closed', actor: context.actor,
            reason: 'late records confirm recovery', at: context.at, endAt: outcome.endAt,
            ...approval,
          }, context.now),
        ],
        changed: true,
      }

    case 'retracted':
      return {
        episodes: [
          transition(episode, {
            to: 'retracted', cause: 'late_data_retracted', actor: context.actor,
            reason: outcome.reason, at: context.at, ...approval,
          }, context.now),
        ],
        changed: true,
      }

    case 'split': {
      const version = currentVersion(episode)
      const superseded = transition(episode, {
        to: 'retracted', cause: 'late_data_split', actor: context.actor,
        reason: 'superseded by two episodes after late records confirmed recovery mid-gap',
        at: context.at, endAt: outcome.atStart, ...approval,
      }, context.now)

      const before: Episode = {
        ...episode,
        id: `${episode.id}-a`,
        actions: [],
        versions: [{
          ...version, version: 1, endAt: outcome.atStart, supersedes: null,
          cause: 'late_data_split', actor: context.actor,
          reason: `first half of ${episode.id}`, at: context.at,
        }],
      }
      const after: Episode = {
        ...episode,
        id: `${episode.id}-b`,
        actions: [],
        versions: [{
          ...version, version: 1, startAt: outcome.atEnd, supersedes: null,
          cause: 'late_data_split', actor: context.actor,
          reason: `second half of ${episode.id}`, at: context.at,
        }],
      }
      return { episodes: [superseded, before, after], changed: true }
    }
  }
}

/** Open a new episode at the action deadline — provisional until the watermark passes. */
export function openEpisode(params: {
  id: string
  deviceRef: string
  type: EpisodeType
  startAt: string
  actor: string
  reason: string
  at: string
  clockBasis: 'device_time' | 'received_at'
  policyVersion: string
  finalisationWatermarkAt: string
}): Episode {
  return {
    id: params.id,
    deviceRef: params.deviceRef,
    actions: [],
    finalisationWatermarkAt: params.finalisationWatermarkAt,
    versions: [{
      version: 1,
      state: 'provisional',
      type: params.type,
      startAt: params.startAt,
      endAt: null,
      cause: 'opened',
      actor: params.actor,
      reason: params.reason,
      at: params.at,
      supersedes: null,
      clockBasis: params.clockBasis,
      policyVersion: params.policyVersion,
    }],
  }
}

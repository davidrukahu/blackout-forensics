// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Controlled decisions with maker-checker — PRD §9.4, FR-QUE-005/006, §3.3.
 *
 * The control lives here, in the domain, because that is the only place it cannot be bypassed
 * from: the UI, the API and replay all reach an applied decision through `approveProposal`, and
 * there is no other exported path that produces one. Three hard rules:
 *
 *   * **Reasons are canonical.** A decision carries one of its declared reasons, verbatim.
 *     Free-text explains; it never substitutes. A reason vocabulary that can be bypassed with
 *     prose is a taxonomy, not a control.
 *   * **The proposer cannot approve** (FR-QUE-005, §3.3) — compared on actor identity, checked at
 *     approval time, no override parameter.
 *   * **No machine path to the world** (FR-QUE-006). A machine suggestion is rendered advice; it
 *     is not a proposal, the types do not convert, and a world-affecting decision demands a human
 *     proposal and a different human's approval. There is no automatic transition from hypothesis
 *     to repossession or immobilization because no function composes one.
 *
 * The two §15.2 edge cases are modelled as version guards: a proposal records the episode
 * version count its proposer was looking at (stale-UI), and approval re-checks it against the
 * episode now (race with a concurrent revision) — a mismatch supersedes the proposal rather than
 * applying a decision to a case that no longer says what the proposer saw.
 */

import { currentVersion, transition, type Episode, type EpisodeState } from '../episodes/lifecycle.js'

export interface DecisionDefinition {
  readonly id: string
  readonly label: string
  readonly transitionTo: EpisodeState
  /** The closed reason vocabulary for this decision. */
  readonly canonicalReasons: readonly string[]
  /**
   * High-impact decisions demand maker-checker. World-affecting ones (anything that could lead
   * to recovery action against the asset) additionally refuse machine origin outright.
   */
  readonly highImpact: boolean
  readonly worldAffecting: boolean
}

/** §9.4's decision set. Configuration can extend reasons; the flags are not configurable down. */
export const DECISIONS: readonly DecisionDefinition[] = [
  {
    id: 'classify_explained',
    label: 'Classify as explained (no further action)',
    transitionTo: 'classified',
    canonicalReasons: [
      'documented sleep matches the gap',
      'approved maintenance window covers the gap',
      'source outage explains the gap',
      'device fault confirmed by pattern',
      'late data closed the gap',
    ],
    highImpact: false,
    worldAffecting: false,
  },
  {
    id: 'classify_suspicious',
    label: 'Classify as suspicious (evidence supports interference)',
    transitionTo: 'classified',
    canonicalReasons: [
      'device telemetry supports possible tracker interference',
      'power removed without documented cause',
      'corroborated multi-family evidence with no benign explanation',
    ],
    highImpact: true,
    worldAffecting: false,
  },
  {
    id: 'retract',
    label: 'Retract (the gap never happened)',
    transitionTo: 'retracted',
    canonicalReasons: [
      'buffered records show continuous reporting',
      'episode opened on a policy misconfiguration',
      'duplicate of another episode',
    ],
    highImpact: false,
    worldAffecting: false,
  },
  {
    id: 'authorize_field_verification',
    label: 'Authorize field verification',
    transitionTo: 'action_open',
    canonicalReasons: [
      'urgent-eligible evidence requires physical verification',
      'repeated qualified corridor recurrence',
    ],
    highImpact: true,
    worldAffecting: true,
  },
  {
    id: 'authorize_recovery_action',
    label: 'Authorize recovery action',
    transitionTo: 'action_open',
    canonicalReasons: [
      'direct evidence with completed review and verified location',
      'contractual default confirmed with evidence pack attached',
    ],
    highImpact: true,
    worldAffecting: true,
  },
] as const

/** §9.4's three voices. A suggestion never becomes a proposal by casting; it is rendered advice. */
export interface MachineSuggestion {
  readonly kind: 'machine_suggestion'
  readonly decisionId: string
  readonly basis: string
}

export interface DecisionProposal {
  readonly kind: 'human_proposal'
  readonly id: string
  readonly episodeId: string
  readonly decisionId: string
  readonly reason: string
  readonly note: string | null
  readonly proposedBy: string
  readonly proposedAt: string
  /** Episode version count the proposer was looking at — the stale-UI guard. */
  readonly basisVersionCount: number
  readonly status: 'proposed' | 'approved' | 'rejected' | 'superseded'
  readonly resolvedBy: string | null
  readonly resolvedAt: string | null
}

export class UnknownDecisionError extends Error {
  constructor(readonly decisionId: string) {
    super(`no decision "${decisionId}" exists`)
    this.name = 'UnknownDecisionError'
  }
}

export class NonCanonicalReasonError extends Error {
  constructor(readonly decisionId: string, readonly reason: string) {
    super(
      `"${reason}" is not a canonical reason for ${decisionId}. Free text explains; it never ` +
        'substitutes for the controlled vocabulary.',
    )
    this.name = 'NonCanonicalReasonError'
  }
}

export class StaleBasisError extends Error {
  constructor() {
    super(
      'the episode has been revised since this screen was loaded: re-read the case before ' +
        'proposing. A decision made on a stale view is a decision about a different case.',
    )
    this.name = 'StaleBasisError'
  }
}

export class SelfApprovalError extends Error {
  constructor(readonly actor: string) {
    super(
      `${actor} proposed this decision and cannot approve it (§3.3). There is no override: the ` +
        'second person is the control.',
    )
    this.name = 'SelfApprovalError'
  }
}

export class MachineOriginError extends Error {
  constructor() {
    super(
      'a machine suggestion cannot be proposed or approved as a decision (FR-QUE-006). A human ' +
        'must propose, and a different human must approve.',
    )
    this.name = 'MachineOriginError'
  }
}

export class ProposalNotPendingError extends Error {
  constructor(readonly status: DecisionProposal['status']) {
    super(`this proposal is already ${status}; it cannot be resolved twice`)
    this.name = 'ProposalNotPendingError'
  }
}

export function decisionById(decisionId: string): DecisionDefinition {
  const decision = DECISIONS.find((d) => d.id === decisionId)
  if (decision === undefined) throw new UnknownDecisionError(decisionId)
  return decision
}

/**
 * Machine suggestions from a classification — rendered advice, clearly labelled, and never
 * world-affecting: the machine may suggest an explanation, never an action against the asset.
 */
export function suggestFor(params: {
  readonly firedCodes: readonly string[]
  readonly unknown: boolean
}): MachineSuggestion[] {
  const suggestions: MachineSuggestion[] = []
  if (params.firedCodes.includes('H-EXPECTED')) {
    suggestions.push({
      kind: 'machine_suggestion',
      decisionId: 'classify_explained',
      basis: 'H-EXPECTED fired: the effective policy predicts this silence',
    })
  }
  if (params.firedCodes.includes('H-VENDOR') || params.firedCodes.includes('H-NETWORK')) {
    suggestions.push({
      kind: 'machine_suggestion',
      decisionId: 'classify_explained',
      basis: 'a source-level cluster explains the gap without device-level cause',
    })
  }
  // Deliberately absent: any suggestion whose decision is worldAffecting. The list above is the
  // whole machine vocabulary, and the test suite pins it.
  return suggestions.filter((s) => !decisionById(s.decisionId).worldAffecting)
}

export function propose(params: {
  readonly episode: Episode
  readonly decisionId: string
  readonly reason: string
  readonly note?: string
  readonly proposedBy: string
  readonly at: string
  /** Version count of the episode as rendered to the proposer. */
  readonly seenVersionCount: number
  readonly proposalId: string
}): DecisionProposal {
  const decision = decisionById(params.decisionId)
  if (!decision.canonicalReasons.includes(params.reason)) {
    throw new NonCanonicalReasonError(decision.id, params.reason)
  }
  if (params.seenVersionCount !== params.episode.versions.length) {
    throw new StaleBasisError()
  }
  return {
    kind: 'human_proposal',
    id: params.proposalId,
    episodeId: params.episode.id,
    decisionId: decision.id,
    reason: params.reason,
    note: params.note ?? null,
    proposedBy: params.proposedBy,
    proposedAt: params.at,
    basisVersionCount: params.seenVersionCount,
    status: 'proposed',
    resolvedBy: null,
    resolvedAt: null,
  }
}

export type ApprovalOutcome =
  | { readonly kind: 'applied'; readonly episode: Episode; readonly proposal: DecisionProposal }
  | {
      /** The episode was revised after the proposal: the proposal is superseded, nothing applied. */
      readonly kind: 'superseded'
      readonly proposal: DecisionProposal
    }

/**
 * The only path from a proposal to an applied decision.
 *
 * Low-impact decisions may be approved by their proposer (there is nothing to check); high-impact
 * ones must not be. The version guard supersedes rather than applies when the episode moved —
 * the §15.2 race resolved in favour of re-reading, never in favour of the stale click.
 */
export function approveProposal(params: {
  readonly episode: Episode
  readonly proposal: DecisionProposal | MachineSuggestion
  readonly approvedBy: string
  readonly at: string
  readonly now: string
}): ApprovalOutcome {
  const { proposal } = params
  if (proposal.kind !== 'human_proposal') {
    throw new MachineOriginError()
  }
  if (proposal.status !== 'proposed') {
    throw new ProposalNotPendingError(proposal.status)
  }

  const decision = decisionById(proposal.decisionId)
  if (decision.highImpact && params.approvedBy === proposal.proposedBy) {
    throw new SelfApprovalError(params.approvedBy)
  }

  if (params.episode.versions.length !== proposal.basisVersionCount) {
    return {
      kind: 'superseded',
      proposal: { ...proposal, status: 'superseded', resolvedBy: params.approvedBy, resolvedAt: params.at },
    }
  }

  const episode = transition(
    params.episode,
    {
      to: decision.transitionTo,
      cause: 'human_decision',
      actor: proposal.proposedBy,
      reason: `${decision.label}: ${proposal.reason}${proposal.note === null ? '' : ` — ${proposal.note}`}`,
      at: params.at,
      ...(decision.highImpact ? { approvedBy: params.approvedBy } : {}),
    },
    params.now,
  )

  return {
    kind: 'applied',
    episode,
    proposal: { ...proposal, status: 'approved', resolvedBy: params.approvedBy, resolvedAt: params.at },
  }
}

export function rejectProposal(params: {
  readonly proposal: DecisionProposal
  readonly rejectedBy: string
  readonly at: string
}): DecisionProposal {
  if (params.proposal.status !== 'proposed') {
    throw new ProposalNotPendingError(params.proposal.status)
  }
  return {
    ...params.proposal,
    status: 'rejected',
    resolvedBy: params.rejectedBy,
    resolvedAt: params.at,
  }
}

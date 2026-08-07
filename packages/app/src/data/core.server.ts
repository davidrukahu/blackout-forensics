// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Single import surface for the domain core.
 *
 * Every route and data function imports the domain through this file, so what the app depends on
 * is visible in one place — and so the "UI renders, the domain decides" boundary has an address.
 */

export {
  ALLOWED_TRANSITIONS,
  BUILTIN_VIEWS,
  DECISIONS,
  MachineOriginError,
  NonCanonicalReasonError,
  ProposalNotPendingError,
  SelfApprovalError,
  StaleBasisError,
  UnknownDecisionError,
  approveProposal,
  decisionById,
  propose,
  rejectProposal,
  suggestFor,
  BULK_ACTIONS,
  CONTRADICTIONS,
  CORPUS_POLICY,
  DEFAULT_QUEUE_POLICY,
  FACT_VOCABULARY_VERSION,
  RULE_PACKAGES,
  applyView,
  assign,
  buildQueueItem,
  checkBulk,
  classify,
  computePriority,
  correlate,
  currentEpisodeVersion,
  expectedNextReport,
  projectCorridor,
  factsForScenario,
  openEpisode,
  sampleEpisodes,
  transition,
} from '@blackout/core'
export type {
  BulkRefusal,
  DecisionDefinition,
  DecisionProposal,
  MachineSuggestion,
  ClassificationResult,
  CorrelationCandidate,
  CorridorResult,
  Episode,
  PeerCluster,
  QueueItem,
  RoadGraph,
  SamplerEvent,
  SavedView,
} from '@blackout/core'

export interface AppAuditEvent {
  readonly actor: string
  readonly action: string
  readonly at: string
  readonly detail: Record<string, unknown>
}

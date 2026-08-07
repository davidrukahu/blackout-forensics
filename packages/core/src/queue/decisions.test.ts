// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Maker-checker where it cannot be bypassed: the domain.
 *
 * §17.4 says the control must hold through UI, API and replay. All three reach an applied
 * decision through `approveProposal`; these tests pin that path's refusals — self-approval,
 * machine origin, non-canonical reasons, the stale-UI guard, and the propose/approve race —
 * so any caller inherits them.
 */

import { describe, expect, it } from 'vitest'

import { openEpisode, transition, currentState } from '../episodes/lifecycle.js'
import {
  DECISIONS,
  MachineOriginError,
  NonCanonicalReasonError,
  ProposalNotPendingError,
  SelfApprovalError,
  StaleBasisError,
  approveProposal,
  decisionById,
  propose,
  rejectProposal,
  suggestFor,
} from './decisions.js'

const T0 = '2026-08-05T08:00:00.000Z'
const T1 = '2026-08-05T09:00:00.000Z'
const T2 = '2026-08-05T10:00:00.000Z'

function reviewableEpisode() {
  const opened = openEpisode({
    id: 'ep-mc', deviceRef: 'dev-1', type: 'total_silence', startAt: T0,
    actor: 'system:sampler', reason: 'expected report missed', at: T0,
    clockBasis: 'device_time', policyVersion: 'policy-1',
    finalisationWatermarkAt: '2026-09-01T00:00:00.000Z',
  })
  const monitoring = transition(opened, {
    to: 'monitoring', cause: 'evidence_updated', actor: 'system', reason: 'confirmed open', at: T0,
  }, T0)
  return transition(monitoring, {
    to: 'review_required', cause: 'evidence_updated', actor: 'system:classifier',
    reason: 'hypotheses fired', at: T1,
  }, T1)
}

const classifySuspicious = (episode = reviewableEpisode()) =>
  propose({
    episode,
    decisionId: 'classify_suspicious',
    reason: 'device telemetry supports possible tracker interference',
    proposedBy: 'analyst-a',
    at: T1,
    seenVersionCount: episode.versions.length,
    proposalId: 'prop-1',
  })

describe('canonical reasons', () => {
  it('every decision declares a non-empty closed vocabulary', () => {
    for (const decision of DECISIONS) {
      expect(decision.canonicalReasons.length).toBeGreaterThan(0)
    }
  })

  it('a reason outside the vocabulary is refused, however plausible', () => {
    expect(() =>
      propose({
        episode: reviewableEpisode(),
        decisionId: 'classify_suspicious',
        reason: 'looks like tampering to me',
        proposedBy: 'analyst-a',
        at: T1,
        seenVersionCount: 3,
        proposalId: 'p',
      }),
    ).toThrow(NonCanonicalReasonError)
  })

  it('world-affecting decisions are all high-impact — the flags cannot diverge', () => {
    for (const decision of DECISIONS.filter((d) => d.worldAffecting)) {
      expect(decision.highImpact).toBe(true)
    }
  })
})

describe('§9.4: the three voices are distinct types', () => {
  it('machine suggestions never include a world-affecting decision', () => {
    const suggestions = suggestFor({
      firedCodes: ['H-EXPECTED', 'H-VENDOR', 'H-NETWORK', 'H-TAMPER', 'H-POWER'],
      unknown: false,
    })
    expect(suggestions.length).toBeGreaterThan(0)
    for (const suggestion of suggestions) {
      expect(decisionById(suggestion.decisionId).worldAffecting).toBe(false)
      expect(suggestion.kind).toBe('machine_suggestion')
    }
  })

  it('FR-QUE-006: a machine suggestion handed to approval is refused on type, not on luck', () => {
    expect(() =>
      approveProposal({
        episode: reviewableEpisode(),
        proposal: {
          kind: 'machine_suggestion',
          decisionId: 'authorize_recovery_action',
          basis: 'forged',
        },
        approvedBy: 'supervisor-1',
        at: T2,
        now: T2,
      }),
    ).toThrow(MachineOriginError)
  })
})

describe('FR-QUE-005 / §3.3: the proposer cannot approve', () => {
  it('self-approval of a high-impact decision throws, with no override parameter to find', () => {
    const episode = reviewableEpisode()
    const proposal = classifySuspicious(episode)
    expect(() =>
      approveProposal({ episode, proposal, approvedBy: 'analyst-a', at: T2, now: T2 }),
    ).toThrow(SelfApprovalError)
  })

  it('a different approver applies it, recording both people', () => {
    const episode = reviewableEpisode()
    const proposal = classifySuspicious(episode)
    const outcome = approveProposal({
      episode, proposal, approvedBy: 'supervisor-1', at: T2, now: T2,
    })
    expect(outcome.kind).toBe('applied')
    if (outcome.kind === 'applied') {
      expect(currentState(outcome.episode)).toBe('classified')
      const version = outcome.episode.versions.at(-1)!
      expect(version.actor).toBe('analyst-a')
      expect(version.reason).toContain('approved by supervisor-1')
      expect(version.cause).toBe('human_decision')
      expect(outcome.proposal.status).toBe('approved')
    }
  })

  it('a low-impact decision needs no second person — rubber stamps devalue the control', () => {
    const episode = reviewableEpisode()
    const proposal = propose({
      episode,
      decisionId: 'retract',
      reason: 'buffered records show continuous reporting',
      proposedBy: 'analyst-a',
      at: T1,
      seenVersionCount: episode.versions.length,
      proposalId: 'prop-2',
    })
    const outcome = approveProposal({
      episode, proposal, approvedBy: 'analyst-a', at: T2, now: T2,
    })
    expect(outcome.kind).toBe('applied')
  })
})

describe('§15.2: stale UI and the propose/approve race', () => {
  it('proposing from a stale screen is refused before it exists', () => {
    const episode = reviewableEpisode()
    expect(() =>
      propose({
        episode,
        decisionId: 'retract',
        reason: 'duplicate of another episode',
        proposedBy: 'analyst-a',
        at: T1,
        seenVersionCount: episode.versions.length - 1,
        proposalId: 'p',
      }),
    ).toThrow(StaleBasisError)
  })

  it('an episode revised between propose and approve supersedes the proposal — nothing applies', () => {
    const episode = reviewableEpisode()
    const proposal = classifySuspicious(episode)
    // Late data revises the episode while the proposal sits in the checker's queue.
    const revised = transition(episode, {
      to: 'monitoring', cause: 'evidence_updated', actor: 'system:late-data',
      reason: 'late records arrived', at: T2,
    }, T2)
    const outcome = approveProposal({
      episode: revised, proposal, approvedBy: 'supervisor-1', at: T2, now: T2,
    })
    expect(outcome.kind).toBe('superseded')
    if (outcome.kind === 'superseded') {
      expect(outcome.proposal.status).toBe('superseded')
    }
  })

  it('a resolved proposal cannot be resolved again — the double-click and the second approver', () => {
    const episode = reviewableEpisode()
    const proposal = classifySuspicious(episode)
    const outcome = approveProposal({
      episode, proposal, approvedBy: 'supervisor-1', at: T2, now: T2,
    })
    expect(outcome.kind).toBe('applied')
    if (outcome.kind === 'applied') {
      expect(() =>
        approveProposal({
          episode: outcome.episode, proposal: outcome.proposal,
          approvedBy: 'supervisor-2', at: T2, now: T2,
        }),
      ).toThrow(ProposalNotPendingError)
      expect(() =>
        rejectProposal({ proposal: outcome.proposal, rejectedBy: 'supervisor-2', at: T2 }),
      ).toThrow(ProposalNotPendingError)
    }
  })

  it('rejection resolves without touching the episode', () => {
    const episode = reviewableEpisode()
    const proposal = classifySuspicious(episode)
    const rejected = rejectProposal({ proposal, rejectedBy: 'supervisor-1', at: T2 })
    expect(rejected.status).toBe('rejected')
    expect(episode.versions.length).toBe(3)
  })
})

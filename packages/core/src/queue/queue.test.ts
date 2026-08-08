// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The queue domain model: §9.2, §5.3 and FR-QUE-001 pinned where the UI cannot unpin them.
 */

import { describe, expect, it } from 'vitest'

import type { ClassificationResult } from '../rules/classify.js'
import { openEpisode, transition } from '../episodes/lifecycle.js'
import {
  BUILTIN_VIEWS,
  DEFAULT_QUEUE_POLICY,
  applyView,
  assign,
  buildQueueItem,
  checkBulk,
  computePriority,
  dueStateFor,
  type QueueItem,
} from './queue.js'

const NOW = '2026-08-05T10:00:00.000Z'

const unknownClassification: ClassificationResult = {
  hypotheses: [],
  unknown: { code: 'H-UNKNOWN', reason: 'no rule fired', missingExpected: ['power.cut_alert_present'] },
  notApplicable: [],
  priorityFactors: [],
  urgentEligible: false,
  factVocabularyVersion: '1.0.0',
}

const firedClassification = (overrides?: Partial<ClassificationResult>): ClassificationResult => ({
  hypotheses: [
    {
      code: 'H-POWER',
      ruleId: 'rule.h-power.direct-signal',
      ruleVersion: '1.1.0',
      band: 'direct',
      evidence: { family: 'device_signal', strength: 'direct', summary: 'power-cut alert present' },
      counterevidence: [],
      missingExpected: [],
      humanReview: true,
      suppressedBy: null,
    },
  ],
  unknown: null,
  notApplicable: [],
  priorityFactors: [{ factor: 'external_power_lost', effect: 'raise', fromRule: 'rule.h-power.direct-signal' }],
  urgentEligible: true,
  factVocabularyVersion: '1.0.0',
  ...overrides,
})

function episodeAt(startAt: string, id = 'ep-1') {
  return openEpisode({
    id, deviceRef: 'dev-1', type: 'total_silence', startAt,
    actor: 'system:sampler', reason: 'expected report missed', at: startAt,
    clockBasis: 'device_time', policyVersion: 'policy-1',
    finalisationWatermarkAt: '2026-09-01T00:00:00.000Z',
  })
}

function item(overrides?: Partial<Parameters<typeof buildQueueItem>[0]>): QueueItem {
  return buildQueueItem({
    episode: episodeAt('2026-08-05T08:00:00.000Z'),
    classification: unknownClassification,
    source: 'traccar_forwarder',
    assetRef: 'ast-0001',
    lastDefensibleObservationAt: '2026-08-05T07:59:00.000Z',
    owner: null,
    version: 1,
    now: NOW,
    ...overrides,
  })
}

describe('FR-QUE-001: the row carries what the PRD names, and cannot carry a borrower', () => {
  it('builds every named column', () => {
    const row = item()
    expect(row.assetRef).toBe('ast-0001')
    expect(row.ageS).toBe(7200)
    expect(row.band).toBeNull()
    expect(row.lastDefensibleObservationAt).toBe('2026-08-05T07:59:00.000Z')
    expect(row.source).toBe('traccar_forwarder')
    expect(row.owner).toBeNull()
    expect(row.dueState).toBe('not_due')
    expect(row.priority.reason).toContain('routine')
  })

  it('the type has no borrower-shaped field at all', () => {
    // Structural proof: serialize a row and scan its keys. The screen renders keys; a key that
    // does not exist cannot be rendered.
    const keys = JSON.stringify(Object.keys(item()))
    expect(keys).not.toMatch(/borrower|customer|name|phone|msisdn|account/i)
  })
})

describe('§5.3: priority is named factors, never a hidden score', () => {
  it('urgent-eligible evidence produces the urgent tier, with the factor visible', () => {
    const priority = computePriority(firedClassification(), 100, DEFAULT_QUEUE_POLICY)
    expect(priority.tier).toBe('urgent')
    expect(priority.factors.map((f) => f.factor)).toContain('urgent_eligible_evidence')
    expect(priority.reason).toContain('urgent')
  })

  it('a raise without urgency elevates; nothing raised stays routine and says so', () => {
    const elevated = computePriority(
      firedClassification({
        urgentEligible: false,
        priorityFactors: [{ factor: 'peer_corroboration', effect: 'raise', fromRule: 'rule.x' }],
      }),
      100,
      DEFAULT_QUEUE_POLICY,
    )
    expect(elevated.tier).toBe('elevated')
    expect(elevated.reason).toContain('peer corroboration')

    const routine = computePriority(unknownClassification, 100, DEFAULT_QUEUE_POLICY)
    expect(routine.tier).toBe('routine')
    expect(routine.reason).toContain('no factor increased the priority')
  })

  it('age past the routine window is itself a named factor, not a silent bump', () => {
    const priority = computePriority(
      unknownClassification,
      DEFAULT_QUEUE_POLICY.dueAfterS.routine + 1,
      DEFAULT_QUEUE_POLICY,
    )
    expect(priority.tier).toBe('elevated')
    expect(priority.factors.map((f) => f.factor)).toContain('episode_age_exceeds_routine_window')
  })
})

describe('buckets and due state', () => {
  it('maps lifecycle states to the §9.2 buckets', () => {
    const provisional = item()
    expect(provisional.bucket).toBe('provisional')

    const monitoring = transition(episodeAt('2026-08-05T08:00:00.000Z'), {
      to: 'monitoring', cause: 'evidence_updated', actor: 'a', reason: 'confirmed open',
      at: '2026-08-05T08:10:00.000Z',
    }, '2026-08-05T08:10:00.000Z')
    expect(item({ episode: monitoring }).bucket).toBe('awaiting_data')

    const review = transition(monitoring, {
      to: 'review_required', cause: 'evidence_updated', actor: 'a', reason: 'rule fired',
      at: '2026-08-05T08:20:00.000Z',
    }, '2026-08-05T08:20:00.000Z')
    expect(item({ episode: review }).bucket).toBe('review_required')
  })

  it('due, then overdue after the grace window — three distinct states', () => {
    const dueAt = '2026-08-05T09:00:00.000Z'
    expect(dueStateFor(dueAt, '2026-08-05T08:59:00.000Z', DEFAULT_QUEUE_POLICY)).toBe('not_due')
    expect(dueStateFor(dueAt, '2026-08-05T09:30:00.000Z', DEFAULT_QUEUE_POLICY)).toBe('due')
    expect(dueStateFor(dueAt, '2026-08-05T10:01:00.000Z', DEFAULT_QUEUE_POLICY)).toBe('overdue')
  })

  it('an urgent row comes due sooner than a routine one — the tier drives the clock', () => {
    const urgent = item({ classification: firedClassification() })
    const routine = item()
    expect(Date.parse(urgent.dueAt)).toBeLessThan(Date.parse(routine.dueAt))
  })
})

describe('data-quality warnings', () => {
  it('receipt-time boundaries and unknown classifications are flagged on the row', () => {
    const receiptBased = openEpisode({
      id: 'ep-r', deviceRef: 'dev-1', type: 'total_silence', startAt: '2026-08-05T08:00:00.000Z',
      actor: 'system:sampler', reason: 'expected report missed', at: '2026-08-05T08:00:00.000Z',
      clockBasis: 'received_at', policyVersion: 'policy-1',
      finalisationWatermarkAt: '2026-09-01T00:00:00.000Z',
    })
    const row = item({ episode: receiptBased })
    expect(row.warnings.some((w) => w.includes('receipt time'))).toBe(true)
    expect(row.warnings.some((w) => w.includes('unknown'))).toBe(true)
  })
})

describe('§9.2: optimistic assignment with conflict detection', () => {
  it('assigns when the expected version matches, bumping the version', () => {
    expect(assign({ owner: null, version: 3 }, { owner: 'analyst-a', expectedVersion: 3 })).toEqual({
      kind: 'assigned', owner: 'analyst-a', version: 4,
    })
  })

  it('a stale version returns the conflicting state — never a silent overwrite', () => {
    const outcome = assign(
      { owner: 'analyst-b', version: 4 },
      { owner: 'analyst-a', expectedVersion: 3 },
    )
    expect(outcome).toEqual({ kind: 'conflict', currentOwner: 'analyst-b', currentVersion: 4 })
  })
})

describe('§9.2: bulk actions are low-impact only, refusals shown per row', () => {
  it('refuses an action outside the allowlist for every row', () => {
    const { eligible, refused } = checkBulk('classify', [item(), item()])
    expect(eligible).toEqual([])
    expect(refused).toHaveLength(2)
    expect(refused[0]!.reason).toContain('not approved for bulk use')
  })

  it('excludes urgent and direct-evidence rows individually, with reasons', () => {
    const urgent = item({ classification: firedClassification() })
    const routine = item({ episode: episodeAt('2026-08-05T08:00:00.000Z', 'ep-2') })
    const { eligible, refused } = checkBulk('assign_owner', [urgent, routine])
    expect(eligible.map((i) => i.episodeId)).toEqual(['ep-2'])
    expect(refused).toEqual([
      { episodeId: 'ep-1', reason: 'You must review urgent rows one at a time.' },
    ])
  })
})

describe('saved views', () => {
  const rows = [
    // 29h old: the age factor elevates it, the elevated window (8h) makes it long overdue.
    item({ episode: episodeAt('2026-08-04T05:00:00.000Z', 'ep-old') }),
    item({ episode: episodeAt('2026-08-05T09:40:00.000Z', 'ep-new') }),
    item({ episode: episodeAt('2026-08-05T09:00:00.000Z', 'ep-owned'), owner: 'analyst-a' }),
  ]

  it('the built-in unassigned view filters on null owner, oldest first', () => {
    const view = BUILTIN_VIEWS.find((v) => v.id === 'view-unowned')!
    expect(applyView(view, rows).map((r) => r.episodeId)).toEqual(['ep-old', 'ep-new'])
  })

  it('the due view surfaces only rows past due', () => {
    const view = BUILTIN_VIEWS.find((v) => v.id === 'view-due')!
    expect(applyView(view, rows).map((r) => r.episodeId)).toEqual(['ep-old'])
  })

  it('filtering never mutates the input', () => {
    const before = rows.map((r) => r.episodeId)
    applyView(BUILTIN_VIEWS[0]!, rows)
    expect(rows.map((r) => r.episodeId)).toEqual(before)
  })
})

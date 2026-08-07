// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  ALLOWED_TRANSITIONS,
  ApprovalRequiredError,
  IllegalTransitionError,
  applyLateData,
  confirmsRecovery,
  currentState,
  currentVersion,
  evaluateLateData,
  isFinalised,
  openEpisode,
  requiresApproval,
  transition,
  type Episode,
  type EpisodeState,
  type LateReport,
} from './lifecycle.js'

const WATERMARK = '2026-08-05T12:00:00.000Z'
const BEFORE_WATERMARK = '2026-08-05T08:00:00.000Z'
const AFTER_WATERMARK = '2026-08-05T18:00:00.000Z'

const POLICY = { requiredReports: 2, expectedIntervalS: 60 }

const episode = (overrides: Partial<Episode> = {}): Episode => ({
  ...openEpisode({
    id: 'ep_1',
    deviceRef: 'dev_1',
    type: 'total_silence',
    startAt: '2026-08-05T06:00:00.000Z',
    actor: 'episode_worker',
    reason: 'expected report deadline passed',
    at: '2026-08-05T06:02:00.000Z',
    clockBasis: 'device_time',
    policyVersion: '1.0.0',
    finalisationWatermarkAt: WATERMARK,
  }),
  ...overrides,
})

const report = (at: string, valid = true): LateReport => ({ at, valid })

describe('the state machine is a control, not documentation', () => {
  it('opens provisional', () => {
    const e = episode()
    expect(currentState(e)).toBe('provisional')
    expect(currentVersion(e).version).toBe(1)
    expect(currentVersion(e).supersedes).toBeNull()
  })

  it('permits only the transitions PRD §5.2 lists', () => {
    const all: EpisodeState[] = [
      'provisional', 'monitoring', 'review_required', 'classified', 'action_open', 'resolved',
      'retracted',
    ]
    for (const from of all) {
      for (const to of all) {
        const permitted = ALLOWED_TRANSITIONS[from].includes(to)
        const e: Episode = {
          ...episode(),
          versions: [{ ...currentVersion(episode()), state: from }],
        }
        const attempt = (): Episode =>
          transition(e, {
            to, cause: 'human_decision', actor: 'analyst', reason: 'test',
            at: BEFORE_WATERMARK,
          }, BEFORE_WATERMARK)

        if (permitted) expect(attempt, `${from} → ${to}`).not.toThrow()
        else expect(attempt, `${from} → ${to}`).toThrow(IllegalTransitionError)
      }
    }
  })

  it('records actor, time, reason and the version superseded on every transition', () => {
    const e = transition(episode(), {
      to: 'review_required', cause: 'evidence_updated', actor: 'analyst_7',
      reason: 'power-cut alert present', at: BEFORE_WATERMARK,
    }, BEFORE_WATERMARK)

    const v = currentVersion(e)
    expect(v.version).toBe(2)
    expect(v.supersedes).toBe(1)
    expect(v.actor).toBe('analyst_7')
    expect(v.reason).toContain('power-cut')
    expect(v.at).toBe(BEFORE_WATERMARK)
  })

  it('appends versions and never mutates one', () => {
    const first = episode()
    const second = transition(first, {
      to: 'monitoring', cause: 'evidence_updated', actor: 'w', reason: 'awaiting data',
      at: BEFORE_WATERMARK,
    }, BEFORE_WATERMARK)

    expect(first.versions).toHaveLength(1)
    expect(second.versions).toHaveLength(2)
    expect(JSON.stringify(second.versions[0])).toBe(JSON.stringify(first.versions[0]))
  })

  it('carries the clock basis and policy version forward, so replay stays reproducible', () => {
    const e = transition(episode(), {
      to: 'monitoring', cause: 'evidence_updated', actor: 'w', reason: 'r', at: BEFORE_WATERMARK,
    }, BEFORE_WATERMARK)
    expect(currentVersion(e).clockBasis).toBe('device_time')
    expect(currentVersion(e).policyVersion).toBe('1.0.0')
  })
})

describe('revision is gated on action, not on elapsed time', () => {
  it('revises freely before the watermark, even with actions recorded', () => {
    const e = episode({ actions: [{ kind: 'vendor_ticket', at: BEFORE_WATERMARK, reference: 'T-1' }] })
    expect(requiresApproval(e, BEFORE_WATERMARK)).toBe(false)
    expect(() => transition(e, {
      to: 'retracted', cause: 'late_data_retracted', actor: 'w', reason: 'r', at: BEFORE_WATERMARK,
    }, BEFORE_WATERMARK)).not.toThrow()
  })

  it('revises freely after the watermark when nothing was acted on', () => {
    // A retraction nobody acted on is the record becoming more accurate. Requiring approval for it
    // manufactures rubber-stamps and devalues the control where it matters.
    const e = episode()
    expect(isFinalised(e, AFTER_WATERMARK)).toBe(true)
    expect(requiresApproval(e, AFTER_WATERMARK)).toBe(false)
  })

  it('requires approval after the watermark once an action exists', () => {
    // Silently retracting would rewrite the justification for something that already happened in
    // the world: a technician was sent, a rider was approached.
    const e = episode({
      actions: [{ kind: 'field_verification', at: BEFORE_WATERMARK, reference: 'FV-9' }],
    })
    expect(requiresApproval(e, AFTER_WATERMARK)).toBe(true)
    // A legal target, so the approval gate is what fails rather than the legality check — the
    // legality check runs first by design, since an illegal transition is a programming error.
    expect(() => transition(e, {
      to: 'retracted', cause: 'late_data_retracted', actor: 'w', reason: 'r', at: AFTER_WATERMARK,
    }, AFTER_WATERMARK)).toThrow(ApprovalRequiredError)
  })

  it('permits the same revision with an approval, keeping its true cause and recording both people', () => {
    const e = episode({
      actions: [{ kind: 'escalation', at: BEFORE_WATERMARK, reference: 'ESC-3' }],
    })
    const revised = transition(e, {
      to: 'retracted', cause: 'late_data_retracted', actor: 'worker',
      reason: 'buffered records arrived', at: AFTER_WATERMARK, approvedBy: 'supervisor_2',
    }, AFTER_WATERMARK)

    // "Controlled reopening" names the terminal edge (§5.2). An approved revision elsewhere
    // keeps the cause that actually produced it — relabelling would misdescribe the record —
    // and the approval is carried in the reason.
    const v = currentVersion(revised)
    expect(v.cause).toBe('late_data_retracted')
    expect(v.actor).toBe('worker')
    expect(v.reason).toContain('approved by supervisor_2')
  })

  it('records the terminal edge itself as a controlled reopening', () => {
    const e = episode({
      actions: [{ kind: 'escalation', at: BEFORE_WATERMARK, reference: 'ESC-3' }],
    })
    const retracted = transition(e, {
      to: 'retracted', cause: 'late_data_retracted', actor: 'worker',
      reason: 'buffered records arrived', at: AFTER_WATERMARK, approvedBy: 'supervisor_2',
    }, AFTER_WATERMARK)
    const reopened = transition(retracted, {
      to: 'classified', cause: 'human_decision', actor: 'worker',
      reason: 'new evidence reopens the case', at: AFTER_WATERMARK, approvedBy: 'supervisor_2',
    }, AFTER_WATERMARK)

    const v = currentVersion(reopened)
    expect(v.cause).toBe('controlled_reopening')
    expect(v.actor).toBe('supervisor_2')
    expect(v.reason).toContain('controlled reopening approved by supervisor_2')
  })
})

describe('confirmation needs count and duration', () => {
  it('accepts reports that meet both', () => {
    expect(confirmsRecovery(
      [report('2026-08-05T07:00:00.000Z'), report('2026-08-05T07:01:30.000Z')],
      POLICY,
    )).toBe(true)
  })

  it('rejects a buffer dump — many reports, no elapsed time', () => {
    expect(confirmsRecovery(
      [
        report('2026-08-05T07:00:00.000Z'),
        report('2026-08-05T07:00:01.000Z'),
        report('2026-08-05T07:00:02.000Z'),
      ],
      POLICY,
    )).toBe(false)
  })

  it('rejects a lone straggler — time elapsed, too few reports', () => {
    expect(confirmsRecovery([report('2026-08-05T07:00:00.000Z')], POLICY)).toBe(false)
  })

  it('ignores reports that fail quality checks', () => {
    expect(confirmsRecovery(
      [report('2026-08-05T07:00:00.000Z'), report('2026-08-05T07:05:00.000Z', false)],
      POLICY,
    )).toBe(false)
  })
})

describe('late data produces the same result as timely data', () => {
  it('closes on confirming reports after the gap, dated at the first of them', () => {
    // endAt is the first confirming report, not the moment confirmation completed — otherwise every
    // duration is inflated by the confirmation window.
    const e = { ...episode(), versions: [{ ...currentVersion(episode()), endAt: '2026-08-05T06:30:00.000Z' }] }
    const outcome = evaluateLateData(e, [
      report('2026-08-05T06:30:00.000Z'),
      report('2026-08-05T06:32:00.000Z'),
    ], POLICY)

    expect(outcome).toEqual({ kind: 'closed', endAt: '2026-08-05T06:30:00.000Z' })
  })

  it('retracts when buffered records cover the gap from its start', () => {
    const e = episode()
    const outcome = evaluateLateData(e, [
      report('2026-08-05T06:00:30.000Z'),
      report('2026-08-05T06:02:00.000Z'),
      report('2026-08-05T06:03:00.000Z'),
    ], POLICY)

    expect(outcome.kind).toBe('retracted')
  })

  it('splits when a mid-gap interruption would have closed the episode on time', () => {
    const e = {
      ...episode(),
      versions: [{ ...currentVersion(episode()), endAt: '2026-08-05T09:00:00.000Z' }],
    }
    const outcome = evaluateLateData(e, [
      report('2026-08-05T07:00:00.000Z'),
      report('2026-08-05T07:02:00.000Z'),
    ], POLICY)

    expect(outcome.kind).toBe('split')
  })

  it('annotates rather than splitting when the interruption is transient', () => {
    // One heartbeat mid-blackout must not manufacture two episodes — the same rule that governs
    // closing, so the two cannot drift apart.
    const e = {
      ...episode(),
      versions: [{ ...currentVersion(episode()), endAt: '2026-08-05T09:00:00.000Z' }],
    }
    const outcome = evaluateLateData(e, [report('2026-08-05T07:00:00.000Z')], POLICY)

    expect(outcome.kind).toBe('annotated')
  })

  it('the split decision matches the close decision, for any run of reports', () => {
    // The property that makes replay meaningful: whether an interruption divides an episode is
    // decided by exactly the rule that decides whether it would have closed one.
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 600 }), { minLength: 0, maxLength: 6 }),
        (offsets) => {
          const base = Date.parse('2026-08-05T07:00:00.000Z')
          const reports = offsets.map((o) => report(new Date(base + o * 1000).toISOString()))
          const e = {
            ...episode(),
            versions: [{ ...currentVersion(episode()), endAt: '2026-08-05T09:00:00.000Z' }],
          }
          const outcome = evaluateLateData(e, reports, POLICY)
          const wouldClose = confirmsRecovery(reports, POLICY)

          if (reports.length === 0) return outcome.kind === 'no_change'
          return wouldClose ? outcome.kind === 'split' : outcome.kind === 'annotated'
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('applying an outcome', () => {
  it('a split supersedes the original rather than mutating it', () => {
    const e = {
      ...episode(),
      versions: [{ ...currentVersion(episode()), endAt: '2026-08-05T09:00:00.000Z' }],
    }
    const outcome = evaluateLateData(e, [
      report('2026-08-05T07:00:00.000Z'),
      report('2026-08-05T07:02:00.000Z'),
    ], POLICY)

    const { episodes, changed } = applyLateData(e, outcome, {
      actor: 'worker', at: BEFORE_WATERMARK, now: BEFORE_WATERMARK,
    })

    expect(changed).toBe(true)
    expect(episodes).toHaveLength(3)
    // The original is retracted with its history intact, so a report that counted one incident
    // stays reconstructible.
    expect(currentState(episodes[0]!)).toBe('retracted')
    expect(episodes[0]!.versions).toHaveLength(2)
    expect(episodes[1]!.id).toBe('ep_1-a')
    expect(episodes[2]!.id).toBe('ep_1-b')
    // Replacements carry no actions: nothing was done in the world on their behalf.
    expect(episodes[1]!.actions).toEqual([])
  })

  it('an annotation changes nothing', () => {
    const e = episode()
    const { episodes, changed } = applyLateData(
      e, { kind: 'annotated', reason: 'transient' },
      { actor: 'w', at: BEFORE_WATERMARK, now: BEFORE_WATERMARK },
    )
    expect(changed).toBe(false)
    expect(episodes[0]!.versions).toHaveLength(1)
  })

  it('refuses to apply a retraction to a finalised, acted-on episode without approval', () => {
    const e = episode({
      actions: [{ kind: 'field_verification', at: BEFORE_WATERMARK, reference: 'FV-1' }],
    })
    expect(() => applyLateData(
      e, { kind: 'retracted', reason: 'buffered records' },
      { actor: 'w', at: AFTER_WATERMARK, now: AFTER_WATERMARK },
    )).toThrow(ApprovalRequiredError)
  })
})

describe('determinism', () => {
  it('the same records produce the same history, whatever order they arrive in', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 300 }), { minLength: 2, maxLength: 6 }),
        (offsets) => {
          const base = Date.parse('2026-08-05T07:00:00.000Z')
          const reports = offsets.map((o) => report(new Date(base + o * 1000).toISOString()))
          const e = {
            ...episode(),
            versions: [{ ...currentVersion(episode()), endAt: '2026-08-05T09:00:00.000Z' }],
          }
          const forwards = evaluateLateData(e, reports, POLICY)
          const backwards = evaluateLateData(e, [...reports].reverse(), POLICY)
          return JSON.stringify(forwards) === JSON.stringify(backwards)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('version numbers are monotonic and the chain is unbroken', () => {
    let e = episode()
    for (const to of ['monitoring', 'review_required', 'classified'] as const) {
      e = transition(e, {
        to, cause: 'human_decision', actor: 'analyst', reason: 'step', at: BEFORE_WATERMARK,
      }, BEFORE_WATERMARK)
    }
    expect(e.versions.map((v) => v.version)).toEqual([1, 2, 3, 4])
    expect(e.versions.map((v) => v.supersedes)).toEqual([null, 1, 2, 3])
  })
})

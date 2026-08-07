// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_LIMITS,
  checkScope,
  planWindows,
  remainingWindows,
  runReplay,
  type ReplayHooks,
  type ReplayProgress,
  type ReplayScope,
  type ReplayWindow,
} from './replay.js'

const NOW = '2026-09-01T00:00:00.000Z'

const scope = (overrides: Partial<ReplayScope> = {}): ReplayScope => ({
  tenantId: 'synthetic_a',
  source: 'traccar',
  from: '2026-08-01T00:00:00.000Z',
  to: '2026-08-08T00:00:00.000Z',
  approvedBy: 'ops_lead',
  reason: 'adapter 1.1.0 recovers signal fields',
  ...overrides,
})

/** Recording hooks, so a test can assert what was audited and checkpointed. */
function recorder(overrides: Partial<ReplayHooks> = {}): ReplayHooks & {
  processed: ReplayWindow[]
  checkpoints: ReplayProgress[]
  audits: { action: string; detail: Record<string, unknown> }[]
} {
  const processed: ReplayWindow[] = []
  const checkpoints: ReplayProgress[] = []
  const audits: { action: string; detail: Record<string, unknown> }[] = []

  return {
    processed,
    checkpoints,
    audits,
    processWindow: async (w) => { processed.push(w) },
    saveCheckpoint: async (p) => { checkpoints.push(p) },
    audit: async (e) => { audits.push(e) },
    ...overrides,
  }
}

describe('scope is validated before any work begins', () => {
  it('accepts a bounded, approved request', () => {
    expect(checkScope(scope(), NOW)).toEqual({ ok: true, rejections: [] })
  })

  it('refuses an unbounded request', () => {
    // An unbounded replay over a live tenant reprocesses the whole history at a cost nobody agreed to.
    expect(checkScope({ ...scope(), from: '' }, NOW).rejections).toContain('unbounded')
    expect(checkScope({ approvedBy: 'x', reason: 'y' }, NOW).rejections).toContain('unbounded')
  })

  it('refuses an inverted interval', () => {
    expect(checkScope(scope({ from: '2026-08-08T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' }), NOW)
      .rejections).toContain('inverted')
  })

  it('refuses an interval longer than the limit', () => {
    expect(checkScope(scope({ from: '2025-01-01T00:00:00.000Z' }), NOW).rejections).toContain('too_long')
  })

  it('refuses a request with no approver or no reason', () => {
    // Checked here rather than at the audit step: a run that starts and is then found unapproved
    // has already changed data.
    expect(checkScope(scope({ approvedBy: '' }), NOW).rejections).toContain('missing_approval')
    expect(checkScope(scope({ reason: '' }), NOW).rejections).toContain('missing_reason')
  })

  it('refuses an interval that starts in the future', () => {
    expect(checkScope(scope({ from: '2027-01-01T00:00:00.000Z', to: '2027-01-02T00:00:00.000Z' }), NOW)
      .rejections).toContain('future_interval')
  })

  it('reports every rejection, not just the first', () => {
    const result = checkScope(
      { from: '2026-08-08T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' },
      NOW,
    )
    expect(result.rejections.length).toBeGreaterThan(2)
  })
})

describe('windows are contiguous and half-open', () => {
  it('covers the interval exactly, with no gap or overlap', () => {
    const windows = planWindows(scope())
    expect(windows).toHaveLength(7)
    expect(windows[0]?.from).toBe('2026-08-01T00:00:00.000Z')
    expect(windows[6]?.to).toBe('2026-08-08T00:00:00.000Z')

    for (let i = 1; i < windows.length; i++) {
      // One window's end is the next window's start: nothing processed twice, nothing skipped.
      expect(windows[i]?.from).toBe(windows[i - 1]?.to)
    }
  })

  it('truncates the final window rather than overrunning the interval', () => {
    const windows = planWindows(scope({ to: '2026-08-03T06:00:00.000Z' }))
    expect(windows[windows.length - 1]?.to).toBe('2026-08-03T06:00:00.000Z')
  })

  it('covers any interval exactly, for any window size', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 1, max: 48 }),
        (days, windowHours) => {
          const s = scope({
            from: '2026-06-01T00:00:00.000Z',
            to: new Date(Date.parse('2026-06-01T00:00:00.000Z') + days * 86_400_000).toISOString(),
          })
          const windows = planWindows(s, { ...DEFAULT_LIMITS, windowHours })
          if (windows.length === 0) return false
          if (windows[0]!.from !== s.from) return false
          if (windows[windows.length - 1]!.to !== s.to) return false
          return windows.every((w, i) => i === 0 || w.from === windows[i - 1]!.to)
        },
      ),
      { numRuns: 150 },
    )
  })
})

describe('resumption', () => {
  it('restarts at the first window after the checkpoint', () => {
    const windows = planWindows(scope())
    const remaining = remainingWindows(windows, '2026-08-03T00:00:00.000Z')
    expect(remaining).toHaveLength(5)
    expect(remaining[0]?.from).toBe('2026-08-03T00:00:00.000Z')
  })

  it('runs everything when there is no checkpoint', () => {
    expect(remainingWindows(planWindows(scope()), null)).toHaveLength(7)
  })

  it('runs nothing when the checkpoint covers the interval', () => {
    expect(remainingWindows(planWindows(scope()), '2026-08-08T00:00:00.000Z')).toHaveLength(0)
  })

  it('resumes rather than restarting, and completes the same total', async () => {
    // A replay that must restart from the beginning after a failure will, in practice, be abandoned.
    const first = recorder({
      processWindow: async (w) => {
        if (w.index === 3) throw new Error('transient')
      },
    })
    const failed = await runReplay('run_1', scope(), first)
    expect(failed.status).toBe('failed')
    expect(failed.windowsProcessed).toBe(3)
    expect(failed.checkpointAt).toBe('2026-08-04T00:00:00.000Z')

    const second = recorder()
    const resumed = await runReplay('run_1', scope(), second, { checkpointAt: failed.checkpointAt })
    expect(resumed.status).toBe('completed')
    expect(resumed.windowsProcessed).toBe(7)
    // Only the outstanding windows were re-run.
    expect(second.processed).toHaveLength(4)
  })

  it('leaves the checkpoint behind the failed window, never past it', async () => {
    // Advancing past a partially-processed window would silently skip data on resume.
    const hooks = recorder({
      processWindow: async (w) => { if (w.index === 2) throw new Error('boom') },
    })
    const outcome = await runReplay('run_2', scope(), hooks)
    expect(outcome.failedWindow?.index).toBe(2)
    expect(Date.parse(outcome.checkpointAt!)).toBeLessThanOrEqual(
      Date.parse(outcome.failedWindow!.from),
    )
  })
})

describe('separate audit trail', () => {
  it('records start and completion with the approval and the scope', async () => {
    // A replay changes what the evidence says. Recording it in the same stream as routine ingestion
    // would make "why did this episode change?" unanswerable.
    const hooks = recorder()
    await runReplay('run_3', scope(), hooks)

    const started = hooks.audits.find((a) => a.action === 'replay.started')
    expect(started?.detail['approved_by']).toBe('ops_lead')
    expect(started?.detail['reason']).toContain('adapter 1.1.0')
    expect(started?.detail['interval_start']).toBe('2026-08-01T00:00:00.000Z')
    expect(hooks.audits.some((a) => a.action === 'replay.completed')).toBe(true)
  })

  it('distinguishes a resumed run from a fresh one', async () => {
    const hooks = recorder()
    await runReplay('run_4', scope(), hooks, { checkpointAt: '2026-08-04T00:00:00.000Z' })
    expect(hooks.audits[0]?.action).toBe('replay.resumed')
    expect(hooks.audits[0]?.detail['windows_remaining']).toBe(4)
  })

  it('audits a failure with the window that failed', async () => {
    const hooks = recorder({
      processWindow: async (w) => { if (w.index === 1) throw new Error('boom') },
    })
    await runReplay('run_5', scope(), hooks)
    const failure = hooks.audits.find((a) => a.action === 'replay.failed')
    expect(failure?.detail['window_from']).toBe('2026-08-02T00:00:00.000Z')
  })
})

describe('cancellation', () => {
  it('stops between windows and keeps an honest checkpoint', async () => {
    // Stopping mid-window would leave a checkpoint claiming more progress than was made.
    let seen = 0
    const hooks = recorder({
      shouldCancel: async () => {
        seen += 1
        return seen > 2
      },
    })
    const outcome = await runReplay('run_6', scope(), hooks)

    expect(outcome.status).toBe('cancelled')
    expect(outcome.windowsProcessed).toBe(2)
    expect(outcome.checkpointAt).toBe('2026-08-03T00:00:00.000Z')
    expect(hooks.processed).toHaveLength(2)
    expect(hooks.audits.some((a) => a.action === 'replay.cancelled')).toBe(true)
  })

  it('a cancelled run resumes exactly where it stopped', async () => {
    let seen = 0
    const first = recorder({ shouldCancel: async () => { seen += 1; return seen > 3 } })
    const cancelled = await runReplay('run_7', scope(), first)

    const second = recorder()
    const finished = await runReplay('run_7', scope(), second, { checkpointAt: cancelled.checkpointAt })
    expect(finished.status).toBe('completed')
    expect(first.processed.length + second.processed.length).toBe(7)
  })
})

describe('determinism', () => {
  it('two runs over the same interval process identical windows', async () => {
    const a = recorder()
    const b = recorder()
    await runReplay('run_8', scope(), a)
    await runReplay('run_9', scope(), b)
    expect(JSON.stringify(a.processed)).toBe(JSON.stringify(b.processed))
  })

  it('a resumed run and an uninterrupted run cover the same windows', async () => {
    const whole = recorder()
    await runReplay('run_10', scope(), whole)

    const part1 = recorder()
    const record = part1.processWindow.bind(part1)
    part1.processWindow = async (w) => {
      if (w.index === 4) throw new Error('x')
      await record(w)
    }
    const failed = await runReplay('run_11', scope(), part1)
    const part2 = recorder()
    await runReplay('run_11', scope(), part2, { checkpointAt: failed.checkpointAt })

    const rejoined = [...part1.processed, ...part2.processed]
    expect(JSON.stringify(rejoined)).toBe(JSON.stringify(whole.processed))
  })
})

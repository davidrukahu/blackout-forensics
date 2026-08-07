// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * §11.4's three MUSTs — idempotent, observable, evidenced — plus the hold that demonstrably
 * blocks deletion and the backup window that ages expired content out.
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_RETENTION,
  InvalidRetentionPolicyError,
  executeRetention,
  holdActive,
  overdueBackups,
  planRetention,
  releaseHold,
  validateRetentionPolicy,
  type DeletionExecutor,
  type LegalHold,
  type RetainedItem,
} from './retention.js'

const NOW = '2026-08-08T00:00:00.000Z'
const daysAgo = (days: number): string =>
  new Date(Date.parse(NOW) - days * 86_400_000).toISOString()

const item = (overrides: Partial<RetainedItem> & { ref: string }): RetainedItem => ({
  dataClass: 'raw_receipt',
  tenantId: 'synthetic_a',
  createdAt: daysAgo(60),
  ...overrides,
})

const hold = (overrides?: Partial<LegalHold>): LegalHold => ({
  id: 'hold-1',
  scope: { tenantId: 'synthetic_a', episodeIds: ['ep-9'] },
  authority: 'demand letter 2026/114',
  placedBy: 'counsel',
  placedAt: daysAgo(10),
  reviewAt: daysAgo(-20),
  releasedBy: null,
  releasedAt: null,
  ...overrides,
})

const collector = (): DeletionExecutor & { deleted: string[] } => {
  const deleted: string[] = []
  return {
    deleted,
    delete: async (ref) => {
      deleted.push(ref)
    },
  }
}

describe('the §11.4 defaults', () => {
  it('carry the table verbatim and validate', () => {
    expect(DEFAULT_RETENTION.days.quarantined_payload).toBe(14)
    expect(DEFAULT_RETENTION.days.raw_receipt).toBe(30)
    expect(DEFAULT_RETENTION.days.normalized_telemetry).toBe(90)
    expect(DEFAULT_RETENTION.days.audit_metadata).toBe(730)
    expect(DEFAULT_RETENTION.backupWindowDays).toBe(35)
    expect(() => validateRetentionPolicy(DEFAULT_RETENTION)).not.toThrow()
  })

  it('refuse a backup window past 35 days and telemetry past the approvable 180', () => {
    expect(() =>
      validateRetentionPolicy({ ...DEFAULT_RETENTION, backupWindowDays: 36 }),
    ).toThrow(InvalidRetentionPolicyError)
    expect(() =>
      validateRetentionPolicy({
        ...DEFAULT_RETENTION,
        days: { ...DEFAULT_RETENTION.days, normalized_telemetry: 181 },
      }),
    ).toThrow(InvalidRetentionPolicyError)
  })
})

describe('planning is deterministic and observable', () => {
  it('same inputs, same run id and plan', () => {
    const items = [item({ ref: 'r1' }), item({ ref: 'r2', createdAt: daysAgo(5) })]
    const a = planRetention({ items, holds: [], now: NOW })
    const b = planRetention({ items, holds: [], now: NOW })
    expect(a).toEqual(b)
    expect(a.runId).toMatch(/^ret-/)
  })

  it('every kept item states why: not due, held, tombstoned, or needed for reproduction', () => {
    const items = [
      item({ ref: 'due' }),
      item({ ref: 'fresh', createdAt: daysAgo(5) }),
      item({ ref: 'held', episodeId: 'ep-9' }),
      item({ ref: 'gone', tombstonedAt: daysAgo(1) }),
      item({ ref: 'snapshot', dataClass: 'map_snapshot', neededForReproduction: true }),
    ]
    const plan = planRetention({ items, holds: [hold()], now: NOW })
    expect(plan.deletions.map((d) => d.ref)).toEqual(['due'])
    expect(Object.fromEntries(plan.kept.map((k) => [k.ref, k.reason]))).toEqual({
      fresh: 'not_due',
      held: 'legal_hold',
      gone: 'already_tombstoned',
      snapshot: 'needed_for_reproduction',
    })
  })

  it('a map snapshot nothing references any more is due immediately — licence hygiene', () => {
    const plan = planRetention({
      items: [item({ ref: 'stale-snap', dataClass: 'map_snapshot', neededForReproduction: false })],
      holds: [],
      now: NOW,
    })
    expect(plan.deletions.map((d) => d.ref)).toEqual(['stale-snap'])
  })
})

describe('legal hold demonstrably blocks deletion', () => {
  it('an entire-tenant hold keeps everything in the tenant, item by item, visibly', () => {
    const items = [item({ ref: 'a' }), item({ ref: 'b', dataClass: 'quarantined_payload' })]
    const plan = planRetention({
      items,
      holds: [hold({ scope: { tenantId: 'synthetic_a', entireTenant: true } })],
      now: NOW,
    })
    expect(plan.deletions).toEqual([])
    expect(plan.kept.every((k) => k.reason === 'legal_hold' && k.holdId === 'hold-1')).toBe(true)
  })

  it('release is recorded and re-release refused; after release, deletion proceeds', () => {
    const released = releaseHold(hold(), { releasedBy: 'counsel', at: daysAgo(1) })
    expect(released.releasedBy).toBe('counsel')
    expect(holdActive(released, NOW)).toBe(false)
    expect(() => releaseHold(released, { releasedBy: 'x', at: NOW })).toThrow(/already released/)

    const plan = planRetention({
      items: [item({ ref: 'held-then-released', episodeId: 'ep-9' })],
      holds: [released],
      now: NOW,
    })
    expect(plan.deletions.map((d) => d.ref)).toEqual(['held-then-released'])
  })
})

describe('execution is idempotent and evidenced', () => {
  it('tombstones every deletion with run, policy and the backup purge date', async () => {
    const items = [item({ ref: 'r1' })]
    const plan = planRetention({ items, holds: [], now: NOW })
    const executor = collector()
    const report = await executeRetention(plan, executor, NOW)

    expect(executor.deleted).toEqual(['r1'])
    expect(report.deleted).toBe(1)
    expect(report.tombstones[0]).toMatchObject({
      ref: 'r1',
      runId: plan.runId,
      policyVersion: DEFAULT_RETENTION.version,
    })
    expect(Date.parse(report.tombstones[0]!.purgedFromBackupsBy)).toBe(
      Date.parse(NOW) + 35 * 86_400_000,
    )

    // Second run over the tombstoned inventory deletes nothing — idempotency via evidence.
    const second = planRetention({
      items: [{ ...items[0]!, tombstonedAt: NOW }],
      holds: [],
      now: NOW,
    })
    expect(second.deletions).toEqual([])
  })

  it('a failed deletion is reported and remains due next run — no tombstone, no forgetting', async () => {
    const plan = planRetention({ items: [item({ ref: 'stuck' })], holds: [], now: NOW })
    const report = await executeRetention(
      plan,
      { delete: async () => { throw new Error('object store unavailable') } },
      NOW,
    )
    expect(report.failed).toEqual([{ ref: 'stuck', error: 'object store unavailable' }])
    expect(report.tombstones).toEqual([])
  })
})

describe('backups age out on the documented schedule', () => {
  it('flags generations older than the window', () => {
    const generations = [
      { id: 'g-old', takenAt: daysAgo(36) },
      { id: 'g-edge', takenAt: daysAgo(35) },
      { id: 'g-fresh', takenAt: daysAgo(1) },
    ]
    expect(overdueBackups(generations, NOW).map((g) => g.id)).toEqual(['g-old'])
  })
})

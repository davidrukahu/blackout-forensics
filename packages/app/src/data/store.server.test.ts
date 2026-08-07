// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The application data layer, seeded from the reference corpus.
 *
 * These tests pin the layer's production contracts: object-level authorization on every
 * function, optimistic assignment that cannot overwrite, bulk refusals surfaced per row, and a
 * queue item that structurally cannot carry borrower identity.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  assignOwner,
  auditTrail,
  bulkAssign,
  getQueue,
  listViews,
  resetStoreForTesting,
} from './store.server.js'

const ANALYST = ['queue:read', 'queue:assign']
const NOW = '2026-08-05T12:00:00.000Z'

afterEach(() => resetStoreForTesting())

describe('the seeded queue', () => {
  it('derives rows from the reference corpus through the real sampler and classifier', () => {
    const { items } = getQueue({ scopes: ANALYST, now: NOW })
    expect(items.length).toBeGreaterThan(5)
    // Every row is a domain object with the FR-QUE-001 columns.
    for (const item of items) {
      expect(item.assetRef).toMatch(/^ast-\d{4}$/)
      expect(item.priority.reason.length).toBeGreaterThan(0)
      expect(['provisional', 'awaiting_data', 'review_required', 'classified']).toContain(item.bucket)
    }
  })

  it('no row carries borrower identity, structurally', () => {
    const { items } = getQueue({ scopes: ANALYST, now: NOW })
    const keys = new Set(items.flatMap((item) => Object.keys(item)))
    for (const key of keys) {
      expect(key).not.toMatch(/borrower|customer|phone|msisdn|account/i)
    }
  })

  it('refuses a caller without the queue scope — deny by default, enforced at the data layer', () => {
    expect(() => getQueue({ scopes: ['case:read'], now: NOW })).toThrow(Response)
    expect(() =>
      assignOwner({ scopes: ['queue:read'], actor: 'x', episodeId: 'nope', owner: 'x', expectedVersion: 1 }),
    ).toThrow(Response)
  })

  it('is deterministic: two reads see the same rows', () => {
    const first = getQueue({ scopes: ANALYST, now: NOW }).items.map((i) => i.episodeId)
    const second = getQueue({ scopes: ANALYST, now: NOW }).items.map((i) => i.episodeId)
    expect(first).toEqual(second)
  })
})

describe('assignment', () => {
  it('assigns with the version the caller saw, and the audit trail records it', () => {
    const { items } = getQueue({ scopes: ANALYST, now: NOW })
    const target = items[0]!
    const outcome = assignOwner({
      scopes: ANALYST, actor: 'analyst-a', episodeId: target.episodeId,
      owner: 'analyst-a', expectedVersion: target.version,
    })
    expect(outcome).toEqual({ kind: 'assigned', owner: 'analyst-a' })
    expect(auditTrail().some((e) => e.action === 'queue.assign')).toBe(true)
  })

  it('a concurrent claim conflicts instead of overwriting', () => {
    const { items } = getQueue({ scopes: ANALYST, now: NOW })
    const target = items[0]!
    assignOwner({
      scopes: ANALYST, actor: 'analyst-a', episodeId: target.episodeId,
      owner: 'analyst-a', expectedVersion: target.version,
    })
    // Analyst B still holds the version from before A's claim.
    const outcome = assignOwner({
      scopes: ANALYST, actor: 'analyst-b', episodeId: target.episodeId,
      owner: 'analyst-b', expectedVersion: target.version,
    })
    expect(outcome.kind).toBe('conflict')
    if (outcome.kind === 'conflict') {
      expect(outcome.currentOwner).toBe('analyst-a')
    }
  })
})

describe('bulk assignment', () => {
  it('assigns eligible rows and returns per-row refusals for the rest', () => {
    const { items } = getQueue({ scopes: ANALYST, now: NOW })
    const urgent = items.filter((i) => i.priority.tier === 'urgent' || i.band === 'direct')
    const { assigned, refused } = bulkAssign({
      scopes: ANALYST, actor: 'analyst-a',
      episodeIds: items.map((i) => i.episodeId), owner: 'analyst-a', now: NOW,
    })
    expect(assigned).toBe(items.length - urgent.length)
    expect(refused.length).toBe(urgent.length)
    for (const refusal of refused) {
      expect(refusal.reason).toMatch(/individual review/)
    }
  })
})

describe('views', () => {
  it('ships the built-in views', () => {
    expect(listViews().map((v) => v.id)).toEqual(
      expect.arrayContaining(['view-due', 'view-review', 'view-unowned', 'view-urgent']),
    )
  })

  it('the urgent view contains only urgent rows', () => {
    const { items } = getQueue({ scopes: ANALYST, viewId: 'view-urgent', now: NOW })
    for (const item of items) expect(item.priority.tier).toBe('urgent')
  })
})

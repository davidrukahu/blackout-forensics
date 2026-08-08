// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The metrics loader: every number from the same store the queue reads, through the same §6.12
 * report builder the signed exports use — and the honesty rules that make a dashboard trustworthy.
 */

import { afterEach, describe, expect, it } from 'vitest'

import type { LoaderFunctionArgs } from 'react-router'

import { getMetrics, getQueue, resetStoreForTesting } from '../data/store.server.js'
import { loader } from './metrics.js'

afterEach(() => resetStoreForTesting())

const ANALYST = ['queue:read', 'queue:assign', 'case:read']
const NOW = '2026-08-05T12:00:00.000Z'

const args = (role = 'analyst') =>
  ({
    request: new Request('http://app.test/metrics', { headers: { cookie: `bf-role=${role}` } }),
    params: {},
    context: {},
  }) as unknown as LoaderFunctionArgs

describe('the metrics loader', () => {
  it('reconciles with the queue: same cases, same urgency, same bands', async () => {
    const { metrics } = await loader(args())
    const items = getQueue({ scopes: ANALYST, now: NOW }).items
    expect(metrics.stats.totalCases).toBe(items.length)
    expect(metrics.stats.urgentTier).toBe(items.filter((i) => i.priority.tier === 'urgent').length)
    expect(metrics.bands.reduce((sum, band) => sum + band.count, 0)).toBe(items.length)
  })

  it('charts only closed gaps; open episodes are counted separately, never charted as bounded', () => {
    const metrics = getMetrics({ scopes: ANALYST, now: NOW })
    expect(metrics.gapChart.length + metrics.openEpisodes).toBe(metrics.stats.totalCases)
    for (const bar of metrics.gapChart) expect(bar.minutes).toBeGreaterThan(0)
  })

  it('the SLA card is the report builder verbatim, integrity hash included', () => {
    const metrics = getMetrics({ scopes: ANALYST, now: NOW })
    expect(metrics.sla.manifest.integritySha256).toMatch(/^[0-9a-f]{64}$/)
    expect(metrics.sla.manifest.denominators['opened_episodes']).toBe(metrics.stats.totalCases)
    expect(metrics.sla.telemetry.retractionRate.denominator).toBe(metrics.stats.totalCases)
  })

  it('refuses without the queue scope — same deny-by-default as every screen', () => {
    expect(() => getMetrics({ scopes: ['case:read'], now: NOW })).toThrow(Response)
  })
})

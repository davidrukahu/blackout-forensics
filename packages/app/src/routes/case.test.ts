// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Case review: §9.3's order and FR-QUE-003's togetherness, pinned at the data level.
 */

import { afterEach, describe, expect, it } from 'vitest'

import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router'

import { CASE_SECTION_ORDER } from '../data/case.server.js'
import { auditTrail, getQueue, resetStoreForTesting } from '../data/store.server.js'
import { loader } from './case.js'

afterEach(() => resetStoreForTesting())

const ANALYST = ['queue:read', 'queue:assign', 'case:read']
const NOW = '2026-08-05T12:00:00.000Z'

function args(id: string): LoaderFunctionArgs & ActionFunctionArgs {
  return {
    request: new Request(`http://app.test/cases/${id}`, { headers: { cookie: 'bf-role=analyst' } }),
    params: { id },
    context: {},
  } as unknown as LoaderFunctionArgs & ActionFunctionArgs
}

function firstCaseId(): string {
  return getQueue({ scopes: ANALYST, now: NOW }).items[0]!.episodeId
}

describe('§9.3 order', () => {
  it('is fixed with reason first and the corridor after the evidence — the route renders this array', () => {
    expect(CASE_SECTION_ORDER[0]).toBe('reason_and_uncertainty')
    expect(CASE_SECTION_ORDER.indexOf('corridor')).toBeGreaterThan(
      CASE_SECTION_ORDER.indexOf('reason_and_uncertainty'),
    )
    expect(CASE_SECTION_ORDER.indexOf('corridor')).toBeGreaterThan(
      CASE_SECTION_ORDER.indexOf('evidence'),
    )
    expect(CASE_SECTION_ORDER.at(-1)).toBe('actions_and_decisions')
  })
})

describe('the loader', () => {
  it('assembles every §9.3 section for a real case', async () => {
    const { detail } = await loader(args(firstCaseId()))
    expect(detail.sections).toEqual(CASE_SECTION_ORDER)
    expect(detail.timeline.length).toBeGreaterThan(0)
    expect(detail.reason.headline.length).toBeGreaterThan(0)
    expect(detail.policies.record.version).toBe('1.0.0')
    expect(detail.decisions.available.length).toBeGreaterThan(0)
  })

  it('FR-QUE-003: each hypothesis carries supporting, counter and missing evidence together', async () => {
    const urgent = getQueue({ scopes: ANALYST, viewId: 'view-urgent', now: NOW }).items[0]
    expect(urgent).toBeDefined()
    const { detail } = await loader(args(urgent!.episodeId))
    expect(detail.evidence.entries.length).toBeGreaterThan(0)
    for (const entry of detail.evidence.entries) {
      expect(entry.supporting.length).toBeGreaterThan(0)
      expect(Array.isArray(entry.counterevidence)).toBe(true)
      expect(Array.isArray(entry.missingExpected)).toBe(true)
      expect(entry.ruleId.length).toBeGreaterThan(0)
      expect(entry.ruleVersion.length).toBeGreaterThan(0)
    }
  })

  it('records the sensitive view before returning (§10.4)', async () => {
    const id = firstCaseId()
    await loader(args(id))
    expect(
      auditTrail().some(
        (event) =>
          event.action === 'case.sensitive_view' &&
          (event.detail as { episode_id?: string }).episode_id === id,
      ),
    ).toBe(true)
  })

  it('404s on an unknown case, and refuses without the case scope', async () => {
    await expect(loader(args('nope'))).rejects.toMatchObject({ status: 404 })
    const noScope = {
      request: new Request('http://app.test/cases/x', { headers: { cookie: 'bf-role=analyst' } }),
      params: { id: 'x' },
      context: {},
    } as unknown as LoaderFunctionArgs
    // Strip the scope by faking a role without case:read — administrator has it, so build the
    // refusal through the data layer instead.
    void noScope
    const { getCase } = await import('../data/store.server.js')
    expect(() => getCase({ scopes: ['queue:read'], actor: 'x', episodeId: 'x' })).toThrow(Response)
  })

  it('the corridor section is always one of the honest states', async () => {
    const { items } = getQueue({ scopes: ANALYST, now: NOW })
    const states = new Set<string>()
    for (const item of items) {
      const { detail } = await loader(args(item.episodeId))
      states.add(detail.corridor.state)
      expect(['not_computed', 'corridor', 'corridor_ambiguous', 'infeasible']).toContain(
        detail.corridor.state,
      )
    }
    // The corpus must exercise more than the fallback: at least one computed outcome.
    expect([...states].some((state) => state !== 'not_computed')).toBe(true)
  })

  it('peer sections carry the denominator note, never a bare count', async () => {
    const { detail } = await loader(args(firstCaseId()))
    expect(detail.peers.note).toMatch(/fleet|Denominator/i)
    expect(detail.peers.fleetSize).toBeGreaterThan(0)
  })
})

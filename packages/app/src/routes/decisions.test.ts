// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Maker-checker through the HTTP surface — the same control the domain enforces, reached the way
 * the UI and API reach it. §17.4's bypass claim is tested at this layer too: the route returns
 * the domain's refusal as screen content, and no request shape applies a decision without it.
 */

import { afterEach, describe, expect, it } from 'vitest'

import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router'

import { getQueue, resetStoreForTesting } from '../data/store.server.js'
import { action as caseAction, loader as caseLoader } from './case.js'

afterEach(() => resetStoreForTesting())

const ANALYST = ['queue:read', 'queue:assign', 'case:read']
const NOW = '2026-08-05T12:00:00.000Z'

function post(id: string, role: string, body: Record<string, string>): ActionFunctionArgs {
  const form = new URLSearchParams(body)
  return {
    request: new Request(`http://app.test/cases/${id}`, {
      method: 'POST',
      body: form,
      headers: { cookie: `bf-role=${role}` },
    }),
    params: { id },
    context: {},
  } as unknown as ActionFunctionArgs
}

function get(id: string, role = 'analyst'): LoaderFunctionArgs {
  return {
    request: new Request(`http://app.test/cases/${id}`, { headers: { cookie: `bf-role=${role}` } }),
    params: { id },
    context: {},
  } as unknown as LoaderFunctionArgs
}

async function reviewRequiredCase(): Promise<{ id: string; seen: number }> {
  const { items } = getQueue({ scopes: ANALYST, viewId: 'view-review', now: NOW })
  const id = items[0]!.episodeId
  const { detail } = await caseLoader(get(id))
  return { id, seen: detail.decisions.seenVersionCount }
}

describe('§9.4 propose → approve through the route', () => {
  it('an analyst proposes with a canonical reason; a supervisor approves; the timeline shows both', async () => {
    const { id, seen } = await reviewRequiredCase()

    const proposed = await caseAction(post(id, 'analyst', {
      intent: 'propose',
      decisionId: 'classify_suspicious',
      reason: 'device telemetry supports possible tracker interference',
      seenVersionCount: String(seen),
    }))
    expect(proposed.notice).toContain('The proposal is saved')

    const { detail: withProposal } = await caseLoader(get(id))
    const proposal = withProposal.decisions.proposals[0]!
    expect(proposal.status).toBe('proposed')

    const resolved = await caseAction(post(id, 'supervisor', {
      intent: 'resolve', proposalId: proposal.id, resolution: 'approve',
    }))
    expect(resolved.notice).toContain('applied')

    const { detail: after } = await caseLoader(get(id))
    expect(after.item.bucket).toBe('classified')
    const lastTransition = after.timeline.at(-1)!
    expect(lastTransition.summary).toContain('approved by dev:supervisor')
    expect(lastTransition.actor).toBe('dev:analyst')
  })

  it('the proposer cannot approve: the refusal reaches the screen, nothing applies', async () => {
    const { id, seen } = await reviewRequiredCase()
    await caseAction(post(id, 'supervisor', {
      intent: 'propose',
      decisionId: 'classify_suspicious',
      reason: 'device telemetry supports possible tracker interference',
      seenVersionCount: String(seen),
    }))
    const { detail } = await caseLoader(get(id))
    const proposal = detail.decisions.proposals[0]!

    const result = await caseAction(post(id, 'supervisor', {
      intent: 'resolve', proposalId: proposal.id, resolution: 'approve',
    }))
    expect(result.refusal).toContain('A different person must approve')

    const { detail: after } = await caseLoader(get(id))
    expect(after.item.bucket).toBe('review_required')
  })

  it('an analyst cannot approve at all — the scope refuses before the domain is reached', async () => {
    const { id } = await reviewRequiredCase()
    await expect(
      caseAction(post(id, 'analyst', { intent: 'resolve', proposalId: 'p', resolution: 'approve' })),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('a non-canonical reason is refused with the control named', async () => {
    const { id, seen } = await reviewRequiredCase()
    const result = await caseAction(post(id, 'analyst', {
      intent: 'propose',
      decisionId: 'classify_suspicious',
      reason: 'seems dodgy',
      seenVersionCount: String(seen),
    }))
    expect(result.refusal).toContain('not an approved reason')
  })

  it('a stale screen cannot propose (§15.2)', async () => {
    const { id, seen } = await reviewRequiredCase()
    const result = await caseAction(post(id, 'analyst', {
      intent: 'propose',
      decisionId: 'classify_suspicious',
      reason: 'device telemetry supports possible tracker interference',
      seenVersionCount: String(seen - 1),
    }))
    expect(result.refusal).toContain('changed after this screen loaded')
  })

  it('machine suggestions render as advice and exclude world-affecting decisions', async () => {
    // The vendor-outage case fires H-POWER (direct); the explained suggestion comes from
    // source-cluster scenarios. Scan the whole queue: no suggestion anywhere is world-affecting.
    const { items } = getQueue({ scopes: ANALYST, now: NOW })
    for (const item of items) {
      const { detail } = await caseLoader(get(item.episodeId))
      for (const suggestion of detail.decisions.machineSuggestions) {
        expect(['classify_explained']).toContain(suggestion.decisionId)
        expect(suggestion.kind).toBe('machine_suggestion')
      }
    }
  })
})

describe('§22 outcomes through the route', () => {
  it('refuses OUT-RECOVERY without an authorization reference, records it with one', async () => {
    const { id } = await reviewRequiredCase()

    const refused = await caseAction(post(id, 'analyst', {
      intent: 'record_outcome', actionKind: 'record_external_recovery', outcomeCode: 'OUT-RECOVERY',
    }))
    expect(refused.refusal).toContain('external authorization reference')

    const recorded = await caseAction(post(id, 'analyst', {
      intent: 'record_outcome', actionKind: 'record_external_recovery', outcomeCode: 'OUT-RECOVERY',
      externalAuthorizationRef: 'court-order-2026-1441',
    }))
    expect(recorded.notice).toContain('recorded')

    const { detail } = await caseLoader(get(id))
    const action = detail.decisions.recordedActions[0]!
    expect(action.outcomeCode).toBe('OUT-RECOVERY')
    expect(action.externalAuthorizationRef).toBe('court-order-2026-1441')
  })

  it('links a vendor ticket with its evidence-pack hash', async () => {
    const { id } = await reviewRequiredCase()
    await caseAction(post(id, 'analyst', {
      intent: 'record_outcome', actionKind: 'vendor_ticket', outcomeCode: 'OUT-VENDOR',
      vendorTicketRef: 'TCK-4471', evidencePackSha256: 'a'.repeat(64),
    }))
    const { detail } = await caseLoader(get(id))
    expect(detail.decisions.recordedActions[0]!.vendorTicket).toMatchObject({
      reference: 'TCK-4471',
      evidencePackSha256: 'a'.repeat(64),
    })
  })

  it('an unlabelled completion stays unlabelled — no forced outcome (FR-OUT-004)', async () => {
    const { id } = await reviewRequiredCase()
    await caseAction(post(id, 'analyst', {
      intent: 'record_outcome', actionKind: 'field_verification',
    }))
    const { detail } = await caseLoader(get(id))
    expect(detail.decisions.recordedActions[0]!.outcomeCode).toBeNull()
  })
})

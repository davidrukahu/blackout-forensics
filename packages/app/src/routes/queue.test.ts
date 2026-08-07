// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The queue route's HTTP surface: loader and action called as functions, the way the framework
 * calls them. What is pinned here is the translation — malformed input is a 400, missing scope a
 * 403, and the conflict and refusal shapes reach the screen intact.
 */

import { afterEach, describe, expect, it } from 'vitest'

import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router'

import { resetStoreForTesting } from '../data/store.server.js'
import { action, loader } from './queue.js'

afterEach(() => resetStoreForTesting())

const asRole = (role: string): RequestInit => ({ headers: { cookie: `bf-role=${role}` } })

function post(body: Record<string, string | string[]>, init?: RequestInit): Request {
  const form = new URLSearchParams()
  for (const [key, value] of Object.entries(body)) {
    for (const v of Array.isArray(value) ? value : [value]) form.append(key, v)
  }
  return new Request('http://app.test/queue', {
    method: 'POST',
    body: form,
    ...init,
  })
}

const args = (request: Request) =>
  ({ request, params: {}, context: {} }) as LoaderFunctionArgs & ActionFunctionArgs

describe('loader', () => {
  it('returns the view, the view list and the rows', async () => {
    const data = await loader(args(new Request('http://app.test/queue', asRole('analyst'))))
    expect(data.items.length).toBeGreaterThan(0)
    expect(data.views.length).toBeGreaterThanOrEqual(4)
    expect(data.view.id).toBe('view-all')
  })

  it('honours the view parameter', async () => {
    const data = await loader(
      args(new Request('http://app.test/queue?view=view-urgent', asRole('analyst'))),
    )
    expect(data.view.id).toBe('view-urgent')
    for (const item of data.items) expect(item.priority.tier).toBe('urgent')
  })
})

describe('action', () => {
  it('claims a row through the optimistic path', async () => {
    const before = await loader(args(new Request('http://app.test/queue', asRole('analyst'))))
    const target = before.items[0]!
    const result = await action(
      args(post({
        intent: 'assign', episodeId: target.episodeId, expectedVersion: String(target.version),
      }, asRole('analyst'))),
    )
    expect(result).toEqual({ assigned: 1 })

    const after = await loader(args(new Request('http://app.test/queue', asRole('analyst'))))
    expect(after.items.find((i) => i.episodeId === target.episodeId)?.owner).toBe('dev:analyst')
  })

  it('returns the conflict shape on a stale version — the screen re-renders, nothing overwrites', async () => {
    const before = await loader(args(new Request('http://app.test/queue', asRole('analyst'))))
    const target = before.items[0]!
    await action(args(post({
      intent: 'assign', episodeId: target.episodeId, expectedVersion: String(target.version),
    }, asRole('supervisor'))))

    const result = await action(args(post({
      intent: 'assign', episodeId: target.episodeId, expectedVersion: String(target.version),
    }, asRole('analyst'))))
    expect(result.conflict).toEqual({
      episodeId: target.episodeId,
      currentOwner: 'dev:supervisor',
    })
  })

  it('bulk assignment reports refusals to the screen', async () => {
    const before = await loader(args(new Request('http://app.test/queue', asRole('analyst'))))
    const result = await action(args(post({
      intent: 'bulk_assign', ids: before.items.map((i) => i.episodeId),
    }, asRole('analyst'))))
    expect(result.assigned).toBeGreaterThan(0)
    expect(result.refusals!.length).toBeGreaterThan(0)
  })

  it('rejects malformed and unknown requests plainly', async () => {
    await expect(action(args(post({ intent: 'assign' }, asRole('analyst'))))).rejects.toMatchObject({
      status: 400,
    })
    await expect(action(args(post({ intent: 'reticulate' }, asRole('analyst'))))).rejects.toMatchObject({
      status: 400,
    })
  })

  it('an administrator without queue:assign is refused at the route AND the data layer', async () => {
    await expect(
      action(args(post({ intent: 'assign', episodeId: 'x', expectedVersion: '1' }, asRole('administrator')))),
    ).rejects.toMatchObject({ status: 403 })
  })
})

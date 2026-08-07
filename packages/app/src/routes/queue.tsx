// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The review queue, PRD §9.2 / FR-QUE-001.
 *
 * Every mutation is a plain form POST — the screen works without JavaScript, and progressive
 * enhancement can add optimistic updates later without changing the contract. The domain decides
 * everything: this file translates HTTP to domain calls and renders what comes back, including
 * the two honesty surfaces the PRD names — per-row bulk refusals, and assignment conflicts
 * re-rendered rather than overwritten.
 */

import { Form, Link, useActionData, useLoaderData, useSearchParams, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'

import { requireUser } from '../auth.server.js'
import { assignOwner, bulkAssign, getQueue, listViews } from '../data/store.server.js'
import type { QueueItem } from '../data/core.server.js'

export async function loader({ request }: LoaderFunctionArgs) {
  const user = requireUser(request, ['queue:read'])
  const url = new URL(request.url)
  const viewId = url.searchParams.get('view') ?? undefined
  const { view, items } = getQueue({
    scopes: user.scopes,
    ...(viewId === undefined ? {} : { viewId }),
  })
  return {
    actor: user.actor,
    view,
    views: listViews(),
    items,
  }
}

interface ActionResult {
  readonly conflict?: { episodeId: string; currentOwner: string | null }
  readonly refusals?: readonly { episodeId: string; reason: string }[]
  readonly assigned?: number
}

export async function action({ request }: ActionFunctionArgs): Promise<ActionResult> {
  const user = requireUser(request, ['queue:read', 'queue:assign'])
  const form = await request.formData()
  const intent = form.get('intent')

  if (intent === 'assign') {
    const episodeId = String(form.get('episodeId') ?? '')
    const expectedVersion = Number(form.get('expectedVersion') ?? Number.NaN)
    if (episodeId === '' || Number.isNaN(expectedVersion)) {
      throw new Response('Malformed assignment', { status: 400 })
    }
    const outcome = assignOwner({
      scopes: user.scopes,
      actor: user.actor,
      episodeId,
      owner: user.actor,
      expectedVersion,
    })
    if (outcome.kind === 'not_found') throw new Response('No such episode', { status: 404 })
    if (outcome.kind === 'conflict') {
      return {
        conflict: { episodeId: outcome.episodeId, currentOwner: outcome.currentOwner },
      }
    }
    return { assigned: 1 }
  }

  if (intent === 'bulk_assign') {
    const episodeIds = form.getAll('ids').map(String)
    if (episodeIds.length === 0) return { assigned: 0, refusals: [] }
    const { assigned, refused } = bulkAssign({
      scopes: user.scopes,
      actor: user.actor,
      episodeIds,
      owner: user.actor,
    })
    return { assigned, refusals: refused }
  }

  throw new Response('Unknown intent', { status: 400 })
}

const BAND_MARKS: Record<string, string> = {
  direct: '◆◆◆',
  corroborated: '◆◆',
  weak: '◆',
  indeterminate: '◇',
}

function formatAge(ageS: number): string {
  if (ageS < 3600) return `${Math.round(ageS / 60)} min`
  if (ageS < 48 * 3600) return `${Math.round(ageS / 3600)} h`
  return `${Math.round(ageS / 86400)} d`
}

function DueBadge({ item }: { item: QueueItem }) {
  const labels = { not_due: 'not due', due: 'due', overdue: 'overdue' } as const
  return (
    <span className={`badge due-${item.dueState}`}>
      {labels[item.dueState]}
      {item.dueState !== 'not_due' ? ` since ${item.dueAt.slice(0, 16)}Z` : ''}
    </span>
  )
}

export default function QueueScreen() {
  const { actor, view, views, items } = useLoaderData<typeof loader>()
  const actionData = useActionData<typeof action>()
  const [searchParams] = useSearchParams()
  const activeView = searchParams.get('view') ?? view.id

  return (
    <section aria-labelledby="queue-heading">
      <h1 id="queue-heading">Review queue</h1>

      <nav className="view-nav" aria-label="Saved views">
        <ul>
          {views.map((v) => (
            <li key={v.id}>
              <Link
                to={`?view=${v.id}`}
                aria-current={activeView === v.id ? 'page' : undefined}
              >
                {v.name}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {actionData?.conflict !== undefined && (
        <p className="conflict" role="alert">
          Assignment conflict: this row is now{' '}
          {actionData.conflict.currentOwner === null
            ? 'unassigned again'
            : `owned by ${actionData.conflict.currentOwner}`}
          . The row below shows the current state; nothing was overwritten.
        </p>
      )}

      {actionData?.refusals !== undefined && actionData.refusals.length > 0 && (
        <div className="refusals" role="alert">
          <p>{actionData.refusals.length} row(s) were excluded from the bulk action:</p>
          <ul>
            {actionData.refusals.map((refusal) => (
              <li key={refusal.episodeId}>
                {refusal.episodeId}: {refusal.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Form method="post" id="bulk-form">
        <div className="bulk-bar">
          <button type="submit" name="intent" value="bulk_assign">
            Assign selected to me
          </button>
          <span id="bulk-hint">
            Bulk actions are low-impact only; urgent and direct-evidence rows are excluded
            individually and listed when refused.
          </span>
        </div>
      </Form>

      <table className="queue">
          <caption>
            {items.length} episode(s) in “{view.name}”, sorted {view.sort.replaceAll('_', ' ')}.
            Priority is named factors, never a hidden score.
          </caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">Select</span>
              </th>
              <th scope="col">Priority</th>
              <th scope="col">Age</th>
              <th scope="col">Asset</th>
              <th scope="col">Evidence band</th>
              <th scope="col">Last defensible observation</th>
              <th scope="col">Source</th>
              <th scope="col">Owner</th>
              <th scope="col">Due</th>
              <th scope="col">Warnings</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.episodeId}>
                <td>
                  <input
                    type="checkbox"
                    name="ids"
                    value={item.episodeId}
                    form="bulk-form"
                    aria-label={`Select ${item.assetRef}`}
                    aria-describedby="bulk-hint"
                  />
                </td>
                <td>
                  <span className={`badge tier-${item.priority.tier}`}>{item.priority.tier}</span>
                  <br />
                  <small>{item.priority.reason}</small>
                </td>
                <td>
                  <time dateTime={item.startAt} title={`opened ${item.startAt}`}>
                    {formatAge(item.ageS)}
                  </time>
                </td>
                <td>
                  <Link to={`/cases/${item.episodeId}`}>{item.assetRef}</Link>
                  <br />
                  <small>{item.bucket.replaceAll('_', ' ')}</small>
                </td>
                <td>
                  {item.band === null ? (
                    'unknown'
                  ) : (
                    <span aria-label={`evidence band ${item.band}`}>
                      {BAND_MARKS[item.band]} {item.band}
                    </span>
                  )}
                </td>
                <td>
                  {item.lastDefensibleObservationAt === null ? (
                    'none'
                  ) : (
                    <time dateTime={item.lastDefensibleObservationAt}>
                      {item.lastDefensibleObservationAt.slice(0, 16)}Z
                    </time>
                  )}
                </td>
                <td>{item.source}</td>
                <td>{item.owner ?? '—'}</td>
                <td>
                  <DueBadge item={item} />
                </td>
                <td>
                  {item.warnings.length === 0 ? (
                    '—'
                  ) : (
                    <ul className="warnings">
                      {item.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>
                  {item.owner === actor ? (
                    'yours'
                  ) : (
                    <Form method="post">
                      <input type="hidden" name="episodeId" value={item.episodeId} />
                      <input type="hidden" name="expectedVersion" value={item.version} />
                      <button type="submit" name="intent" value="assign">
                        Claim
                      </button>
                    </Form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
    </section>
  )
}

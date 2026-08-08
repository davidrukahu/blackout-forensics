// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The review queue, PRD §9.2 / FR-QUE-001 — shadcn-admin skin over the same contract.
 *
 * Every mutation is a plain form POST — the screen works without JavaScript, and progressive
 * enhancement can add optimistic updates later without changing the contract. The domain decides
 * everything: this file translates HTTP to domain calls and renders what comes back, including
 * the two honesty surfaces the PRD names — per-row bulk refusals, and assignment conflicts
 * re-rendered rather than overwritten.
 */

import { Form, Link, NavLink, useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'

import { requireUser } from '../auth.server.js'
import { assignOwner, bulkAssign, getQueue, listViews } from '../data/store.server.js'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.js'
import { Badge } from '../components/ui/badge.js'
import { Button } from '../components/ui/button.js'
import { Checkbox } from '../components/ui/form-controls.js'
import {
  Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow,
} from '../components/ui/table.js'
import { cn } from '../lib/utils.js'
import type { QueueItem } from '../data/core.server.js'

export function meta() {
  return [{ title: 'Queue — Blackout Forensics' }]
}

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

const TIER_BADGE: Record<string, string> = {
  urgent: 'border-transparent bg-destructive text-destructive-foreground',
  elevated: 'border-transparent bg-secondary text-secondary-foreground',
  routine: 'border-border text-muted-foreground',
}

function formatAge(ageS: number): string {
  if (ageS < 3600) return `${Math.round(ageS / 60)} min`
  if (ageS < 48 * 3600) return `${Math.round(ageS / 3600)} h`
  return `${Math.round(ageS / 86400)} d`
}

function DueBadge({ item }: { item: QueueItem }) {
  if (item.dueState === 'not_due') {
    return <Badge variant="outline">not due</Badge>
  }
  return (
    <Badge
      className={cn(
        'border-transparent',
        item.dueState === 'overdue'
          ? 'bg-destructive/15 text-destructive'
          : 'bg-warning/15 text-warning',
      )}
    >
      {item.dueState} since {item.dueAt.slice(5, 16)}Z
    </Badge>
  )
}

export default function QueueScreen() {
  const { actor, view, views, items } = useLoaderData<typeof loader>()
  const actionData = useActionData<typeof action>()

  return (
    <section aria-labelledby="queue-heading" className="flex flex-col gap-4">
      <div>
        <h1 id="queue-heading" className="text-2xl font-bold tracking-tight">
          Review queue
        </h1>
        <p className="text-sm text-muted-foreground">
          Priority is named factors, never a hidden score.
        </p>
      </div>

      <nav aria-label="Saved views">
        <ul className="flex flex-wrap gap-2">
          {views.map((v) => (
            <li key={v.id}>
              <NavLink
                to={`?view=${v.id}`}
                aria-current={view.id === v.id ? 'page' : undefined}
                className={cn(
                  'inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium transition-colors',
                  view.id === v.id
                    ? 'border-transparent bg-primary text-primary-foreground'
                    : 'border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                {v.name}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      {actionData?.conflict !== undefined && (
        <Alert variant="destructive">
          <AlertTitle>Assignment conflict</AlertTitle>
          <AlertDescription>
            This row is now{' '}
            {actionData.conflict.currentOwner === null
              ? 'unassigned again'
              : `owned by ${actionData.conflict.currentOwner}`}
            . The row below shows the current state; nothing was overwritten.
          </AlertDescription>
        </Alert>
      )}

      {actionData?.refusals !== undefined && actionData.refusals.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>{actionData.refusals.length} row(s) excluded from the bulk action</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {actionData.refusals.map((refusal) => (
                <li key={refusal.episodeId}>
                  {refusal.episodeId}: {refusal.reason}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Form method="post" id="bulk-form" className="flex flex-wrap items-center gap-3">
        <Button type="submit" name="intent" value="bulk_assign" variant="outline" size="sm">
          Assign selected to me
        </Button>
        <span id="bulk-hint" className="text-xs text-muted-foreground">
          Bulk actions are low-impact only; urgent and direct-evidence rows are excluded
          individually and listed when refused.
        </span>
      </Form>

      <div className="rounded-xl border border-border bg-card p-2">
        <Table className="queue">
          <TableCaption className="px-2 pt-2">
            {items.length} episode(s) in “{view.name}”, sorted {view.sort.replaceAll('_', ' ')}.
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="w-8">
                <span className="sr-only">Select</span>
              </TableHead>
              <TableHead scope="col">Priority</TableHead>
              <TableHead scope="col">Age</TableHead>
              <TableHead scope="col">Asset</TableHead>
              <TableHead scope="col">Evidence band</TableHead>
              <TableHead scope="col">Last defensible observation</TableHead>
              <TableHead scope="col">Source</TableHead>
              <TableHead scope="col">Owner</TableHead>
              <TableHead scope="col">Due</TableHead>
              <TableHead scope="col">Warnings</TableHead>
              <TableHead scope="col">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.episodeId}>
                <TableCell>
                  <Checkbox
                    name="ids"
                    value={item.episodeId}
                    form="bulk-form"
                    aria-label={`Select ${item.assetRef}`}
                    aria-describedby="bulk-hint"
                  />
                </TableCell>
                <TableCell>
                  <Badge className={TIER_BADGE[item.priority.tier] ?? ''}>{item.priority.tier}</Badge>
                  <p className="mt-1 max-w-52 text-xs text-muted-foreground">{item.priority.reason}</p>
                </TableCell>
                <TableCell>
                  <time dateTime={item.startAt} title={`opened ${item.startAt}`} className="whitespace-nowrap">
                    {formatAge(item.ageS)}
                  </time>
                </TableCell>
                <TableCell>
                  <Link to={`/cases/${item.episodeId}`} className="font-medium hover:underline">
                    {item.assetRef}
                  </Link>
                  <p className="text-xs text-muted-foreground">{item.bucket.replaceAll('_', ' ')}</p>
                </TableCell>
                <TableCell>
                  {item.band === null ? (
                    <span className="text-muted-foreground">unknown</span>
                  ) : (
                    <span aria-label={`evidence band ${item.band}`} className="whitespace-nowrap">
                      <span aria-hidden="true">{BAND_MARKS[item.band]}</span> {item.band}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {item.lastDefensibleObservationAt === null ? (
                    <span className="text-muted-foreground">none</span>
                  ) : (
                    <time dateTime={item.lastDefensibleObservationAt} className="font-mono text-xs">
                      {item.lastDefensibleObservationAt.slice(0, 16)}Z
                    </time>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{item.source}</TableCell>
                <TableCell>{item.owner ?? <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell>
                  <DueBadge item={item} />
                </TableCell>
                <TableCell>
                  {item.warnings.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <ul className="max-w-44 list-disc pl-4 text-xs text-warning">
                      {item.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  )}
                </TableCell>
                <TableCell>
                  {item.owner === actor ? (
                    <span className="text-xs text-muted-foreground">yours</span>
                  ) : (
                    <Form method="post">
                      <input type="hidden" name="episodeId" value={item.episodeId} />
                      <input type="hidden" name="expectedVersion" value={item.version} />
                      <Button type="submit" name="intent" value="assign" variant="outline" size="sm">
                        Claim
                      </Button>
                    </Form>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}

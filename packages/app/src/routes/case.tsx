// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Case review, PRD §9.3 — shadcn-admin skin over the same contract.
 *
 * The screen renders `detail.sections` in array order — the mandated §9.3 sequence is data, not
 * layout discipline. Two rules are visible in the structure: supporting evidence, counterevidence
 * and missing expected evidence appear together per hypothesis (FR-QUE-003), and the corridor's
 * table is the primary representation with the map slot below it, disabled until a snapshot is
 * active (§9.3 — a point on a map creates false confidence).
 */

import { ArrowLeft } from 'lucide-react'
import { Form, Link, useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'

import { requireUser } from '../auth.server.js'
import { getCase, proposeDecision, recordCaseOutcome, resolveProposal } from '../data/store.server.js'
import { Alert, AlertDescription } from '../components/ui/alert.js'
import { Badge } from '../components/ui/badge.js'
import { Button } from '../components/ui/button.js'
import { Card, CardContent, CardDescription, CardHeader } from '../components/ui/card.js'
import { Input, Label, NativeSelect } from '../components/ui/form-controls.js'
import {
  Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow,
} from '../components/ui/table.js'
import { cn } from '../lib/utils.js'
import type { CaseDetail, CaseSection } from '../data/case.server.js'

export function meta() {
  return [{ title: 'Case review — Blackout Forensics' }]
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = requireUser(request, ['case:read'])
  const detail = getCase({
    scopes: user.scopes,
    actor: user.actor,
    episodeId: params['id'] ?? '',
  })
  if (detail === null) throw new Response('The case does not exist.', { status: 404 })
  return { detail }
}

interface CaseActionResult {
  readonly notice?: string
  readonly refusal?: string
}

export async function action({ request, params }: ActionFunctionArgs): Promise<CaseActionResult> {
  const form = await request.formData()
  const intent = form.get('intent')
  const episodeId = params['id'] ?? ''

  if (intent === 'propose') {
    const user = requireUser(request, ['case:propose'])
    const note = form.get('note')
    const result = proposeDecision({
      scopes: user.scopes,
      actor: user.actor,
      episodeId,
      decisionId: String(form.get('decisionId') ?? ''),
      reason: String(form.get('reason') ?? ''),
      note: typeof note === 'string' && note !== '' ? note : undefined,
      seenVersionCount: Number(form.get('seenVersionCount') ?? Number.NaN),
    })
    return result.kind === 'proposed'
      ? { notice: `The proposal is saved (${result.proposalId}). A second person must approve a high-impact decision.` }
      : { refusal: result.message }
  }

  if (intent === 'resolve') {
    const user = requireUser(request, ['case:approve'])
    const result = resolveProposal({
      scopes: user.scopes,
      actor: user.actor,
      episodeId,
      proposalId: String(form.get('proposalId') ?? ''),
      resolution: form.get('resolution') === 'approve' ? 'approve' : 'reject',
    })
    switch (result.kind) {
      case 'applied':
        return { notice: 'The decision is applied. The timeline shows the proposer and the approver.' }
      case 'rejected':
        return { notice: 'The proposal is rejected. The episode did not change.' }
      case 'superseded':
        return { refusal: result.message }
      case 'refused':
        return { refusal: result.message }
    }
  }

  if (intent === 'record_outcome') {
    const user = requireUser(request, ['case:propose'])
    const optional = (name: string): string | undefined => {
      const value = form.get(name)
      return typeof value === 'string' && value !== '' ? value : undefined
    }
    const result = recordCaseOutcome({
      scopes: user.scopes,
      actor: user.actor,
      episodeId,
      actionKind: String(form.get('actionKind') ?? 'field_verification') as never,
      outcomeCode: optional('outcomeCode'),
      note: optional('note'),
      externalAuthorizationRef: optional('externalAuthorizationRef'),
      vendorTicketRef: optional('vendorTicketRef'),
      evidencePackSha256: optional('evidencePackSha256'),
    })
    return result.kind === 'recorded'
      ? { notice: `The outcome is recorded (${result.actionId}).` }
      : { refusal: result.message }
  }

  throw new Response('The request is not valid.', { status: 400 })
}

const TIER_BADGE: Record<string, string> = {
  urgent: 'border-transparent bg-destructive text-destructive-foreground',
  elevated: 'border-transparent bg-secondary text-secondary-foreground',
  routine: 'border-border text-muted-foreground',
}

function SectionCard({
  id,
  title,
  description,
  children,
}: {
  id: string
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section aria-labelledby={id}>
      <Card>
        <CardHeader>
          {/* The section heading IS the card title — one element, correct outline level. */}
          <h2 id={id} className="text-base leading-none font-medium tracking-tight">
            {title}
          </h2>
          {description !== undefined && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">{children}</CardContent>
      </Card>
    </section>
  )
}

function ReasonSection({ detail }: { detail: CaseDetail }) {
  return (
    <SectionCard id="s-reason" title="Reason and uncertainty">
      <p className="font-medium">{detail.reason.headline}</p>
      <p className="text-muted-foreground">{detail.reason.uncertainty}</p>
      <p>
        Urgent-eligible:{' '}
        <Badge
          className={cn(
            detail.reason.urgentEligible
              ? 'border-transparent bg-destructive text-destructive-foreground'
              : 'border-border text-muted-foreground',
          )}
        >
          {detail.reason.urgentEligible ? 'yes' : 'no'}
        </Badge>
      </p>
      <div>
        <h3 className="mb-2 text-sm font-medium">Priority factors</h3>
        {detail.reason.priorityFactors.length === 0 ? (
          <p className="text-muted-foreground">No factor changed the priority.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Factor</TableHead>
                <TableHead scope="col">Effect</TableHead>
                <TableHead scope="col">From rule</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.reason.priorityFactors.map((factor) => (
                <TableRow key={`${factor.factor}-${factor.fromRule}`}>
                  <TableCell>{factor.factor.replaceAll('_', ' ')}</TableCell>
                  <TableCell>{factor.effect}</TableCell>
                  <TableCell className="font-mono text-xs">{factor.fromRule}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </SectionCard>
  )
}

function EvidenceSection({ detail }: { detail: CaseDetail }) {
  return (
    <SectionCard
      id="s-evidence"
      title="Evidence"
      description="Each hypothesis shows its supporting evidence, its counterevidence, and its missing expected evidence (FR-QUE-003)"
    >
      {detail.evidence.unknown !== null && (
        <Alert>
          <AlertDescription>
            <strong>The classification is unknown.</strong> {detail.evidence.unknown.reason}.
            The missing expected evidence is:{' '}
            {detail.evidence.unknown.missingExpected.join(', ') || 'none listed'}.
          </AlertDescription>
        </Alert>
      )}
      {detail.evidence.entries.map((entry) => (
        <article
          key={entry.code}
          aria-label={`Hypothesis ${entry.code}`}
          className="rounded-lg border border-border p-4"
        >
          <h3 className="flex flex-wrap items-center gap-2 font-medium">
            {entry.code}
            <Badge variant={entry.band === 'direct' ? 'destructive' : 'secondary'}>{entry.band}</Badge>
            {entry.suppressedBy !== null && (
              <Badge variant="outline">suppressed by {entry.suppressedBy}</Badge>
            )}
          </h3>
          <p className="mt-1 text-muted-foreground">{entry.summary}</p>
          <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-[10rem_1fr]">
            <dt className="text-xs font-medium text-muted-foreground uppercase">Supporting</dt>
            <dd>{entry.supporting}</dd>
            <dt className="text-xs font-medium text-muted-foreground uppercase">Counterevidence</dt>
            <dd>
              {entry.counterevidence.length === 0 ? (
                <span className="text-muted-foreground">none recorded</span>
              ) : (
                <ul className="list-disc pl-4">
                  {entry.counterevidence.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              )}
            </dd>
            <dt className="text-xs font-medium text-muted-foreground uppercase">Missing expected</dt>
            <dd>
              {entry.missingExpected.length === 0 ? (
                <span className="text-muted-foreground">the system read all the expected evidence</span>
              ) : (
                <ul className="list-disc pl-4">
                  {entry.missingExpected.map((m) => (
                    <li key={m} className="font-mono text-xs">
                      {m}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
            <dt className="text-xs font-medium text-muted-foreground uppercase">Rule</dt>
            <dd className="font-mono text-xs">
              {entry.ruleId} v{entry.ruleVersion}
              {entry.humanReview ? '. A person must review this result.' : ''}
            </dd>
          </dl>
        </article>
      ))}
      {detail.evidence.notApplicable.length > 0 && (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer text-sm">
            The system could not evaluate {detail.evidence.notApplicable.length} rule(s)
          </summary>
          <ul className="mt-2 list-disc pl-5 text-xs">
            {detail.evidence.notApplicable.map((n) => (
              <li key={n.code}>
                {n.code}: missing <span className="font-mono">{n.missingFacts.join(', ')}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </SectionCard>
  )
}

function CorridorSectionView({ detail }: { detail: CaseDetail }) {
  const corridor = detail.corridor
  return (
    <SectionCard id="s-corridor" title="Candidate corridor">
      {corridor.state === 'not_computed' && (
        <p className="text-muted-foreground">The system did not compute the corridor. {corridor.reason}.</p>
      )}
      {corridor.state === 'corridor_ambiguous' && corridor.result.status === 'corridor_ambiguous' && (
        <Alert>
          <AlertDescription>
            <strong>The corridor is ambiguous. The system does not show a route.</strong>{' '}
            {corridor.result.reason}
          </AlertDescription>
        </Alert>
      )}
      {corridor.state === 'infeasible' && corridor.result.status === 'infeasible' && (
        <Alert>
          <AlertDescription>
            <strong>No route is possible in the elapsed time.</strong> {corridor.result.reason}
          </AlertDescription>
        </Alert>
      )}
      {corridor.state === 'corridor' && corridor.result.status === 'corridor' && (
        <>
          <p>
            <strong>{corridor.result.claim}</strong>: each feasible path must cross these cells.
            Snapshot <span className="font-mono text-xs">{corridor.result.manifest.snapshotId}</span>.
            Profile {corridor.result.manifest.profile}.
          </p>
          <Table>
            <TableCaption>
              The table is the primary output. The map below is a supplement.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">H3 cell</TableHead>
                <TableHead scope="col">Road</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {corridor.result.table.map((row) => (
                <TableRow key={row.h3Cell}>
                  <TableCell className="font-mono text-xs">{row.h3Cell}</TableCell>
                  <TableCell>{row.roadNames.length === 0 ? 'unnamed' : row.roadNames.join(', ')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
      {/* The map slot sits BELOW the table and the reason summary, §9.3. */}
      <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
        The map is off. There is no active OSM snapshot. The table above is complete.
      </p>
    </SectionCard>
  )
}

function DecisionsSection({ detail }: { detail: CaseDetail }) {
  return (
    <SectionCard id="s-actions" title="Prior actions and decisions">
      {detail.decisions.prior.length === 0 ? (
        <p className="text-muted-foreground">No external action is recorded for this episode.</p>
      ) : (
        <ul className="list-disc pl-4">
          {detail.decisions.prior.map((prior) => (
            <li key={`${prior.kind}-${prior.at}`}>
              {prior.kind.replaceAll('_', ' ')} at{' '}
              <time dateTime={prior.at} className="font-mono text-xs">
                {prior.at.slice(0, 16)}Z
              </time>{' '}
              ({prior.reference})
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Recorded actions and outcomes</h3>
        {detail.decisions.recordedActions.length === 0 ? (
          <p className="text-muted-foreground">No external action is recorded.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {detail.decisions.recordedActions.map((recorded) => (
              <li key={recorded.id} className="rounded-md border border-border px-3 py-2">
                {recorded.actionKind.replaceAll('_', ' ')} by {recorded.owner} —{' '}
                <span className="font-medium">
                  {recorded.outcomeCode ?? 'no outcome code'}
                </span>
                {recorded.externalAuthorizationRef !== null && (
                  <span className="text-muted-foreground"> · authorization {recorded.externalAuthorizationRef}</span>
                )}
                {recorded.vendorTicket !== null && (
                  <span className="text-muted-foreground"> · vendor ticket {recorded.vendorTicket.reference}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Form method="post" className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <h4 className="text-sm font-medium">Record an outcome</h4>
        <input type="hidden" name="intent" value="record_outcome" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Label>
            External action
            <NativeSelect name="actionKind">
              {detail.decisions.actionKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind.replaceAll('_', ' ')}
                </option>
              ))}
            </NativeSelect>
          </Label>
          <Label>
            Outcome code (§22). Keep this empty if the outcome is not known.
            <NativeSelect name="outcomeCode" defaultValue="">
              <option value="">— none yet —</option>
              {detail.decisions.outcomeTaxonomy.map((outcome) => (
                <option key={outcome.code} value={outcome.code}>
                  {outcome.code}: {outcome.meaning}
                </option>
              ))}
            </NativeSelect>
          </Label>
          <Label>
            External authorization reference. Required for OUT-RECOVERY.
            <Input type="text" name="externalAuthorizationRef" />
          </Label>
          <Label>
            Vendor ticket reference
            <Input type="text" name="vendorTicketRef" />
          </Label>
          <Label>
            Evidence-pack SHA-256
            <Input type="text" name="evidencePackSha256" />
          </Label>
          <Label>
            Note. A note adds information only.
            <Input type="text" name="note" />
          </Label>
        </div>
        <Button type="submit" variant="secondary" size="sm" className="self-start">
          Record
        </Button>
      </Form>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Machine suggestions</h3>
        {detail.decisions.machineSuggestions.length === 0 ? (
          <p className="text-muted-foreground">
            The machine has no suggestion. The machine cannot suggest an action against the asset.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {detail.decisions.machineSuggestions.map((suggestion) => (
              <li key={suggestion.decisionId} className="rounded-md border border-dashed border-border px-3 py-2">
                <Badge variant="outline">machine suggestion</Badge>{' '}
                <span className="font-mono text-xs">{suggestion.decisionId}</span>: {suggestion.basis}.{' '}
                <span className="text-muted-foreground">
                  This is advice only. A person must propose it as a decision.
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Proposals</h3>
        {detail.decisions.proposals.length === 0 ? (
          <p className="text-muted-foreground">None yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {detail.decisions.proposals.map((proposal) => (
              <li key={proposal.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
                <Badge variant="secondary">human proposal</Badge>
                <span className="font-medium">{proposal.decisionId}</span>
                <span className="text-muted-foreground">
                  “{proposal.reason}” by {proposal.proposedBy}
                </span>
                <Badge variant={proposal.status === 'proposed' ? 'default' : 'outline'}>
                  {proposal.status}
                </Badge>
                {proposal.resolvedBy !== null && (
                  <span className="text-xs text-muted-foreground">resolved by {proposal.resolvedBy}</span>
                )}
                {proposal.status === 'proposed' && (
                  <Form method="post" className="ml-auto flex gap-2">
                    <input type="hidden" name="proposalId" value={proposal.id} />
                    <input type="hidden" name="intent" value="resolve" />
                    <Button type="submit" name="resolution" value="approve" size="sm">
                      Approve
                    </Button>
                    <Button type="submit" name="resolution" value="reject" variant="outline" size="sm">
                      Reject
                    </Button>
                  </Form>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Form method="post" className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <h4 className="text-sm font-medium">Propose a decision</h4>
        {detail.decisions.proposable.length === 0 ? (
          <p className="text-muted-foreground">
            No decision is available in the “{detail.item.bucket.replaceAll('_', ' ')}” state.
          </p>
        ) : (
          <>
            <input type="hidden" name="intent" value="propose" />
            <input type="hidden" name="seenVersionCount" value={detail.decisions.seenVersionCount} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Label>
                Decision
                <NativeSelect name="decisionId" required>
                  {detail.decisions.proposable.map((decision) => (
                    <option key={decision.id} value={decision.id}>
                      {decision.label}
                      {decision.highImpact ? ' (a second person must approve)' : ''}
                    </option>
                  ))}
                </NativeSelect>
              </Label>
              <Label>
                Approved reason
                <NativeSelect name="reason" required>
                  {[...new Set(detail.decisions.proposable.flatMap((d) => d.canonicalReasons))].map(
                    (reason) => (
                      <option key={reason} value={reason}>
                        {reason}
                      </option>
                    ),
                  )}
                </NativeSelect>
              </Label>
              <Label className="sm:col-span-2">
                Note. A note adds information. A note does not replace the reason.
                <Input type="text" name="note" />
              </Label>
            </div>
            <Button type="submit" size="sm" className="self-start">
              Propose
            </Button>
          </>
        )}
      </Form>

      <p className="text-xs text-muted-foreground">
        The available transitions from “{detail.item.bucket.replaceAll('_', ' ')}” are:{' '}
        {detail.decisions.available.join(', ') || 'none'}. All decisions follow the
        maker-checker procedure.
      </p>
    </SectionCard>
  )
}

export default function CaseScreen() {
  const { detail } = useLoaderData<typeof loader>()
  const actionData = useActionData<typeof action>()

  const renderers: Record<CaseSection, () => React.ReactNode> = {
    reason_and_uncertainty: () => <ReasonSection key="reason" detail={detail} />,
    evidence: () => <EvidenceSection key="evidence" detail={detail} />,
    timeline: () => (
      <SectionCard key="timeline" id="s-timeline" title="Timeline">
        <ol className="relative flex flex-col gap-3 border-l border-border pl-4">
          {detail.timeline.map((entry) => (
            <li key={`${entry.at}-${entry.summary}`}>
              <time dateTime={entry.at} className="font-mono text-xs text-muted-foreground">
                {entry.at.slice(0, 16)}Z
              </time>{' '}
              — {entry.summary} <span className="text-xs text-muted-foreground">({entry.actor})</span>
            </li>
          ))}
        </ol>
      </SectionCard>
    ),
    observations: () => (
      <SectionCard key="observations" id="s-observations" title="Last and next valid observations">
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[14rem_1fr]">
          <dt className="text-muted-foreground">Last valid before the gap</dt>
          <dd>
            {detail.observations.lastValidAt === null ? (
              'none'
            ) : (
              <time dateTime={detail.observations.lastValidAt} className="font-mono text-xs">
                {detail.observations.lastValidAt}
              </time>
            )}
          </dd>
          <dt className="text-muted-foreground">Next valid after the gap</dt>
          <dd>
            {detail.observations.nextValidAt === null ? (
              'none yet'
            ) : (
              <time dateTime={detail.observations.nextValidAt} className="font-mono text-xs">
                {detail.observations.nextValidAt}
              </time>
            )}
          </dd>
        </dl>
        <p className="text-muted-foreground">{detail.observations.note}</p>
      </SectionCard>
    ),
    corridor: () => <CorridorSectionView key="corridor" detail={detail} />,
    peers: () => (
      <SectionCard key="peers" id="s-peers" title="Peer incidents">
        <p className="text-muted-foreground">{detail.peers.note}</p>
        {detail.peers.clusters.map((cluster) => (
          <p key={`${cluster.dimension}-${cluster.key}`}>
            {cluster.dimension} “{cluster.key}”: {cluster.independentCount} independent device(s) of{' '}
            {cluster.activePopulation === null
              ? `unknown active population (fleet observed: ${detail.peers.fleetSize})`
              : `${cluster.activePopulation} active`}{' '}
            in window {cluster.windowStart.slice(11, 16)}–{cluster.windowEnd.slice(11, 16)}Z
          </p>
        ))}
      </SectionCard>
    ),
    policies: () => (
      <SectionCard key="policies" id="s-policies" title="Effective policies">
        <p>
          Reporting policy v{detail.policies.record.version} ({detail.policies.record.provenance}):
          moving every {detail.policies.record.intervals.moving}s, parked every{' '}
          {detail.policies.record.intervals.parked}s, sleep every{' '}
          {detail.policies.record.intervals.sleep}s. The grace factor is ×{detail.policies.record.graceFactor}.
        </p>
        <p className="text-muted-foreground">
          Suppression windows:{' '}
          {detail.policies.suppressionWindows.length === 0 ? 'none declared' : 'listed below'}
        </p>
      </SectionCard>
    ),
    actions_and_decisions: () => <DecisionsSection key="actions" detail={detail} />,
  }

  return (
    <article aria-labelledby="case-heading" className="flex flex-col gap-4">
      <div>
        <Link to="/queue" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to the queue
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 id="case-heading" className="text-2xl font-bold tracking-tight">
            Case {detail.item.assetRef}
          </h1>
          <Badge variant="outline">{detail.item.episodeType.replaceAll('_', ' ')}</Badge>
          <Badge className={TIER_BADGE[detail.item.priority.tier] ?? ''}>{detail.item.priority.tier}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{detail.item.priority.reason}</p>
      </div>

      {actionData?.notice !== undefined && (
        <Alert>
          <AlertDescription role="status">{actionData.notice}</AlertDescription>
        </Alert>
      )}
      {actionData?.refusal !== undefined && (
        <Alert variant="destructive">
          <AlertDescription>{actionData.refusal}</AlertDescription>
        </Alert>
      )}

      {detail.sections.map((section) => renderers[section]())}
    </article>
  )
}

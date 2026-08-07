// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Case review, PRD §9.3.
 *
 * The screen renders `detail.sections` in array order — the mandated §9.3 sequence is data, not
 * layout discipline. Two rules are visible in the structure: supporting evidence, counterevidence
 * and missing expected evidence appear together per hypothesis (FR-QUE-003), and the corridor's
 * table is the primary representation with the map slot below it, disabled until a snapshot is
 * active (§9.3 — a point on a map creates false confidence).
 */

import { Form, Link, useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'

import { requireUser } from '../auth.server.js'
import { getCase, proposeDecision, resolveProposal } from '../data/store.server.js'
import type { CaseDetail, CaseSection } from '../data/case.server.js'

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = requireUser(request, ['case:read'])
  const detail = getCase({
    scopes: user.scopes,
    actor: user.actor,
    episodeId: params['id'] ?? '',
  })
  if (detail === null) throw new Response('No such case', { status: 404 })
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
      ? { notice: `Proposed (${result.proposalId}); awaiting a different approver where required.` }
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
        return { notice: 'Decision applied. The timeline records proposer and approver.' }
      case 'rejected':
        return { notice: 'Proposal rejected; the episode is untouched.' }
      case 'superseded':
        return { refusal: result.message }
      case 'refused':
        return { refusal: result.message }
    }
  }

  throw new Response('Unknown intent', { status: 400 })
}

function ReasonSection({ detail }: { detail: CaseDetail }) {
  return (
    <section aria-labelledby="s-reason">
      <h2 id="s-reason">Reason and uncertainty</h2>
      <p>
        <strong>{detail.reason.headline}</strong>
      </p>
      <p>{detail.reason.uncertainty}</p>
      <p>
        Urgent-eligible: <strong>{detail.reason.urgentEligible ? 'yes' : 'no'}</strong>
      </p>
      <h3>Priority factors</h3>
      {detail.reason.priorityFactors.length === 0 ? (
        <p>No factor raised or lowered priority.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Factor</th>
              <th scope="col">Effect</th>
              <th scope="col">From rule</th>
            </tr>
          </thead>
          <tbody>
            {detail.reason.priorityFactors.map((factor) => (
              <tr key={`${factor.factor}-${factor.fromRule}`}>
                <td>{factor.factor.replaceAll('_', ' ')}</td>
                <td>{factor.effect}</td>
                <td>{factor.fromRule}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function EvidenceSection({ detail }: { detail: CaseDetail }) {
  return (
    <section aria-labelledby="s-evidence">
      <h2 id="s-evidence">Evidence</h2>
      {detail.evidence.unknown !== null && (
        <p>
          <strong>Classification is unknown.</strong> {detail.evidence.unknown.reason}. Missing
          expected evidence: {detail.evidence.unknown.missingExpected.join(', ') || 'none listed'}.
        </p>
      )}
      {detail.evidence.entries.map((entry) => (
        <article key={entry.code} aria-label={`Hypothesis ${entry.code}`}>
          <h3>
            {entry.code} <span className="badge">{entry.band}</span>
            {entry.suppressedBy !== null && (
              <span className="badge"> suppressed by {entry.suppressedBy}</span>
            )}
          </h3>
          <p>{entry.summary}</p>
          <dl>
            <dt>Supporting</dt>
            <dd>{entry.supporting}</dd>
            <dt>Counterevidence</dt>
            <dd>
              {entry.counterevidence.length === 0 ? 'none recorded' : (
                <ul>{entry.counterevidence.map((c) => <li key={c}>{c}</li>)}</ul>
              )}
            </dd>
            <dt>Missing expected evidence</dt>
            <dd>
              {entry.missingExpected.length === 0 ? 'nothing expected was unreadable' : (
                <ul>{entry.missingExpected.map((m) => <li key={m}>{m}</li>)}</ul>
              )}
            </dd>
            <dt>Rule</dt>
            <dd>
              {entry.ruleId} v{entry.ruleVersion}
              {entry.humanReview ? ' — human review required' : ''}
            </dd>
          </dl>
        </article>
      ))}
      {detail.evidence.notApplicable.length > 0 && (
        <details>
          <summary>{detail.evidence.notApplicable.length} rule(s) could not be evaluated</summary>
          <ul>
            {detail.evidence.notApplicable.map((n) => (
              <li key={n.code}>
                {n.code}: missing {n.missingFacts.join(', ')}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

function CorridorSectionView({ detail }: { detail: CaseDetail }) {
  const corridor = detail.corridor
  return (
    <section aria-labelledby="s-corridor">
      <h2 id="s-corridor">Candidate corridor</h2>
      {corridor.state === 'not_computed' && <p>Not computed: {corridor.reason}.</p>}
      {corridor.state === 'corridor_ambiguous' && corridor.result.status === 'corridor_ambiguous' && (
        <p>
          <strong>Ambiguous — withheld.</strong> {corridor.result.reason}
        </p>
      )}
      {corridor.state === 'infeasible' && corridor.result.status === 'infeasible' && (
        <p>
          <strong>Infeasible.</strong> {corridor.result.reason}
        </p>
      )}
      {corridor.state === 'corridor' && corridor.result.status === 'corridor' && (
        <>
          <p>
            <strong>{corridor.result.claim}</strong> — cells every feasible path must cross.
            Snapshot {corridor.result.manifest.snapshotId}, profile{' '}
            {corridor.result.manifest.profile}.
          </p>
          <table>
            <caption>The table is the primary representation; the map below is supplementary.</caption>
            <thead>
              <tr>
                <th scope="col">H3 cell</th>
                <th scope="col">Road</th>
              </tr>
            </thead>
            <tbody>
              {corridor.result.table.map((row) => (
                <tr key={row.h3Cell}>
                  <td>{row.h3Cell}</td>
                  <td>{row.roadNames.length === 0 ? 'unnamed' : row.roadNames.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {/* The map slot sits BELOW the table and the reason summary, §9.3. */}
      <p className="map-slot">Map disabled: no active OSM snapshot. The table above is complete.</p>
    </section>
  )
}

export default function CaseScreen() {
  const { detail } = useLoaderData<typeof loader>()
  const actionData = useActionData<typeof action>()

  const renderers: Record<CaseSection, () => React.ReactNode> = {
    reason_and_uncertainty: () => <ReasonSection key="reason" detail={detail} />,
    evidence: () => <EvidenceSection key="evidence" detail={detail} />,
    timeline: () => (
      <section key="timeline" aria-labelledby="s-timeline">
        <h2 id="s-timeline">Timeline</h2>
        <ol>
          {detail.timeline.map((entry) => (
            <li key={`${entry.at}-${entry.summary}`}>
              <time dateTime={entry.at}>{entry.at.slice(0, 16)}Z</time> — {entry.summary}{' '}
              <small>({entry.actor})</small>
            </li>
          ))}
        </ol>
      </section>
    ),
    observations: () => (
      <section key="observations" aria-labelledby="s-observations">
        <h2 id="s-observations">Last and next valid observations</h2>
        <p>
          Last valid before the gap:{' '}
          {detail.observations.lastValidAt === null ? 'none' : (
            <time dateTime={detail.observations.lastValidAt}>{detail.observations.lastValidAt}</time>
          )}
          <br />
          First valid after the gap:{' '}
          {detail.observations.nextValidAt === null ? 'none yet' : (
            <time dateTime={detail.observations.nextValidAt}>{detail.observations.nextValidAt}</time>
          )}
        </p>
        <p>{detail.observations.note}</p>
      </section>
    ),
    corridor: () => <CorridorSectionView key="corridor" detail={detail} />,
    peers: () => (
      <section key="peers" aria-labelledby="s-peers">
        <h2 id="s-peers">Peer incidents</h2>
        <p>{detail.peers.note}</p>
        {detail.peers.clusters.map((cluster) => (
          <p key={`${cluster.dimension}-${cluster.key}`}>
            {cluster.dimension} “{cluster.key}”: {cluster.independentCount} independent device(s)
            of{' '}
            {cluster.activePopulation === null
              ? `unknown active population (fleet observed: ${detail.peers.fleetSize})`
              : `${cluster.activePopulation} active`}{' '}
            in window {cluster.windowStart.slice(11, 16)}–{cluster.windowEnd.slice(11, 16)}Z
          </p>
        ))}
      </section>
    ),
    policies: () => (
      <section key="policies" aria-labelledby="s-policies">
        <h2 id="s-policies">Effective policies</h2>
        <p>
          Reporting policy v{detail.policies.record.version} ({detail.policies.record.provenance}):
          moving every {detail.policies.record.intervals.moving}s, parked every{' '}
          {detail.policies.record.intervals.parked}s, sleep every{' '}
          {detail.policies.record.intervals.sleep}s; grace ×{detail.policies.record.graceFactor}.
        </p>
        <p>
          Suppression windows:{' '}
          {detail.policies.suppressionWindows.length === 0 ? 'none declared' : 'listed below'}
        </p>
      </section>
    ),
    actions_and_decisions: () => (
      <section key="actions" aria-labelledby="s-actions">
        <h2 id="s-actions">Prior actions and decisions</h2>
        {detail.decisions.prior.length === 0 ? (
          <p>No action has been taken in the world on this episode.</p>
        ) : (
          <ul>
            {detail.decisions.prior.map((action) => (
              <li key={`${action.kind}-${action.at}`}>
                {action.kind.replaceAll('_', ' ')} at{' '}
                <time dateTime={action.at}>{action.at.slice(0, 16)}Z</time> ({action.reference})
              </li>
            ))}
          </ul>
        )}

        <h3>Machine suggestions</h3>
        {detail.decisions.machineSuggestions.length === 0 ? (
          <p>The machine suggests nothing here. It can never suggest action against the asset.</p>
        ) : (
          <ul>
            {detail.decisions.machineSuggestions.map((suggestion) => (
              <li key={suggestion.decisionId}>
                <span className="badge">machine suggestion</span> {suggestion.decisionId}: {suggestion.basis}.
                {' '}Advice only — a human must propose it to make it a decision.
              </li>
            ))}
          </ul>
        )}

        <h3>Proposals</h3>
        {detail.decisions.proposals.length === 0 ? (
          <p>None yet.</p>
        ) : (
          <ul>
            {detail.decisions.proposals.map((proposal) => (
              <li key={proposal.id}>
                <span className="badge">human proposal</span> <strong>{proposal.decisionId}</strong>{' '}
                — “{proposal.reason}” by {proposal.proposedBy}, status <strong>{proposal.status}</strong>
                {proposal.resolvedBy !== null && ` (resolved by ${proposal.resolvedBy})`}
                {proposal.status === 'proposed' && (
                  <Form method="post" style={{ display: 'inline' }}>
                    <input type="hidden" name="proposalId" value={proposal.id} />
                    <input type="hidden" name="intent" value="resolve" />
                    {' '}
                    <button type="submit" name="resolution" value="approve">
                      Approve
                    </button>{' '}
                    <button type="submit" name="resolution" value="reject">
                      Reject
                    </button>
                  </Form>
                )}
              </li>
            ))}
          </ul>
        )}

        <h3>Propose a decision</h3>
        {detail.decisions.proposable.length === 0 ? (
          <p>No decision applies in the “{detail.item.bucket.replaceAll('_', ' ')}” state.</p>
        ) : (
          <Form method="post">
            <input type="hidden" name="intent" value="propose" />
            <input
              type="hidden"
              name="seenVersionCount"
              value={detail.decisions.seenVersionCount}
            />
            <p>
              <label>
                Decision{' '}
                <select name="decisionId" required>
                  {detail.decisions.proposable.map((decision) => (
                    <option key={decision.id} value={decision.id}>
                      {decision.label}
                      {decision.highImpact ? ' (requires a second approver)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            </p>
            <p>
              <label>
                Canonical reason{' '}
                <select name="reason" required>
                  {[...new Set(detail.decisions.proposable.flatMap((d) => d.canonicalReasons))].map(
                    (reason) => (
                      <option key={reason} value={reason}>
                        {reason}
                      </option>
                    ),
                  )}
                </select>
              </label>
            </p>
            <p>
              <label>
                Note (explains; never substitutes for the reason){' '}
                <input type="text" name="note" />
              </label>
            </p>
            <button type="submit">Propose</button>
          </Form>
        )}
      </section>
    ),
  }

  return (
    <article aria-labelledby="case-heading">
      <p>
        <Link to="/queue">← Back to queue</Link>
      </p>
      <h1 id="case-heading">
        Case {detail.item.assetRef} — {detail.item.episodeType.replaceAll('_', ' ')}
      </h1>
      <p>
        <span className={`badge tier-${detail.item.priority.tier}`}>{detail.item.priority.tier}</span>{' '}
        {detail.item.priority.reason}
      </p>
      {actionData?.notice !== undefined && <p role="status">{actionData.notice}</p>}
      {actionData?.refusal !== undefined && (
        <p className="conflict" role="alert">
          {actionData.refusal}
        </p>
      )}
      {detail.sections.map((section) => renderers[section]())}
    </article>
  )
}

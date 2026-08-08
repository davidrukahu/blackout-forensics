// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Release C exit criterion, PRD §16.3: one scenario, end to end — import through episode,
 * evidence, review, approval and outcome to a reproducible report — with no automated
 * consequential action anywhere in the path.
 *
 * The negative claim is checked against the records the run itself produced: every transition
 * that touches the world names two different humans, and everything machine-authored is either
 * evidence or advice. The run writes release/release-c-e2e.json as the acceptance-pack artifact.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router'

import {
  buildSlaReport,
  reportToCsv,
  reportToPdf,
  sha256Canonical,
  verifyReportIntegrity,
  type SlaReportInput,
} from '@blackout/core'

import { auditTrail, getQueue, resetStoreForTesting } from './data/store.server.js'
import { action as caseAction, loader as caseLoader } from './routes/case.js'
import { action as queueAction, loader as queueLoader } from './routes/queue.js'

const NOW = '2026-08-05T12:00:00.000Z'
const ANALYST_SCOPES = ['queue:read', 'queue:assign', 'case:read']

const request = (path: string, role: string, body?: Record<string, string>) => {
  const init: RequestInit =
    body === undefined
      ? { headers: { cookie: `bf-role=${role}` } }
      : {
          method: 'POST',
          body: new URLSearchParams(body),
          headers: { cookie: `bf-role=${role}` },
        }
  const id = path.split('/').at(-1) ?? ''
  return {
    request: new Request(`http://app.test${path}`, init),
    params: path.startsWith('/cases/') ? { id } : {},
    context: {},
  } as unknown as LoaderFunctionArgs & ActionFunctionArgs
}

interface Trace {
  stage: string
  detail: Record<string, unknown>
}
const trace: Trace[] = []

let urgentId = ''

beforeAll(() => {
  resetStoreForTesting()
})

describe('§16.3: the full path, in order', () => {
  it('import and episode: the corpus flows through sampler and classifier into the queue', async () => {
    const data = await queueLoader(request('/queue?view=view-urgent', 'analyst'))
    expect(data.items.length).toBeGreaterThan(0)
    const urgent = data.items[0]!
    urgentId = urgent.episodeId
    expect(urgent.band).toBe('direct')
    trace.push({
      stage: 'import_episode',
      detail: { episodeId: urgentId, band: urgent.band, priority: urgent.priority.reason },
    })
  })

  it('evidence: the case shows the hypothesis with rule version, counter and missing evidence', async () => {
    const { detail } = await caseLoader(request(`/cases/${urgentId}`, 'analyst'))
    const hypothesis = detail.evidence.entries[0]!
    expect(hypothesis.code).toBe('H-POWER')
    expect(hypothesis.ruleVersion).toBe('1.1.0')
    expect(Array.isArray(hypothesis.missingExpected)).toBe(true)
    trace.push({
      stage: 'evidence',
      detail: { hypothesis: hypothesis.code, rule: `${hypothesis.ruleId}@${hypothesis.ruleVersion}` },
    })
  })

  it('review: an analyst claims and proposes with a canonical reason', async () => {
    const claim = await queueAction(request('/queue', 'analyst', {
      intent: 'assign',
      episodeId: urgentId,
      expectedVersion: String(
        getQueue({ scopes: ANALYST_SCOPES, now: NOW }).items.find((i) => i.episodeId === urgentId)!
          .version,
      ),
    }))
    expect(claim).toEqual({ assigned: 1 })

    const { detail } = await caseLoader(request(`/cases/${urgentId}`, 'analyst'))
    const proposed = await caseAction(request(`/cases/${urgentId}`, 'analyst', {
      intent: 'propose',
      decisionId: 'classify_suspicious',
      reason: 'device telemetry supports possible tracker interference',
      seenVersionCount: String(detail.decisions.seenVersionCount),
    }))
    expect(proposed.notice).toContain('The proposal is saved')
    trace.push({ stage: 'review', detail: { proposedBy: 'dev:analyst', decision: 'classify_suspicious' } })
  })

  it('approval: a different human approves; the record names both', async () => {
    const { detail } = await caseLoader(request(`/cases/${urgentId}`, 'supervisor'))
    const proposal = detail.decisions.proposals[0]!
    const resolved = await caseAction(request(`/cases/${urgentId}`, 'supervisor', {
      intent: 'resolve', proposalId: proposal.id, resolution: 'approve',
    }))
    expect(resolved.notice).toContain('applied')

    const { detail: after } = await caseLoader(request(`/cases/${urgentId}`, 'supervisor'))
    const applied = after.timeline.at(-1)!
    expect(applied.actor).toBe('dev:analyst')
    expect(applied.summary).toContain('approved by dev:supervisor')
    trace.push({ stage: 'approval', detail: { actor: applied.actor, summary: applied.summary } })
  })

  it('outcome: the externally-performed check is recorded against the §22 taxonomy', async () => {
    const recorded = await caseAction(request(`/cases/${urgentId}`, 'analyst', {
      intent: 'record_outcome',
      actionKind: 'field_verification',
      outcomeCode: 'OUT-FIELD-CHECK',
      note: 'wiring found cut; documented by field partner',
    }))
    expect(recorded.notice).toContain('recorded')
    trace.push({ stage: 'outcome', detail: { outcome: 'OUT-FIELD-CHECK' } })
  })

  it('report: reproducible, with manifest hash verified twice', async () => {
    const { items } = getQueue({ scopes: ANALYST_SCOPES, now: NOW })
    const input: SlaReportInput = {
      reportId: 'rpt-release-c',
      generatedAt: NOW,
      window: { from: '2026-08-05T00:00:00.000Z', to: NOW },
      deliveryLagsS: [3, 3, 4, 4, 5],
      episodeDurationsS: items
        .filter((i) => i.ageS > 0)
        .map((i) => i.ageS)
        .slice(0, 5),
      openedEpisodes: items.length,
      retractedEpisodes: 0,
      activeAssetHours: items.length * 6,
      devicesWithEpisodes: new Set(items.map((i) => i.deviceRef)).size,
      devicesWithRepeats: 0,
      backfill: { denominator: 10, numerator: 10, excluded: 0, exclusionReasons: {} },
      completeness: { denominator: items.length, numerator: items.length, excluded: 0, exclusionReasons: {} },
      exclusions: [],
      clockBasis: 'device_time',
      ruleVersion: '1.1.0',
      factVocabularyVersion: '1.0.0',
      mapSnapshotId: null,
      timeToReviewS: [600],
      timeToActionS: [1200],
      unresolvedAging: [{ bucket: '7d', count: 0 }],
      cohorts: [],
    }
    const report = buildSlaReport(input)
    const again = buildSlaReport(input)
    expect(report).toEqual(again)
    expect(verifyReportIntegrity(report)).toBe(true)
    expect(reportToCsv(report)).toBe(reportToCsv(again))
    expect(reportToPdf(report).equals(reportToPdf(again))).toBe(true)
    trace.push({ stage: 'report', detail: { integrity: report.manifest.integritySha256 } })
  })

  it('no automated consequential action anywhere in the path', async () => {
    // 1. Machine actors in this run's audit trail did nothing but observe and record.
    const machineActions = auditTrail().filter((event) => event.actor.startsWith('system:'))
    for (const event of machineActions) {
      expect(event.action).toMatch(/tombstone|sensitive_view/)
    }

    // 2. The episode's world-relevant transition was proposed and approved by different humans.
    const { detail } = await caseLoader(request(`/cases/${urgentId}`, 'supervisor'))
    const decision = detail.timeline.filter((entry) => entry.summary.includes('approved by'))
    expect(decision).toHaveLength(1)
    expect(decision[0]!.actor).not.toBe('system:classifier')

    // 3. Machine suggestions in the whole store exclude world-affecting decisions.
    for (const item of getQueue({ scopes: ANALYST_SCOPES, now: NOW }).items) {
      const caseDetail = await caseLoader(request(`/cases/${item.episodeId}`, 'supervisor'))
      for (const suggestion of caseDetail.detail.decisions.machineSuggestions) {
        expect(suggestion.decisionId).toBe('classify_explained')
      }
    }
    trace.push({ stage: 'no_automated_consequence', detail: { machineAudit: machineActions.length } })
  })

  it('writes the acceptance-pack artifact', () => {
    expect(trace.map((entry) => entry.stage)).toEqual([
      'import_episode', 'evidence', 'review', 'approval', 'outcome', 'report',
      'no_automated_consequence',
    ])
    const artifact = {
      release: 'C',
      exit: 'PRD §16.3: import → episode → evidence → review → approval → outcome → reproducible report',
      generatedAt: NOW,
      stages: trace,
      integritySha256: sha256Canonical(trace),
    }
    mkdirSync(join(process.cwd(), 'release'), { recursive: true })
    writeFileSync(
      join(process.cwd(), 'release', 'release-c-e2e.json'),
      `${JSON.stringify(artifact, null, 2)}\n`,
    )
  })
})

// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * §22's taxonomy and the FR-OUT controls — including §17.4's negative claim, proven against the
 * vocabulary itself: the product records what external parties did; it cannot do.
 */

import { describe, expect, it } from 'vitest'

import {
  ACTION_KINDS,
  IncoherentTimesError,
  MissingAuthorizationError,
  OUTCOME_TAXONOMY,
  PROHIBITED_PRODUCT_CAPABILITIES,
  UnknownOutcomeError,
  actionMetrics,
  addLabel,
  adjudicate,
  agingReport,
  completeAction,
  datasetView,
  isDisputed,
  recordAction,
} from './outcomes.js'

const T0 = '2026-08-05T08:00:00.000Z'
const T1 = '2026-08-05T10:00:00.000Z'
const T2 = '2026-08-06T10:00:00.000Z'

const fieldCheck = () =>
  recordAction({
    id: 'act-1', episodeId: 'ep-1', actionKind: 'field_verification',
    owner: 'ops-1', startedAt: T0,
  })

describe('the §22 taxonomy', () => {
  it('carries all seventeen codes with their confirmation sources', () => {
    expect(OUTCOME_TAXONOMY).toHaveLength(17)
    for (const outcome of OUTCOME_TAXONOMY) {
      expect(outcome.code).toMatch(/^OUT-/)
      expect(outcome.confirmationSource.length).toBeGreaterThan(5)
    }
  })

  it('rejects a code outside the taxonomy', () => {
    expect(() =>
      completeAction(fieldCheck(), { completedAt: T1, outcomeCode: 'OUT-INVENTED' }),
    ).toThrow(UnknownOutcomeError)
  })
})

describe('§17.4: the product demonstrably cannot act on the world', () => {
  it('no action kind contains a prohibited capability word', () => {
    for (const kind of ACTION_KINDS) {
      for (const capability of PROHIBITED_PRODUCT_CAPABILITIES) {
        expect(kind.toLowerCase()).not.toContain(capability)
      }
    }
  })

  it('no outcome meaning claims the product performed the act — every source is external', () => {
    // The recovery outcome is the sharpest case: its confirmation source is an external
    // authorization, and recording it without that reference throws.
    const recovery = OUTCOME_TAXONOMY.find((o) => o.code === 'OUT-RECOVERY')!
    expect(recovery.confirmationSource).toContain('External authorization')
    expect(recovery.requiresExternalAuthorization).toBe(true)
  })
})

describe('FR-OUT-002: workflow outcome is not legal authorization', () => {
  it('OUT-RECOVERY without an external authorization reference is refused', () => {
    expect(() =>
      completeAction(fieldCheck(), { completedAt: T1, outcomeCode: 'OUT-RECOVERY' }),
    ).toThrow(MissingAuthorizationError)
  })

  it('with the reference, the record holds a pointer to the authority', () => {
    const completed = completeAction(fieldCheck(), {
      completedAt: T1,
      outcomeCode: 'OUT-RECOVERY',
      externalAuthorizationRef: 'court-order-2026-1441',
    })
    expect(completed.externalAuthorizationRef).toBe('court-order-2026-1441')
  })
})

describe('FR-OUT-003: the metrics reproduce from the record', () => {
  it('time-to-action, time-to-complete and cost come straight off the fields', () => {
    const completed = completeAction(fieldCheck(), {
      completedAt: T1,
      outcomeCode: 'OUT-FIELD-CHECK',
      costAmount: 1500,
      costCurrency: 'KES',
      evidenceRefs: ['photo-001'],
    })
    const metrics = actionMetrics(completed, '2026-08-05T07:00:00.000Z')
    expect(metrics.timeToActionS).toBe(3600)
    expect(metrics.timeToCompleteS).toBe(7200)
    expect(metrics.cost).toEqual({ amount: 1500, currency: 'KES' })
  })

  it('completion cannot precede the start', () => {
    expect(() =>
      completeAction(fieldCheck(), { completedAt: '2026-08-05T07:00:00.000Z' }),
    ).toThrow(IncoherentTimesError)
  })
})

describe('FR-OUT-004: unresolved and unknown without a forced label', () => {
  it('aging separates open, unresolved and unlabelled — nothing folds into done', () => {
    const open = recordAction({
      id: 'act-open', episodeId: 'ep-2', actionKind: 'vendor_ticket', owner: 'ops-1', startedAt: T0,
    })
    const unresolved = completeAction(fieldCheck(), {
      completedAt: T1, outcomeCode: 'OUT-UNRESOLVED',
    })
    const unlabelled = completeAction(
      recordAction({
        id: 'act-3', episodeId: 'ep-3', actionKind: 'technician_visit', owner: 'ops-2', startedAt: T0,
      }),
      { completedAt: T1 },
    )
    const resolved = completeAction(
      recordAction({
        id: 'act-4', episodeId: 'ep-4', actionKind: 'field_verification', owner: 'ops-2', startedAt: T0,
      }),
      { completedAt: T1, outcomeCode: 'OUT-POWER-REPAIRED' },
    )

    const report = agingReport([open, unresolved, unlabelled, resolved], T2)
    expect(report.open.map((a) => a.id)).toEqual(['act-open'])
    expect(report.unresolved.map((a) => a.id)).toEqual(['act-1'])
    expect(report.unlabelled.map((a) => a.id)).toEqual(['act-3'])
    expect(report.resolved).toBe(1)
    expect(report.open[0]!.ageS).toBe(26 * 3600)
  })
})

describe('FR-OUT-005: disagreement is retained through adjudication', () => {
  const base = { episodeId: 'ep-5', labels: [], final: null }

  it('labels accumulate; adjudication settles without erasing', () => {
    let adjudication = addLabel(base, {
      reviewer: 'analyst-a', outcomeCode: 'OUT-EXPECTED', at: T0, rationale: 'sleep pattern matches',
    })
    adjudication = addLabel(adjudication, {
      reviewer: 'analyst-b', outcomeCode: 'OUT-UNRESOLVED', at: T1, rationale: 'provenance is weak',
    })
    expect(isDisputed(adjudication)).toBe(true)

    const settled = adjudicate(adjudication, {
      outcomeCode: 'OUT-EXPECTED', adjudicatedBy: 'supervisor-1', at: T2,
    })
    expect(settled.final?.outcomeCode).toBe('OUT-EXPECTED')
    expect(settled.labels).toHaveLength(2)
  })

  it('evaluation datasets can exclude or isolate disputed labels from the same record', () => {
    const agreed = adjudicate(
      addLabel(base, { reviewer: 'a', outcomeCode: 'OUT-VENDOR', at: T0, rationale: 'ticket matches' }),
      { outcomeCode: 'OUT-VENDOR', adjudicatedBy: 's', at: T1 },
    )
    const disputed = addLabel(
      addLabel({ ...base, episodeId: 'ep-6' }, {
        reviewer: 'a', outcomeCode: 'OUT-VENDOR', at: T0, rationale: 'x',
      }),
      { reviewer: 'b', outcomeCode: 'OUT-FALSE', at: T1, rationale: 'y' },
    )

    expect(datasetView([agreed, disputed], { disputed: 'exclude' })).toEqual([agreed])
    expect(datasetView([agreed, disputed], { disputed: 'only' })).toEqual([disputed])
    expect(datasetView([agreed, disputed], { disputed: 'include' })).toHaveLength(2)
  })
})

// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { AssignmentRegistry } from './assignments.js'
import { contains, detectDefects, overlaps, resolveAt } from './temporal.js'
import {
  PolicyRegistry,
  expectedNextReport,
  expectedNextReportAt,
  findSuppression,
  type ReportingPolicyRecord,
} from './reporting-policy.js'

const JAN = '2026-01-01T00:00:00.000Z'
const FEB = '2026-02-01T00:00:00.000Z'
const MAR = '2026-03-01T00:00:00.000Z'
const APR = '2026-04-01T00:00:00.000Z'

describe('half-open intervals', () => {
  // Every off-by-one in temporal data comes from getting this boundary wrong.
  it('includes validFrom and excludes validTo', () => {
    const interval = { validFrom: FEB, validTo: MAR }
    expect(contains(interval, FEB)).toBe(true)
    expect(contains(interval, MAR)).toBe(false)
    expect(contains(interval, '2026-02-28T23:59:59.999Z')).toBe(true)
  })

  it('treats back-to-back periods as neither overlapping nor gapped', () => {
    const a = { validFrom: JAN, validTo: FEB }
    const b = { validFrom: FEB, validTo: MAR }
    expect(overlaps(a, b)).toBe(false)
    expect(detectDefects('k', [a, b])).toEqual([])
  })

  it('treats a null upper bound as still in force', () => {
    expect(contains({ validFrom: JAN, validTo: null }, '2099-01-01T00:00:00.000Z')).toBe(true)
  })

  it('resolution and containment always agree, for any instant', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 120 }), (dayOffset) => {
        const at = new Date(Date.parse(JAN) + dayOffset * 86400_000).toISOString()
        const records = [
          { validFrom: JAN, validTo: FEB, tag: 'a' },
          { validFrom: FEB, validTo: MAR, tag: 'b' },
          { validFrom: MAR, validTo: null, tag: 'c' },
        ]
        const resolved = resolveAt(records, at)
        const expected = records.find((r) => contains(r, at))
        return resolved?.tag === expected?.tag
      }),
      { numRuns: 200 },
    )
  })
})

describe('assignment resolution — FR-AST-002', () => {
  const registry = new AssignmentRegistry()
    .addAssetDevice({ assetRef: 'ast_1', deviceRef: 'dev_a', role: 'primary', validFrom: JAN, validTo: MAR })
    .addAssetDevice({ assetRef: 'ast_1', deviceRef: 'dev_b', role: 'primary', validFrom: MAR, validTo: null })
    .addDeviceSim({ deviceRef: 'dev_a', simRef: 'sim_1', providerRef: 'safaricom', validFrom: JAN, validTo: null })
    .addDeviceSim({ deviceRef: 'dev_b', simRef: 'sim_2', providerRef: 'airtel', validFrom: MAR, validTo: null })

  it('events before and after a reassignment resolve to the correct history', () => {
    expect(registry.resolveDevice('dev_a', FEB)?.assetRef).toBe('ast_1')
    // dev_a was removed in March; a later event from it belongs to no asset.
    expect(registry.resolveDevice('dev_a', APR)).toBeUndefined()
    expect(registry.resolveDevice('dev_b', APR)?.assetRef).toBe('ast_1')
  })

  it('resolves the SIM in force at the same instant, not the current one', () => {
    expect(registry.resolveDevice('dev_a', FEB)?.simRef).toBe('sim_1')
    expect(registry.resolveDevice('dev_b', APR)?.providerRef).toBe('airtel')
  })

  it('returns nothing for a device that was never assigned', () => {
    expect(registry.resolveDevice('dev_unknown', FEB)).toBeUndefined()
  })
})

describe('primary and secondary trackers — FR-AST-003', () => {
  const registry = new AssignmentRegistry()
    .addAssetDevice({ assetRef: 'ast_2', deviceRef: 'dev_p', role: 'primary', validFrom: JAN, validTo: null })
    .addAssetDevice({ assetRef: 'ast_2', deviceRef: 'dev_s', role: 'secondary', validFrom: JAN, validTo: null })

  it('allows two devices on one asset when their roles differ', () => {
    const devices = registry.resolveAsset('ast_2', FEB)
    expect(devices.map((d) => d.deviceRef)).toEqual(['dev_p', 'dev_s'])
    expect(registry.defects()).toEqual([])
  })

  it('keeps the role, so peer correlation can exclude a duplicated observer', () => {
    // Two trackers on one motorcycle are not two independent devices (FR-COR-003). The role is
    // what makes that distinction available downstream.
    const devices = registry.resolveAsset('ast_2', FEB)
    expect(new Set(devices.map((d) => d.assetRef)).size).toBe(1)
    expect(devices.filter((d) => d.role === 'secondary')).toHaveLength(1)
  })

  it('flags two devices claiming the same role at the same time', () => {
    const broken = new AssignmentRegistry()
      .addAssetDevice({ assetRef: 'ast_3', deviceRef: 'dev_x', role: 'primary', validFrom: JAN, validTo: null })
      .addAssetDevice({ assetRef: 'ast_3', deviceRef: 'dev_y', role: 'primary', validFrom: FEB, validTo: null })
    const overlapsFound = broken.defects().filter((d) => d.kind === 'overlap')
    expect(overlapsFound.length).toBeGreaterThan(0)
  })
})

describe('defect detection — FR-AST-005', () => {
  it('flags a device attached to two assets at once', () => {
    const registry = new AssignmentRegistry()
      .addAssetDevice({ assetRef: 'ast_4', deviceRef: 'dev_z', role: 'primary', validFrom: JAN, validTo: MAR })
      .addAssetDevice({ assetRef: 'ast_5', deviceRef: 'dev_z', role: 'primary', validFrom: FEB, validTo: null })
    expect(registry.defects().some((d) => d.kind === 'overlap' && d.key === 'device:dev_z')).toBe(true)
  })

  it('reports a gap in asset coverage without calling it an overlap', () => {
    const defects = detectDefects('asset:ast_6:primary', [
      { validFrom: JAN, validTo: FEB, tag: 'first' },
      { validFrom: MAR, validTo: null, tag: 'second' },
    ])
    const gap = defects.find((d) => d.kind === 'gap')
    expect(gap?.from).toBe(FEB)
    expect(gap?.to).toBe(MAR)
    expect(defects.some((d) => d.kind === 'overlap')).toBe(false)
  })

  it('flags an inverted or zero-length record as malformed', () => {
    expect(detectDefects('k', [{ validFrom: MAR, validTo: JAN }])[0]?.kind).toBe('malformed')
    expect(detectDefects('k', [{ validFrom: JAN, validTo: JAN }])[0]?.kind).toBe('malformed')
  })

  it('reports unmapped devices and coverage, the number a pilot is gated on', () => {
    const registry = new AssignmentRegistry().addAssetDevice({
      assetRef: 'ast_7', deviceRef: 'dev_mapped', role: 'primary', validFrom: JAN, validTo: null,
    })
    const observed = [
      { deviceRef: 'dev_mapped', at: FEB },
      { deviceRef: 'dev_mapped', at: MAR },
      { deviceRef: 'dev_orphan', at: FEB },
    ]
    expect(registry.unmappedDevices(observed)).toEqual(['dev_orphan'])
    expect(registry.coverage(observed)).toBeCloseTo(2 / 3)
  })
})

describe('reporting policies — FR-POL-001', () => {
  const policy: ReportingPolicyRecord = {
    cohort: 'teltonika:FMB920',
    intervals: { moving: 60, ignition_on: 120, parked: 300, sleep: 3600, exception: 30 },
    provenance: 'declared',
    sleepAfterStationaryS: 900,
    graceFactor: 1.5,
    version: '1.0.0',
  }

  it('computes a due time and a later deadline', () => {
    const expected = expectedNextReport({ lastReportAt: JAN, state: 'moving', policy })
    expect(expected.dueAt).toBe('2026-01-01T00:01:00.000Z')
    expect(expected.deadlineAt).toBe('2026-01-01T00:01:30.000Z')
  })

  it('adds measured delivery lag rather than scaling by it', () => {
    // Delivery lag is a property of the platform, not the interval: a slow platform delays a 60s
    // and a 3600s policy by the same amount.
    const fast = expectedNextReport({ lastReportAt: JAN, state: 'moving', policy })
    const slow = expectedNextReport({ lastReportAt: JAN, state: 'moving', policy, deliveryLagP95S: 120 })
    const delta = Date.parse(slow.deadlineAt) - Date.parse(fast.deadlineAt)
    expect(delta).toBe(120_000)

    const slowSleep = expectedNextReport({ lastReportAt: JAN, state: 'sleep', policy, deliveryLagP95S: 120 })
    const fastSleep = expectedNextReport({ lastReportAt: JAN, state: 'sleep', policy })
    expect(Date.parse(slowSleep.deadlineAt) - Date.parse(fastSleep.deadlineAt)).toBe(120_000)
  })

  it('covers every motion state', () => {
    for (const state of ['moving', 'ignition_on', 'parked', 'sleep', 'exception'] as const) {
      expect(expectedNextReport({ lastReportAt: JAN, state, policy }).intervalS).toBe(
        policy.intervals[state],
      )
    }
  })
})

describe('sleep provenance — the dominant false-positive source', () => {
  const base: ReportingPolicyRecord = {
    cohort: 'c', intervals: { moving: 60, ignition_on: 120, parked: 300, sleep: 3600, exception: 30 },
    provenance: 'declared', sleepAfterStationaryS: 900, graceFactor: 1.5, version: '1.0.0',
  }

  it('marks a sleep deadline weak when the interval was not declared', () => {
    for (const provenance of ['measured', 'assumed'] as const) {
      const expected = expectedNextReport({
        lastReportAt: JAN, state: 'sleep', policy: { ...base, provenance },
      })
      expect(expected.weakBasis).toBe(true)
      expect(expected.provenance).toBe(provenance)
    }
  })

  it('does not weaken a declared sleep policy', () => {
    expect(expectedNextReport({ lastReportAt: JAN, state: 'sleep', policy: base }).weakBasis).toBe(false)
  })

  it('does not weaken non-sleep states, whatever the provenance', () => {
    const expected = expectedNextReport({
      lastReportAt: JAN, state: 'moving', policy: { ...base, provenance: 'assumed' },
    })
    expect(expected.weakBasis).toBe(false)
  })

  it('keeps "does not sleep" distinct from "nobody knows"', () => {
    const neverSleeps: ReportingPolicyRecord = { ...base, sleepAfterStationaryS: null }
    expect(neverSleeps.sleepAfterStationaryS).toBeNull()
    expect(base.sleepAfterStationaryS).toBe(900)
  })
})

describe('policy change mid-episode — FR-TEN-003', () => {
  const registry = new PolicyRegistry()
    .add({
      cohort: 'fleet', intervals: { moving: 60, ignition_on: 60, parked: 300, sleep: 3600, exception: 30 },
      provenance: 'declared', sleepAfterStationaryS: 900, graceFactor: 1.5, version: '1.0.0',
      validFrom: JAN, validTo: MAR,
    })
    .add({
      cohort: 'fleet', intervals: { moving: 300, ignition_on: 300, parked: 900, sleep: 3600, exception: 30 },
      provenance: 'declared', sleepAfterStationaryS: 900, graceFactor: 1.5, version: '2.0.0',
      validFrom: MAR, validTo: null,
    })

  it('replays a past interval under the policy effective then, not the current one', () => {
    const past = expectedNextReportAt({ registry, cohort: 'fleet', lastReportAt: FEB, state: 'moving' })
    const now = expectedNextReportAt({ registry, cohort: 'fleet', lastReportAt: APR, state: 'moving' })

    expect(past?.intervalS).toBe(60)
    expect(past?.policyVersion).toBe('1.0.0')
    expect(now?.intervalS).toBe(300)
    expect(now?.policyVersion).toBe('2.0.0')
  })

  it('would invent four missing reports for every real one if applied backwards', () => {
    // The concrete cost of getting FR-TEN-003 wrong, stated as a test so it cannot be argued with.
    const correct = expectedNextReportAt({ registry, cohort: 'fleet', lastReportAt: FEB, state: 'moving' })
    const wrong = expectedNextReport({
      lastReportAt: FEB,
      state: 'moving',
      policy: { ...registry.resolve('fleet', APR)!, intervals: registry.resolve('fleet', APR)!.intervals },
    })
    expect(wrong.intervalS / (correct?.intervalS ?? 1)).toBe(5)
  })

  it('returns nothing for a cohort with no effective policy, rather than guessing', () => {
    expect(expectedNextReportAt({ registry, cohort: 'unknown', lastReportAt: FEB, state: 'moving' }))
      .toBeUndefined()
  })
})

describe('suppression windows — FR-POL-004', () => {
  const windows = [
    { reason: 'maintenance' as const, from: FEB, to: MAR, approvedBy: 'ops_lead' },
  ]

  it('finds a window covering the instant, half-open like every other interval', () => {
    expect(findSuppression(windows, '2026-02-15T00:00:00.000Z')?.reason).toBe('maintenance')
    expect(findSuppression(windows, FEB)?.reason).toBe('maintenance')
    expect(findSuppression(windows, MAR)).toBeUndefined()
  })

  it('records who approved it, so suppression stays auditable rather than silent', () => {
    expect(findSuppression(windows, '2026-02-15T00:00:00.000Z')?.approvedBy).toBe('ops_lead')
  })
})

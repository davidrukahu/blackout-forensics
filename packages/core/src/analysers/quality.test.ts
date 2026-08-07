// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { generateBaseline, runScenario } from '@blackout/generator'

import { percentiles, ratio, emptyDenominated } from './distribution.js'
import {
  analyseCompleteness,
  analyseIntegrity,
  analysePlatformConfiguration,
  analyseTiming,
  cohortOf,
  type ObservedEvent,
} from './quality.js'

const CTX = { seed: 31, startAt: '2026-08-05T06:00:00.000Z' }
const asObserved = (events: unknown[]): ObservedEvent[] => events as ObservedEvent[]

describe('denominators', () => {
  it('reports an unknown ratio over an empty population, never zero', () => {
    // Reporting 0% completeness for a device that produced no events is a fabricated finding.
    expect(ratio(emptyDenominated())).toBeNull()
    expect(ratio({ denominator: 4, numerator: 1, excluded: 0, exclusionReasons: {} })).toBe(0.25)
  })

  it('never interpolates a percentile — every value named is one that occurred', () => {
    const values = [1, 2, 3, 4, 100]
    const p = percentiles(values)
    for (const v of [p.p50, p.p95, p.p99, p.min, p.max]) {
      expect(values).toContain(v)
    }
  })

  it('percentiles stay ordered and in range for any sample', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 1, maxLength: 200 }), (xs) => {
        const p = percentiles(xs)
        return (
          p.count === xs.length &&
          p.min! <= p.p50! && p.p50! <= p.p95! && p.p95! <= p.p99! && p.p99! <= p.max! &&
          xs.includes(p.p95!)
        )
      }),
      { numRuns: 300 },
    )
  })

  it('returns nulls rather than NaN for an empty sample', () => {
    expect(percentiles([])).toEqual({ count: 0, p50: null, p95: null, p99: null, min: null, max: null })
  })
})

describe('completeness — FR-TEL-006', () => {
  it('groups by model, source and day, carrying denominators', () => {
    const { events } = generateBaseline({ ...CTX, pointCount: 20 })
    const reports = analyseCompleteness(asObserved(events))

    expect(reports.length).toBeGreaterThan(0)
    const report = reports[0]!
    expect(report.cohort.model).toBe('FMB920')
    expect(report.cohort.day).toBe('2026-08-05')
    expect(report.groups.position.denominator).toBeGreaterThan(0)
    expect(report.groups.position.numerator).toBe(report.groups.position.denominator)
  })

  it('excludes sleeping devices rather than counting them as incomplete', () => {
    // Deep Sleep strips IO elements by design. Counting those rows as missing data blames the fleet
    // for behaving exactly as documented, and buries genuine gaps in noise.
    const { events } = runScenario('teltonika-deep-sleep', CTX)
    const reports = analyseCompleteness(asObserved(events))
    const network = reports.flatMap((r) => [r.groups.network])

    const totalExcluded = network.reduce((sum, d) => sum + d.excluded, 0)
    expect(totalExcluded).toBeGreaterThan(0)
    for (const d of network) {
      expect(d.exclusionReasons['device_asleep'] ?? 0).toBe(d.excluded)
    }
  })

  it('counts a genuinely missing field group as incomplete', () => {
    const { events } = generateBaseline({ ...CTX, pointCount: 6 })
    const stripped = asObserved(events).map((e) => ({ ...e, power: null }))
    const report = analyseCompleteness(stripped)[0]!
    expect(report.groups.power.numerator).toBe(0)
    expect(report.groups.power.denominator).toBe(6)
  })

  it('labels an unknown model rather than dropping the cohort', () => {
    const event = { source: 's', device_ref: 'dev_1', received_at: '2026-08-05T06:00:00.000Z' }
    expect(cohortOf(event).model).toBe('unknown')
  })
})

describe('timing — FR-TEL-004, FR-POL-002', () => {
  it('separates the platform leg from the device leg', () => {
    // A slow platform is a vendor SLA matter; a silent device is a recovery matter. One last_seen
    // timestamp cannot tell them apart, which is the reason three times are carried.
    const { events } = generateBaseline({ ...CTX, pointCount: 30, deliveryLagS: 10 })
    const timing = analyseTiming(asObserved(events))

    expect(timing.platformLagS.count).toBe(30)
    expect(timing.deviceToVendorLagS.count).toBe(30)
    expect(timing.totalLagS.p50).toBeGreaterThan(timing.platformLagS.p50!)
  })

  it('flags a device clock running ahead of receipt as impossible without skew', () => {
    const { events } = generateBaseline({ ...CTX, pointCount: 5 })
    const skewed = asObserved(events).map((e, i) =>
      i === 2 ? { ...e, device_time: '2027-01-01T00:00:00.000Z' } : e,
    )
    const timing = analyseTiming(skewed)

    expect(timing.negativeLagCount).toBe(1)
    expect(timing.clockSkewSuspectDevices).toHaveLength(1)
  })

  it('detects the drifting-clock scenario without touching receipt time', () => {
    const { events } = runScenario('drifting-device-clock', CTX)
    const timing = analyseTiming(asObserved(events))
    // The clock jumps backwards, so lag jumps forwards — visible in the spread, not as negative lag.
    expect(timing.totalLagS.max! - timing.totalLagS.min!).toBeGreaterThan(2000)
  })

  it('counts events that cannot support a lag calculation at all', () => {
    const timing = analyseTiming([
      { source: 's', device_ref: 'd', received_at: '2026-08-05T06:00:00.000Z' },
    ])
    expect(timing.insufficientTimes).toBe(1)
    expect(timing.totalLagS.count).toBe(0)
  })
})

describe('integrity', () => {
  it('counts duplicate identities without discarding them', () => {
    const { events } = runScenario('byte-identical-resends', CTX)
    const integrity = analyseIntegrity(asObserved(events))
    expect(integrity.duplicateIdentities).toBeGreaterThan(0)
    expect(integrity.total).toBe(events.length)
  })

  it('counts out-of-order arrivals by device time', () => {
    const { events } = runScenario('duplicates-and-out-of-order', CTX)
    expect(analyseIntegrity(asObserved(events)).outOfOrderByDeviceTime).toBeGreaterThan(0)
  })

  it('detects buffered backfill by receipt-versus-device delay', () => {
    const { events } = runScenario('very-late-backfill', CTX)
    const integrity = analyseIntegrity(asObserved(events))
    expect(integrity.backfilled).toBeGreaterThan(5)
    expect(integrity.backfillThresholdS).toBe(900)
  })

  it('flags impossible values without correcting them — FR-TEL-005', () => {
    const { events } = generateBaseline({ ...CTX, pointCount: 4 })
    const damaged = asObserved(events).map((e, i) => {
      if (i === 0) return { ...e, position: { lat: 0, lon: 0, valid: true } }
      if (i === 1) return { ...e, motion: { speed_kph: 999 } }
      // 6553.5 is a classic vendor sentinel, not a measurement. Normalising it to null would
      // destroy the evidence that the device is misreporting.
      if (i === 2) return { ...e, power: { external_v: 6553.5 } }
      return e
    })
    const integrity = analyseIntegrity(damaged)

    expect(integrity.impossibleValues['position.null_island']).toBe(1)
    expect(integrity.impossibleValues['motion.speed_implausible']).toBe(1)
    expect(integrity.impossibleValues['power.external_v_sentinel']).toBe(1)
    // Nothing was dropped.
    expect(integrity.total).toBe(4)
  })

  it('reports a clean corpus as clean', () => {
    const { events } = generateBaseline({ ...CTX, pointCount: 20 })
    const integrity = analyseIntegrity(asObserved(events))
    expect(integrity.duplicateIdentities).toBe(0)
    expect(integrity.outOfOrderByDeviceTime).toBe(0)
    expect(integrity.impossibleValues).toEqual({})
  })
})

describe('platform configuration findings', () => {
  it('raises an active destructive setting as blocking', () => {
    const result = analysePlatformConfiguration({
      destructive: [
        {
          source: 'traccar', setting: 'filter.past',
          effect: 'discards positions older than the threshold before storage',
          enabled: true, defaultEnabled: false,
        },
        {
          source: 'traccar', setting: 'filter.future',
          effect: 'discards positions dated ahead of now', enabled: false, defaultEnabled: false,
        },
      ],
      retention: [{ source: 'traccar', rawDays: 400, customerReducible: true, requestedDays: 90 }],
    })

    expect(result.activeDestructiveSettings).toHaveLength(1)
    expect(result.blockingFindings[0]).toContain('filter.past')
    expect(result.retention[0]?.sufficient).toBe(true)
  })

  it('raises retention shorter than the audit window', () => {
    const result = analysePlatformConfiguration({
      destructive: [],
      retention: [{ source: 'navixy', rawDays: 180, customerReducible: false, requestedDays: 365 }],
    })
    expect(result.retention[0]?.sufficient).toBe(false)
    expect(result.blockingFindings[0]).toContain('180')
  })

  it('treats an undocumented retention window as a finding, not as unlimited', () => {
    const result = analysePlatformConfiguration({
      destructive: [],
      retention: [{ source: 'ruptela', rawDays: null, customerReducible: false, requestedDays: 90 }],
    })
    expect(result.retention[0]?.sufficient).toBeNull()
    expect(result.blockingFindings[0]).toContain('undocumented')
  })
})

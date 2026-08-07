// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest'
import { generateBaseline, runScenario } from '@blackout/generator'

import { sampleEpisodes, summariseEpisodes, type SamplerEvent } from './sampler.js'
import type { ReportingPolicyRecord } from '../reporting-policy.js'

const CTX = { seed: 41, startAt: '2026-08-05T06:00:00.000Z' }

const POLICY: ReportingPolicyRecord = {
  cohort: 'teltonika:FMB920',
  intervals: { moving: 60, ignition_on: 120, parked: 300, sleep: 3600, exception: 30 },
  provenance: 'declared',
  sleepAfterStationaryS: 900,
  graceFactor: 1.5,
  version: '1.0.0',
}

const asSampler = (events: unknown[]): SamplerEvent[] => events as SamplerEvent[]

describe('episode boundaries — FR-EPI-001', () => {
  it('opens nothing on a clean, policy-conformant stream', () => {
    const { events } = generateBaseline({ ...CTX, pointCount: 30 })
    const samples = sampleEpisodes(asSampler(events), { policy: POLICY })
    expect(samples.filter((s) => s.type === 'total_silence')).toHaveLength(0)
  })

  it('opens an episode when reports stop, and bounds it at the resumption', () => {
    const { events } = generateBaseline({ ...CTX, pointCount: 30 })
    const withGap = [...events.slice(0, 10), ...events.slice(22)]
    const samples = sampleEpisodes(asSampler(withGap), { policy: POLICY })
    const silence = samples.filter((s) => s.type === 'total_silence')

    expect(silence).toHaveLength(1)
    expect(silence[0]?.startAt).toBe(events[9]?.device_time)
    expect(silence[0]?.endAt).toBe(events[22]?.device_time)
    expect(silence[0]?.missedReports).toBeGreaterThan(5)
  })

  it('respects the grace factor rather than the raw interval', () => {
    const { events } = generateBaseline({ ...CTX, pointCount: 6 })
    // A 90-second gap exceeds the 60s interval but sits inside the 1.5x grace.
    const stretched = asSampler(events).map((e, i) =>
      i < 3 ? e : {
        ...e,
        device_time: new Date(Date.parse(e.device_time!) + 25_000).toISOString(),
        received_at: new Date(Date.parse(e.received_at) + 25_000).toISOString(),
      },
    )
    expect(sampleEpisodes(stretched, { policy: POLICY }).filter((s) => s.type === 'total_silence'))
      .toHaveLength(0)
  })

  it('extends the deadline by measured delivery lag', () => {
    const { events } = generateBaseline({ ...CTX, pointCount: 20 })
    const withGap = [...events.slice(0, 8), ...events.slice(11)]

    const strict = sampleEpisodes(asSampler(withGap), { policy: POLICY })
    const lenient = sampleEpisodes(asSampler(withGap), { policy: POLICY, deliveryLagP95S: 600 })

    expect(strict.filter((s) => s.type === 'total_silence').length).toBeGreaterThan(0)
    expect(lenient.filter((s) => s.type === 'total_silence')).toHaveLength(0)
  })
})

describe('the four episode types — FR-EPI-002', () => {
  it('separates GNSS-only loss from silence, because reporting never stopped', () => {
    const { events } = runScenario('gnss-loss-cellular-continues', CTX)
    const samples = sampleEpisodes(asSampler(events), { policy: POLICY })

    expect(samples.some((s) => s.type === 'gnss_only_loss')).toBe(true)
    expect(samples.some((s) => s.type === 'total_silence')).toBe(false)
  })

  it('calls a late-delivered gap vendor ingestion delay, not device silence', () => {
    const { events } = runScenario('very-late-backfill', CTX)
    const samples = sampleEpisodes(asSampler(events), { policy: POLICY })
    expect(samples.some((s) => s.type === 'vendor_ingestion_delay')).toBe(true)
  })

  it('detects a position that validates but never changes', () => {
    const { events } = generateBaseline({ ...CTX, pointCount: 20 })
    const frozen = asSampler(events).map((e, i) =>
      i < 5 ? e : { ...e, position: { ...(events[4]!.position as object), valid: true } },
    )
    const samples = sampleEpisodes(frozen, { policy: POLICY })
    expect(samples.some((s) => s.type === 'stale_position')).toBe(true)
  })

  it('names shapes rather than causes', () => {
    // vendor_ingestion_delay says the platform held records, not that the platform is at fault.
    // Attributing cause here would be false certainty the evidence engine has not earned.
    const { events } = runScenario('write-time-destruction', CTX)
    const samples = sampleEpisodes(asSampler(events), { policy: POLICY })
    for (const s of samples) {
      expect(['total_silence', 'gnss_only_loss', 'stale_position', 'vendor_ingestion_delay'])
        .toContain(s.type)
    }
  })
})

describe('clock basis — FR-POL-003', () => {
  it('falls back to receipt time when the device clock moves backwards', () => {
    // A 47-minute backwards jump must not become a 47-minute blackout that never happened.
    const { events } = runScenario('drifting-device-clock', CTX)
    const samples = sampleEpisodes(asSampler(events), { policy: POLICY })
    expect(samples.every((s) => s.clockBasis === 'received_at')).toBe(true)
  })

  it('uses device time when the clock is monotonic', () => {
    const { events } = generateBaseline({ ...CTX, pointCount: 12 })
    const samples = sampleEpisodes(asSampler(events), { policy: POLICY })
    // Clean stream: any episode found should be measured on device time.
    const clean = [...events.slice(0, 4), ...events.slice(9)]
    const found = sampleEpisodes(asSampler(clean), { policy: POLICY })
    expect(found[0]?.clockBasis).toBe('device_time')
    expect(samples.every((s) => s.clockBasis === 'device_time')).toBe(true)
  })

  it('states the clock basis on every episode, so a report can disclose it', () => {
    const { events } = generateBaseline({ ...CTX, pointCount: 20 })
    const withGap = [...events.slice(0, 6), ...events.slice(15)]
    for (const s of sampleEpisodes(asSampler(withGap), { policy: POLICY })) {
      expect(['device_time', 'received_at']).toContain(s.clockBasis)
    }
  })
})

describe('sleep and suppression', () => {
  it('does not open an episode for documented sleep behaviour', () => {
    const { events } = runScenario('teltonika-deep-sleep', CTX)
    const sleepPolicy: ReportingPolicyRecord = { ...POLICY, intervals: { ...POLICY.intervals, sleep: 900 } }
    const samples = sampleEpisodes(asSampler(events), { policy: sleepPolicy })
    // The device sleeps and reports every 12 intervals; the sleep policy covers it.
    expect(samples.filter((s) => s.type === 'total_silence')).toHaveLength(0)
  })

  it('marks a sleep-derived deadline weak when the interval was not declared', () => {
    const { events } = runScenario('teltonika-deep-sleep', CTX)
    const assumed: ReportingPolicyRecord = {
      // 45s is distinct from every other interval in POLICY, so the filter below can attribute
      // each episode to the state its deadline actually came from.
      ...POLICY, provenance: 'assumed', intervals: { ...POLICY.intervals, sleep: 45 },
    }
    const samples = sampleEpisodes(asSampler(events), { policy: assumed })
    expect(samples.length).toBeGreaterThan(0)

    // Only episodes whose deadline actually rested on the sleep interval are weak. An episode
    // spanning the awake-to-sleep transition is computed from the awake interval, and marking it
    // weak would overstate the uncertainty rather than understate it.
    const sleepDerived = samples.filter((s) => s.expectedIntervalS === assumed.intervals.sleep)
    const awakeDerived = samples.filter((s) => s.expectedIntervalS !== assumed.intervals.sleep)

    expect(sleepDerived.length).toBeGreaterThan(0)
    expect(sleepDerived.every((s) => s.weakBasis)).toBe(true)
    expect(awakeDerived.every((s) => !s.weakBasis)).toBe(true)
  })

  it('records a suppressed episode rather than dropping it — FR-POL-004', () => {
    const { events } = generateBaseline({ ...CTX, pointCount: 20 })
    const withGap = [...events.slice(0, 6), ...events.slice(15)]
    const samples = sampleEpisodes(asSampler(withGap), {
      policy: POLICY,
      suppressionWindows: [
        { reason: 'maintenance', from: '2026-08-05T06:00:00.000Z', to: '2026-08-05T08:00:00.000Z', approvedBy: 'ops' },
      ],
    })
    const suppressed = samples.filter((s) => s.suppressedBy !== undefined)
    expect(suppressed).toHaveLength(1)
    expect(suppressed[0]?.suppressedBy).toBe('maintenance')
    // Still present in the sample set: suppression means "do not raise", never "do not record".
    expect(samples).toContain(suppressed[0])
  })
})

describe('summary for the audit report', () => {
  it('counts suppressed and weak-basis episodes separately rather than removing them', () => {
    const { events } = generateBaseline({ ...CTX, pointCount: 24 })
    const withGap = [...events.slice(0, 6), ...events.slice(16)]
    const samples = sampleEpisodes(asSampler(withGap), {
      policy: POLICY,
      suppressionWindows: [
        { reason: 'maintenance', from: '2026-08-05T06:00:00.000Z', to: '2026-08-05T09:00:00.000Z', approvedBy: 'ops' },
      ],
    })
    const summary = summariseEpisodes(samples, 1)

    expect(summary.total).toBe(samples.length)
    expect(summary.suppressed).toBeGreaterThan(0)
    expect(summary.devicesWithEpisodes).toBe(1)
    expect(summary.devicesObserved).toBe(1)
  })

  it('carries the exposure denominator, never a bare count', () => {
    const summary = summariseEpisodes([], 250)
    expect(summary.total).toBe(0)
    expect(summary.devicesObserved).toBe(250)
  })

  it('runs over every reference scenario without throwing', () => {
    for (const name of [
      'duplicates-and-out-of-order', 'very-late-backfill', 'drifting-device-clock',
      'reboot-and-sequence-reset', 'device-swap-mid-episode', 'maintenance-window-overlap',
      'vendor-outage-with-individual-power-cut', 'gnss-loss-cellular-continues',
      'transient-heartbeat-mid-blackout', 'duplicated-data-path', 'ambiguous-corridor',
      'teltonika-deep-sleep', 'byte-identical-resends', 'write-time-destruction',
    ]) {
      const { events } = runScenario(name, CTX)
      const byDevice = new Map<string, SamplerEvent[]>()
      for (const e of asSampler(events)) {
        byDevice.set(e.device_ref, [...(byDevice.get(e.device_ref) ?? []), e])
      }
      for (const [, deviceEvents] of byDevice) {
        expect(() => sampleEpisodes(deviceEvents, { policy: POLICY })).not.toThrow()
      }
    }
  })

  it('returns nothing for a device with fewer than two observations', () => {
    expect(sampleEpisodes([], { policy: POLICY })).toEqual([])
    expect(sampleEpisodes(
      [{ device_ref: 'd', received_at: '2026-08-05T06:00:00.000Z' }],
      { policy: POLICY },
    )).toEqual([])
  })
})

// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { validateCanonicalEvent } from '@blackout/spec'

import { createRng, syntheticRef } from './prng.js'
import { CORRIDORS, distanceM, walkCorridor } from './geography.js'
import { SYNTHETIC_TENANT_PREFIX, generateBaseline } from './generate.js'
import { SCENARIO_NAMES, runScenario } from './scenarios.js'

const CTX = { seed: 42, startAt: '2026-08-05T06:00:00.000Z' }

describe('determinism', () => {
  // FR-EPI-004 requires replay to produce identical version histories. A fixture corpus that
  // varies between runs cannot prove that, so this is the property everything else rests on.
  it('produces byte-identical output for the same seed', () => {
    const a = generateBaseline({ ...CTX, pointCount: 30 })
    const b = generateBaseline({ ...CTX, pointCount: 30 })
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events))
  })

  it('produces different output for different seeds', () => {
    const a = generateBaseline({ ...CTX, pointCount: 30 })
    const b = generateBaseline({ ...CTX, seed: 43, pointCount: 30 })
    expect(JSON.stringify(a.events)).not.toBe(JSON.stringify(b.events))
  })

  it.each(SCENARIO_NAMES)('scenario %s is reproducible', (name) => {
    expect(JSON.stringify(runScenario(name, CTX))).toBe(JSON.stringify(runScenario(name, CTX)))
  })

  it('never calls Date.now or Math.random — start time is always supplied', () => {
    const spy = { random: Math.random, now: Date.now }
    Math.random = () => { throw new Error('Math.random breaks determinism') }
    Date.now = () => { throw new Error('Date.now breaks determinism') }
    try {
      for (const name of SCENARIO_NAMES) runScenario(name, CTX)
    } finally {
      Math.random = spy.random
      Date.now = spy.now
    }
  })
})

describe('every generated event is schema-valid', () => {
  it('baseline events validate', () => {
    const { events } = generateBaseline({ ...CTX, pointCount: 40 })
    for (const event of events) {
      const result = validateCanonicalEvent(event)
      expect(result.errors, JSON.stringify(event).slice(0, 200)).toEqual([])
    }
  })

  it.each(SCENARIO_NAMES)('%s events validate', (name) => {
    const { events } = runScenario(name, CTX)
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      const result = validateCanonicalEvent(event)
      expect(result.errors, `${name}: ${JSON.stringify(event).slice(0, 200)}`).toEqual([])
    }
  })
})

describe('synthetic data cannot pass for real', () => {
  it('refuses a tenant id without the synthetic prefix', () => {
    expect(() => generateBaseline({ ...CTX, tenantId: 'watu_kenya' })).toThrow(/synthetic/)
  })

  it.each(SCENARIO_NAMES)('%s carries the synthetic prefix on every event', (name) => {
    for (const event of runScenario(name, CTX).events) {
      expect(event.tenant_id.startsWith(SYNTHETIC_TENANT_PREFIX)).toBe(true)
    }
  })

  it('emits pseudonymous references, never plates or identity numbers', () => {
    const { events } = generateBaseline({ ...CTX, pointCount: 5 })
    for (const event of events) {
      expect(event.asset_ref).toMatch(/^ast_[0-9a-f]{8}$/)
      expect(event.device_ref).toMatch(/^dev_[0-9a-f]{8}$/)
    }
  })
})

describe('ground truth', () => {
  it.each(SCENARIO_NAMES)('%s records a cause, an episode expectation and its trap', (name) => {
    const { truth } = runScenario(name, CTX)
    expect(truth.scenario).toBe(name)
    expect(typeof truth.opensEpisode).toBe('boolean')
    // The trap is the point of the fixture: it says what a naive detector gets wrong.
    expect(truth.trap.length).toBeGreaterThan(60)
  })

  it('labels live in a sidecar, never inside the events', () => {
    for (const name of SCENARIO_NAMES) {
      const { events } = runScenario(name, CTX)
      const serialized = JSON.stringify(events)
      expect(serialized).not.toContain('trueCause')
      expect(serialized).not.toContain('opensEpisode')
      expect(serialized).not.toContain('"trap"')
    }
  })

  it('covers the platform-research cases, not only PRD §15.2', () => {
    for (const required of ['teltonika-deep-sleep', 'byte-identical-resends', 'write-time-destruction']) {
      expect(SCENARIO_NAMES).toContain(required)
    }
  })
})

describe('specific traps behave as documented', () => {
  it('deep sleep emits no jamming alert and no network block — absence, not measurement', () => {
    const { events, truth } = runScenario('teltonika-deep-sleep', CTX)
    const sleeping = events.filter((e) => (e.device as { sleep_state?: string })?.sleep_state === 'deep_sleep')
    expect(sleeping.length).toBeGreaterThan(0)
    for (const event of sleeping) {
      expect(event.alerts).toEqual([])
      expect(event.network).toBeNull()
      expect((event.position as { valid: boolean }).valid).toBe(false)
    }
    expect(truth.opensEpisode).toBe(false)
    expect(truth.trueCause).toBe('expected_sleep')
  })

  it('GNSS loss keeps reporting on schedule while position quality fails', () => {
    const { events, truth } = runScenario('gnss-loss-cellular-continues', CTX)
    const invalid = events.filter((e) => (e.position as { valid: boolean } | null)?.valid === false)
    expect(invalid.length).toBeGreaterThan(5)
    // Reports never stop, so a timeout detector sees nothing.
    for (const event of invalid) expect(event.network).not.toBeNull()
    expect(truth.trueCause).toBe('gnss_only_loss')
  })

  it('the power cut survives a simultaneous vendor outage', () => {
    const { events, truth } = runScenario('vendor-outage-with-individual-power-cut', CTX)
    const last = events[events.length - 1]
    expect(last?.alerts?.map((a) => a.code)).toContain('power_cut')
    expect((last?.power as { external_state: string }).external_state).toBe('absent')
    expect(truth.trueCause).toBe('power_disconnect')
  })

  it('late backfill produces an episode that must later be retracted', () => {
    const { events, truth } = runScenario('very-late-backfill', CTX)
    const lateArrivals = events.filter(
      (e) => new Date(e.received_at).getTime() - new Date(e.device_time ?? e.received_at).getTime() > 3600_000,
    )
    expect(lateArrivals.length).toBeGreaterThan(5)
    expect(truth.opensEpisode).toBe(true)
    expect(truth.trueCause).toBe('none')
  })

  it('the duplicated data path is one device on two sources, not two devices', () => {
    const { events } = runScenario('duplicated-data-path', CTX)
    expect(new Set(events.map((e) => e.source)).size).toBe(2)
    expect(new Set(events.map((e) => e.device_ref)).size).toBe(1)
  })

  it('byte-identical resends are genuinely identical apart from arrival', () => {
    const { events } = runScenario('byte-identical-resends', CTX)
    const byIdentity = new Map<string, number>()
    for (const e of events) {
      byIdentity.set(e.event_identity.value, (byIdentity.get(e.event_identity.value) ?? 0) + 1)
    }
    expect([...byIdentity.values()].filter((n) => n > 1).length).toBeGreaterThan(0)
  })

  it('the drifting clock moves backwards while receipt time stays monotonic', () => {
    const { events } = runScenario('drifting-device-clock', CTX)
    const receipts = events.map((e) => new Date(e.received_at).getTime())
    for (let i = 1; i < receipts.length; i++) {
      expect(receipts[i]!).toBeGreaterThanOrEqual(receipts[i - 1]!)
    }
    const deviceTimes = events.map((e) => new Date(e.device_time ?? e.received_at).getTime())
    expect(deviceTimes.some((t, i) => i > 0 && t < deviceTimes[i - 1]!)).toBe(true)
  })
})

describe('geography', () => {
  it('walks a corridor forwards without teleporting', () => {
    const rng = createRng(7)
    const corridor = CORRIDORS[0]!
    const track = walkCorridor(corridor, 60, 30, rng)
    expect(track.length).toBeGreaterThan(10)
    for (let i = 1; i < track.length; i++) {
      // At most ~1.5 km per 60 s step: nothing exceeds a plausible boda speed.
      expect(distanceM(track[i - 1]!, track[i]!)).toBeLessThan(1500)
      expect(track[i]!.odometerM).toBeGreaterThanOrEqual(track[i - 1]!.odometerM)
    }
  })

  it('keeps every point inside the Nairobi region', () => {
    const rng = createRng(11)
    for (const corridor of CORRIDORS) {
      for (const p of walkCorridor(corridor, 60, 25, rng)) {
        expect(p.lat).toBeGreaterThan(-1.6)
        expect(p.lat).toBeLessThan(-1.0)
        expect(p.lon).toBeGreaterThan(36.6)
        expect(p.lon).toBeLessThan(37.1)
      }
    }
  })

  it('provides at least one corridor with an ambiguous junction', () => {
    expect(CORRIDORS.some((c) => c.hasAmbiguousJunction)).toBe(true)
  })
})

describe('prng properties', () => {
  it('stays within bounds for any seed and range', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 0, max: 50 }), (seed, span) => {
        const rng = createRng(seed)
        for (let i = 0; i < 25; i++) {
          const v = rng.int(10, 10 + span)
          if (v < 10 || v > 10 + span) return false
          if (!Number.isInteger(v)) return false
        }
        return true
      }),
      { numRuns: 200 },
    )
  })

  it('generates well-formed pseudonyms for any seed', () => {
    fc.assert(
      fc.property(fc.integer(), fc.nat({ max: 1000 }), (seed, index) =>
        /^ast_[0-9a-f]{8}$/.test(syntheticRef('ast', seed, index)),
      ),
      { numRuns: 200 },
    )
  })

  it('shuffle preserves the multiset and leaves the input untouched', () => {
    fc.assert(
      fc.property(fc.integer(), fc.array(fc.integer(), { minLength: 1, maxLength: 40 }), (seed, xs) => {
        const original = [...xs]
        const shuffled = createRng(seed).shuffle(xs)
        return (
          JSON.stringify(xs) === JSON.stringify(original) &&
          JSON.stringify([...shuffled].sort()) === JSON.stringify([...xs].sort())
        )
      }),
      { numRuns: 200 },
    )
  })
})

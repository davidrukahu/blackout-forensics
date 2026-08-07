// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { generateBaseline } from '@blackout/generator'

import {
  IMMUTABLE_TIME_FIELDS,
  TimeOverwriteError,
  currentVersion,
  diffVersions,
  enrich,
  nextVersionFor,
  normalize,
  type Adapter,
  type ObservationVersion,
} from './normalizer.js'

const { events } = generateBaseline({
  seed: 61,
  startAt: '2026-08-05T06:00:00.000Z',
  pointCount: 3,
})
const canonical = events[0] as unknown as Record<string, unknown>

const passthrough = (version: string): Adapter => ({
  name: 'test',
  version,
  decode: (raw) => structuredClone(raw) as Record<string, unknown>,
})

describe('normalization refuses to invent or coerce — FR-TEL-001', () => {
  it('accepts an adapter that produces a valid canonical event', () => {
    const result = normalize(canonical, passthrough('1.0.0'))
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.adapterVersion).toBe('test-1.0.0')
  })

  it('rejects an adapter that coerces a number into a string', () => {
    // An adapter that "helpfully" stringifies is a defect, and the schema is where it gets caught —
    // validating the adapter's output rather than trusting it is the whole point.
    const coercing: Adapter = {
      name: 'coercing', version: '1.0.0',
      decode: (raw) => {
        const e = structuredClone(raw) as Record<string, unknown>
        const motion = e['motion'] as { speed_kph?: unknown }
        motion.speed_kph = String(motion.speed_kph)
        return e
      },
    }
    const result = normalize(canonical, coercing)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.path.includes('speed_kph'))).toBe(true)
  })

  it('rejects an adapter that invents an unnamespaced field', () => {
    const inventing: Adapter = {
      name: 'inventing', version: '1.0.0',
      decode: (raw) => ({ ...(structuredClone(raw) as object), vendor_hint: 'made up' }),
    }
    expect(normalize(canonical, inventing).ok).toBe(false)
  })

  it('reports a decode failure as an error rather than throwing', () => {
    const broken: Adapter = {
      name: 'broken', version: '1.0.0',
      decode: () => { throw new Error('bad packet') },
    }
    const result = normalize(canonical, broken)
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.message).toContain('failed to decode')
  })

  it('returns paths, never values, so a rejection is safe to queue', () => {
    const broken: Adapter = {
      name: 'b', version: '1.0.0',
      decode: (raw) => {
        const e = structuredClone(raw) as Record<string, unknown>
        ;(e['position'] as { lat: number }).lat = 999
        return e
      },
    }
    const result = normalize(canonical, broken)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result.errors)).not.toContain('999')
  })
})

describe('the three times are never overwritten — FR-TEL-003', () => {
  it.each(IMMUTABLE_TIME_FIELDS)('refuses to enrich over %s', (field) => {
    expect(() => enrich(canonical, { [field]: '2020-01-01T00:00:00.000Z' }))
      .toThrow(TimeOverwriteError)
  })

  it('permits derived fields that are genuinely new', () => {
    const enriched = enrich(canonical, { clock_skew_s: 12, delivery_lag_s: 3 })
    expect(enriched['clock_skew_s']).toBe(12)
    expect(enriched['received_at']).toBe(canonical['received_at'])
  })

  it('leaves the original untouched', () => {
    const before = JSON.stringify(canonical)
    enrich(canonical, { clock_skew_s: 1 })
    expect(JSON.stringify(canonical)).toBe(before)
  })

  it('rejects any attempt to write a time field, whatever the value', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...IMMUTABLE_TIME_FIELDS),
        fc.oneof(fc.string(), fc.constant(null), fc.integer()),
        (field, value) => {
          try {
            enrich(canonical, { [field]: value })
            return false
          } catch (error) {
            return error instanceof TimeOverwriteError
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe('versioning — FR-TEL-007', () => {
  const v = (version: number, adapterVersion: string, superseded = false): ObservationVersion => ({
    version, adapterVersion, rawSha256: 'a'.repeat(64), payload: {}, superseded,
  })

  it('gives a newer adapter the next version number', () => {
    expect(nextVersionFor([v(1, 'traccar-1.0.0')], 'traccar-1.1.0')).toBe(2)
    expect(nextVersionFor([v(1, 'traccar-1.0.0'), v(2, 'traccar-1.1.0')], 'traccar-2.0.0')).toBe(3)
  })

  it('refuses to version a re-run of the same adapter', () => {
    // A replay is not a second opinion. A version that says nothing new is noise in an evidence
    // record, and later makes it impossible to tell which versions represent real re-decodes.
    expect(nextVersionFor([v(1, 'traccar-1.0.0')], 'traccar-1.0.0')).toBeUndefined()
  })

  it('starts at version 1 for a receipt never decoded', () => {
    expect(nextVersionFor([], 'traccar-1.0.0')).toBe(1)
  })

  it('reads the highest non-superseded version', () => {
    const versions = [v(1, 'a-1'), v(2, 'a-2'), v(3, 'a-3', true)]
    expect(currentVersion(versions)?.version).toBe(2)
  })

  it('returns nothing when every version is superseded', () => {
    expect(currentVersion([v(1, 'a-1', true)])).toBeUndefined()
  })
})

describe('a re-decode is reviewable', () => {
  it('names which fields a new adapter changed and which it left alone', () => {
    const before = { device_time: '2026-08-05T06:00:00.000Z', position: { lat: 1 }, motion: { ignition: 'on' } }
    const after = { device_time: '2026-08-05T06:00:00.000Z', position: { lat: 2 }, motion: { ignition: 'on' } }

    const diff = diffVersions(before, after)
    expect(diff.find((d) => d.field === 'position')?.changed).toBe(true)
    expect(diff.find((d) => d.field === 'device_time')?.changed).toBe(false)
    expect(diff.find((d) => d.field === 'motion')?.changed).toBe(false)
  })

  it('reports a field added by the newer adapter as changed', () => {
    const diff = diffVersions({ a: 1 }, { a: 1, network: { rssi_dbm: -90 } })
    expect(diff.find((d) => d.field === 'network')?.changed).toBe(true)
  })

  it('reports a field dropped by the newer adapter as changed', () => {
    // A newer adapter that stops emitting a field is a regression worth seeing, not a silent tidy-up.
    const diff = diffVersions({ a: 1, power: {} }, { a: 1 })
    expect(diff.find((d) => d.field === 'power')?.changed).toBe(true)
  })
})

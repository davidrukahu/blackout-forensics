// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

import fc from 'fast-check'
import { latLngToCell } from 'h3-js'
import { describe, expect, it } from 'vitest'

import {
  MAX_H3_RESOLUTION,
  MIN_COHORT_SIZE,
  checkRedaction,
  coarsenToCell,
  suppressSmallCohorts,
} from './redaction.js'
import { emitBundle, serializeBundle } from './emitter.js'

const BASE = {
  tenantLabel: 'customer-a',
  sourceLabels: ['traccar'],
  periodStart: '2026-05-01T00:00:00.000Z',
  periodEnd: '2026-08-01T00:00:00.000Z',
  generatedAt: '2026-08-05T12:00:00.000Z',
  containerVersion: '0.1.0',
  analyserVersions: { quality: '0.1.0', sampler: '0.1.0' },
}

const goodSection = [
  {
    model: 'FMB920', source: 'traccar', day: '2026-06-01', device_count: 140,
    field_group: 'power', denominator: 12_000, numerator: 11_400, excluded: 60,
    exclusion_reasons: { device_asleep: 60 },
  },
]

describe('the bundle fails closed', () => {
  it('emits a clean bundle', () => {
    const result = emitBundle({ ...BASE, sections: { completeness: goodSection } })
    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.bundle?.manifest.thresholds.min_cohort_size).toBe(MIN_COHORT_SIZE)
  })

  it('refuses a bundle carrying a coordinate', () => {
    const result = emitBundle({
      ...BASE,
      sections: { completeness: [{ ...goodSection[0], lat: -1.2864, lon: 36.8172 }] },
    })
    expect(result.ok).toBe(false)
    expect(result.bundle).toBeUndefined()
    expect(result.violations.some((v) => v.code === 'COORDINATE_PRESENT')).toBe(true)
  })

  it('refuses a pseudonymous device reference — the whole point of the rule', () => {
    // A tenant-keyed pseudonym is still a re-identifier in the customer's hands, and its presence
    // is what would make the recipient a controller rather than nothing at all.
    const result = emitBundle({
      ...BASE,
      sections: { completeness: [{ ...goodSection[0], device_ref: 'dev_9a3f0011' }] },
    })
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.code === 'IDENTIFIER_PRESENT')).toBe(true)
  })

  it('refuses an IMEI-shaped value even in an allowlisted field', () => {
    const result = emitBundle({
      ...BASE,
      sections: { completeness: [{ ...goodSection[0], model: '356938035643809' }] },
    })
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.code === 'IDENTIFIER_PRESENT')).toBe(true)
  })

  it('refuses an H3 resolution finer than permitted', () => {
    const result = emitBundle({
      ...BASE,
      sections: { corridors: [{ ...goodSection[0], h3_cell: '8a2a1072b59ffff', h3_resolution: 10 }] },
    })
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.code === 'H3_TOO_FINE')).toBe(true)
  })

  it('refuses any field not on the allow-list — a deny-list would fail open', () => {
    const result = emitBundle({
      ...BASE,
      sections: { completeness: [{ ...goodSection[0], operator_notes: 'rider seemed evasive' }] },
    })
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.code === 'FIELD_NOT_ALLOWLISTED')).toBe(true)
  })

  it('catches an unlabelled coordinate hiding in an array', () => {
    const result = emitBundle({
      ...BASE,
      sections: { completeness: [{ ...goodSection[0], duration_s: [-1.286400, 36.817200] }] },
    })
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.code === 'COORDINATE_PRESENT')).toBe(true)
  })

  it('names paths, never values, in every violation', () => {
    const result = emitBundle({
      ...BASE,
      sections: { completeness: [{ ...goodSection[0], lat: -1.2864 }] },
    })
    for (const v of result.violations) {
      expect(JSON.stringify(v)).not.toContain('1.2864')
    }
  })
})

describe('cohort suppression', () => {
  it('suppresses rows below the floor rather than rounding them', () => {
    // Rounding preserves the row's existence, which is itself disclosive.
    const rows = [{ device_count: 4 }, { device_count: 30 }, { device_count: MIN_COHORT_SIZE }]
    const { published, suppressed } = suppressSmallCohorts(rows)
    expect(published).toHaveLength(2)
    expect(suppressed).toBe(1)
  })

  it('suppresses inside the emitter and reports how many', () => {
    const result = emitBundle({
      ...BASE,
      sections: { completeness: [goodSection[0]!, { ...goodSection[0], device_count: 3 }] },
    })
    expect(result.ok).toBe(true)
    expect(result.suppressedRows).toBe(1)
    expect((result.bundle?.sections['completeness'] as unknown[]).length).toBe(1)
  })

  it('a small cohort can never reach the check, because it was already removed', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MIN_COHORT_SIZE - 1 }), (count) => {
        const result = emitBundle({
          ...BASE,
          sections: { completeness: [{ ...goodSection[0], device_count: count }] },
        })
        return result.ok && (result.bundle?.sections['completeness'] as unknown[]).length === 0
      }),
      { numRuns: 24 },
    )
  })
})

describe('spatial coarsening', () => {
  it('never returns a cell finer than the permitted resolution', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1.5, max: -1.0, noNaN: true }),
        fc.double({ min: 36.6, max: 37.1, noNaN: true }),
        fc.integer({ min: 0, max: 15 }),
        (lat, lon, requested) => {
          const cell = coarsenToCell(lat, lon, requested, latLngToCell)
          return cell.h3_resolution <= MAX_H3_RESOLUTION
        },
      ),
      { numRuns: 200 },
    )
  })

  it('collapses nearby Nairobi fixes into the same cell', () => {
    // Two points ~1 km apart must not be separable at the published resolution.
    const a = coarsenToCell(-1.2864, 36.8172, MAX_H3_RESOLUTION, latLngToCell)
    const b = coarsenToCell(-1.2900, 36.8200, MAX_H3_RESOLUTION, latLngToCell)
    expect(a.h3_cell).toBe(b.h3_cell)
  })

  it('passes the redaction check for a coarsened cell', () => {
    const cell = coarsenToCell(-1.2864, 36.8172, MAX_H3_RESOLUTION, latLngToCell)
    const result = emitBundle({
      ...BASE,
      sections: { corridors: [{ ...cell, device_count: 60, episode_count: 12 }] },
    })
    expect(result.violations).toEqual([])
  })
})

describe('the manifest carries its own reasoning', () => {
  it('ships the thresholds and why they were chosen', () => {
    const bundle = emitBundle({ ...BASE, sections: { completeness: goodSection } }).bundle!
    expect(bundle.manifest.reasoning.length).toBeGreaterThan(3)
    expect(bundle.manifest.reasoning.join(' ')).toContain('modeled')
    expect(bundle.manifest.reasoning.join(' ')).toContain('controller')
  })

  it('hashes every section so a number can be traced to the run that produced it', () => {
    const bundle = emitBundle({ ...BASE, sections: { completeness: goodSection } }).bundle!
    expect(bundle.manifest.content_hashes['completeness']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('uses a customer-chosen label, never a tenant identifier from the fact store', () => {
    const bundle = emitBundle({ ...BASE, sections: { completeness: goodSection } }).bundle!
    expect(bundle.manifest.tenant_label).toBe('customer-a')
  })
})

describe('customer approval', () => {
  it('lists every section, its row count and its hash before release', () => {
    const result = emitBundle({ ...BASE, sections: { completeness: goodSection } })
    expect(result.contentsListing.some((l) => l.startsWith('completeness'))).toBe(true)
    expect(result.contentsListing.some((l) => l.includes('thresholds'))).toBe(true)
  })

  it('produces a listing even when it refuses, so the customer sees why', () => {
    const result = emitBundle({
      ...BASE, sections: { completeness: [{ ...goodSection[0], lat: -1.2864 }] },
    })
    expect(result.ok).toBe(false)
    expect(result.contentsListing.length).toBeGreaterThan(0)
  })

  it('re-checks on serialize, because approval is not a bypass', () => {
    const bundle = emitBundle({ ...BASE, sections: { completeness: goodSection } }).bundle!
    expect(() => serializeBundle(bundle)).not.toThrow()

    const tampered = {
      ...bundle,
      sections: { completeness: [{ ...goodSection[0], device_ref: 'dev_1' }] },
    }
    expect(() => serializeBundle(tampered)).toThrow(/refusing to serialize/)
  })
})

describe('the guard itself', () => {
  it('rejects any coordinate pair, for any plausible position on earth', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -89, max: 89, noNaN: true }),
        fc.double({ min: -179, max: 179, noNaN: true }),
        (lat, lon) =>
          checkRedaction({ sections: { x: [{ lat, lon }] } }).some(
            (v) => v.code === 'COORDINATE_PRESENT',
          ),
      ),
      { numRuns: 200 },
    )
  })

  it('rejects any long digit run that could be an IMEI, ICCID or MSISDN', () => {
    fc.assert(
      fc.property(fc.integer({ min: 11, max: 20 }), (length) => {
        const value = '7'.repeat(length)
        return checkRedaction({ sections: { x: [{ model: value }] } }).some(
          (v) => v.code === 'IDENTIFIER_PRESENT',
        )
      }),
      { numRuns: 30 },
    )
  })

  it('passes a bundle built only from allowlisted aggregate fields', () => {
    expect(checkRedaction({
      manifest: { bundle_version: '0.1.0', tenant_label: 'x' },
      sections: {
        completeness: [{ model: 'FMB920', device_count: 90, denominator: 100, numerator: 95 }],
        timing: { platform_lag_s: { count: 900, p50: 3, p95: 41, p99: 220, min: 1, max: 900 } },
      },
    })).toEqual([])
  })
})

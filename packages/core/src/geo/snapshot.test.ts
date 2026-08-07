// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  ACCEPTED_MAP_LICENCES,
  MissingAttributionError,
  OSM_ATTRIBUTION,
  assertAttributed,
  attributionFor,
  checkSnapshot,
  surrogateKeyFor,
  type SnapshotMetadata,
} from './snapshot.js'

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

const metadata = (overrides: Partial<SnapshotMetadata> = {}): SnapshotMetadata => ({
  sourceUrl: 'https://download.geofabrik.de/africa/kenya-260801.osm.pbf',
  licence: 'ODbL-1.0',
  extractDate: '2026-08-01',
  sha256: sha('kenya-extract'),
  attribution: OSM_ATTRIBUTION,
  ...overrides,
})

describe('a snapshot cannot activate without provenance — FR-ADM-003', () => {
  it('accepts a complete, licensed extract', () => {
    expect(checkSnapshot(metadata())).toEqual({ ok: true, rejections: [] })
  })

  it('refuses a missing source, licence, date, checksum or attribution', () => {
    expect(checkSnapshot(metadata({ sourceUrl: '' })).rejections).toContain('missing_source_url')
    expect(checkSnapshot(metadata({ licence: '' })).rejections).toContain('missing_licence')
    expect(checkSnapshot(metadata({ extractDate: '' })).rejections).toContain('missing_extract_date')
    expect(checkSnapshot(metadata({ sha256: '' })).rejections).toContain('missing_checksum')
    expect(checkSnapshot(metadata({ attribution: '' })).rejections).toContain('missing_attribution')
  })

  it('refuses a licence this project has not accepted', () => {
    // An extract under unexpected terms is a legal decision, not a config value.
    expect(checkSnapshot(metadata({ licence: 'CC-BY-4.0' })).rejections).toContain('unaccepted_licence')
    expect(ACCEPTED_MAP_LICENCES).toEqual(['ODbL-1.0'])
  })

  it('refuses an extract whose bytes do not match the recorded hash', () => {
    // Not the extract that was reviewed. A map layer nobody can pin to a known artefact cannot
    // support the claim that a corridor was computed from licensed data.
    const result = checkSnapshot(metadata(), sha('something-else'))
    expect(result.ok).toBe(false)
    expect(result.rejections).toContain('checksum_mismatch')
  })

  it('accepts when the observed hash matches', () => {
    expect(checkSnapshot(metadata(), sha('kenya-extract')).ok).toBe(true)
  })

  it('refuses a malformed date or checksum rather than coercing it', () => {
    expect(checkSnapshot(metadata({ extractDate: '1 Aug 2026' })).rejections)
      .toContain('malformed_extract_date')
    expect(checkSnapshot(metadata({ sha256: 'abc' })).rejections).toContain('malformed_checksum')
  })

  it('reports every rejection at once', () => {
    expect(checkSnapshot({}).rejections.length).toBeGreaterThanOrEqual(5)
  })
})

describe('stable geometry references survive OSM id churn — FR-GEO-005', () => {
  const geometry = {
    coordinates: [
      [36.8172, -1.2864],
      [36.8180, -1.2870],
      [36.8195, -1.2881],
    ] as const,
    osmWayId: 12_345,
  }

  it('derives the same key after a way is renumbered', () => {
    // Way ids are reassigned when a way is split or merged. An episode whose corridor evidence
    // referenced a way id would become unresolvable after an ordinary map update — evidence that
    // decays is not evidence.
    const before = surrogateKeyFor(geometry)
    const after = surrogateKeyFor({ ...geometry, osmWayId: 99_999 })
    expect(after).toBe(before)
  })

  it('derives a different key for a different stretch of road', () => {
    const other = surrogateKeyFor({
      coordinates: [[36.9000, -1.3000], [36.9010, -1.3010]],
      osmWayId: 12_345,
    })
    expect(other).not.toBe(surrogateKeyFor(geometry))
  })

  it('is insensitive to precision below about 11 centimetres', () => {
    const jittered = {
      ...geometry,
      coordinates: geometry.coordinates.map(([lon, lat]) => [lon + 1e-9, lat - 1e-9] as const),
    }
    expect(surrogateKeyFor(jittered)).toBe(surrogateKeyFor(geometry))
  })

  it('carries no OSM identifier in the key itself', () => {
    const key = surrogateKeyFor(geometry)
    expect(key).toMatch(/^seg_[0-9a-f]{24}$/)
    expect(key).not.toContain('12345')
  })

  it('is deterministic for any geometry', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.double({ min: 36.6, max: 37.1, noNaN: true }),
            fc.double({ min: -1.5, max: -1.0, noNaN: true }),
          ),
          { minLength: 2, maxLength: 20 },
        ),
        (coords) => {
          const g = { coordinates: coords as unknown as readonly (readonly [number, number])[], osmWayId: 1 }
          return surrogateKeyFor(g) === surrogateKeyFor(g)
        },
      ),
      { numRuns: 150 },
    )
  })
})

describe('attribution travels with the export, not with the UI', () => {
  it('produces an OSM attribution block from a snapshot', () => {
    const block = attributionFor({ sha256: sha('x'), extractDate: '2026-08-01' })
    expect(block.osm).toBe(OSM_ATTRIBUTION)
    expect(block.extractDate).toBe('2026-08-01')
    expect(block.snapshotSha256).toBe(sha('x'))
  })

  it('adds cell attribution only when cell data was used', () => {
    const withCells = attributionFor({ sha256: sha('x'), extractDate: '2026-08-01' }, { includesCellData: true })
    expect(withCells.opencellid).toContain('CC BY-SA 4.0')
    expect(attributionFor({ sha256: sha('x'), extractDate: '2026-08-01' }).opencellid).toBeUndefined()
  })

  it('refuses to emit a map-derived export with no attribution', () => {
    // A PDF or CSV leaving the building unattributed is the failure ODbL actually cares about, and
    // exactly the one a UI component cannot prevent.
    expect(() => assertAttributed({}, 'corridor-report.pdf', true)).toThrow(MissingAttributionError)
    expect(() => assertAttributed({ attribution: { osm: '' } }, 'export.csv', true))
      .toThrow(MissingAttributionError)
  })

  it('permits an export that used no map data', () => {
    expect(() => assertAttributed({}, 'completeness.csv', false)).not.toThrow()
  })

  it('permits a properly attributed export', () => {
    const manifest = { attribution: attributionFor({ sha256: sha('x'), extractDate: '2026-08-01' }) }
    expect(() => assertAttributed(manifest, 'corridor-report.pdf', true)).not.toThrow()
  })
})

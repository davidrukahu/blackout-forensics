// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  DisabledCellLookup,
  ForbiddenAcquisitionError,
  OPENCELLID_ATTRIBUTION,
  assertAcquisitionPermitted,
  canSupportUrgentAction,
  cellEvidenceFrom,
  describeAbsence,
  explainActionability,
  type CellLookupResult,
  type EvidenceFamily,
  type EvidenceItem,
  type EvidenceStrength,
} from './opencellid.js'

const found: CellLookupResult = {
  status: 'found',
  snapshotId: '1',
  record: { mcc: 639, mnc: 2, lac: 1234, cellId: 56_789, lat: -1.28, lon: 36.81, rangeM: 1200, samples: 42 },
}

const item = (family: EvidenceFamily, strength: EvidenceStrength): EvidenceItem => ({
  family, strength, summary: `${family}:${strength}`,
})

describe('removing the cell layer cannot change a verdict — FR-CLS-005', () => {
  it('holds for any evidence set, with any cell evidence added', () => {
    // The acceptance criterion for this whole ticket, as a property rather than an example. If a
    // cell prior could ever tip a case into actionable, some case somewhere would be dispatched on
    // the strength of an averaged reception measurement.
    const families: EvidenceFamily[] = [
      'device_signal', 'platform_health', 'peer_devices', 'route_history', 'reviewed_outcome',
    ]
    const strengths: EvidenceStrength[] = ['direct', 'corroborated', 'weak', 'indeterminate']

    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            family: fc.constantFrom(...families),
            strength: fc.constantFrom(...strengths),
          }),
          { maxLength: 8 },
        ),
        fc.array(fc.constantFrom<EvidenceStrength>(...strengths), { maxLength: 4 }),
        (base, cellStrengths) => {
          const withoutCells: EvidenceItem[] = base.map((b) => item(b.family, b.strength))
          const withCells: EvidenceItem[] = [
            ...withoutCells,
            // Even mislabelled as direct — which the production path never does — it must not count.
            ...cellStrengths.map((s) => item('cell_prior', s)),
          ]
          return canSupportUrgentAction(withCells) === canSupportUrgentAction(withoutCells)
        },
      ),
      { numRuns: 400 },
    )
  })

  it('a cell prior alone is never actionable', () => {
    expect(canSupportUrgentAction([item('cell_prior', 'weak')])).toBe(false)
    expect(canSupportUrgentAction([item('cell_prior', 'direct')])).toBe(false)
  })

  it('direct evidence from a real family is actionable', () => {
    expect(canSupportUrgentAction([item('device_signal', 'direct')])).toBe(true)
  })

  it('needs two independent families to corroborate, not two facts from one', () => {
    // Two readings from the same device are one observation repeated, not agreement.
    expect(canSupportUrgentAction([
      item('device_signal', 'corroborated'),
      item('device_signal', 'corroborated'),
    ])).toBe(false)

    expect(canSupportUrgentAction([
      item('device_signal', 'corroborated'),
      item('peer_devices', 'corroborated'),
    ])).toBe(true)
  })

  it('weak evidence alone never reaches the threshold — FR-CLS-007', () => {
    expect(canSupportUrgentAction([
      item('device_signal', 'weak'),
      item('peer_devices', 'weak'),
      item('route_history', 'weak'),
    ])).toBe(false)
  })
})

describe('absence is not evidence — FR-CLS-006', () => {
  it('produces no evidence item when no record exists', () => {
    expect(cellEvidenceFrom({ status: 'no_record', key: { mcc: 639, mnc: 2, lac: 1, cellId: 2 } }))
      .toBeUndefined()
    expect(cellEvidenceFrom({ status: 'layer_disabled' })).toBeUndefined()
  })

  it('describes a missing record as unknown, never as absent coverage', () => {
    const text = describeAbsence({ status: 'no_record', key: { mcc: 639, mnc: 2, lac: 1, cellId: 2 } })
    expect(text).toContain('says nothing about whether')
    expect(text).toContain('indistinguishable')
    // The wording that must never appear: a claim the data cannot support.
    expect(text).not.toMatch(/no coverage (existed|there)/)
  })

  it('distinguishes a disabled layer from a missing record', () => {
    expect(describeAbsence({ status: 'layer_disabled' })).toContain('not enabled')
  })

  it('the disabled layer returns a distinct state rather than an empty result', async () => {
    // Collapsing "off" into "nothing found" would let a tenant without the layer look like a tenant
    // whose cells are all unknown.
    await expect(new DisabledCellLookup().find()).resolves.toEqual({ status: 'layer_disabled' })
  })
})

describe('a found record is weak, and stays weak', () => {
  it('never rises above weak, whatever the sample count', () => {
    // The limit is what the measurement is — averaged reception, one tower holding several logical
    // cells — not how many times it was taken.
    for (const samples of [1, 100, 10_000]) {
      const evidence = cellEvidenceFrom({ ...found, record: { ...found.record, samples } })
      expect(evidence?.strength).toBe('weak')
    }
  })

  it('says what the number actually is, rather than implying a position', () => {
    const evidence = cellEvidenceFrom(found)
    expect(evidence?.summary).toContain('averaged from reception measurements')
    expect(evidence?.summary).not.toContain('located at')
  })
})

describe('the explanation shows what could not count', () => {
  it('separates counted evidence from excluded cell context', () => {
    const explanation = explainActionability([
      item('device_signal', 'corroborated'),
      item('cell_prior', 'weak'),
    ])
    expect(explanation.counted).toHaveLength(1)
    expect(explanation.excluded).toHaveLength(1)
    expect(explanation.actionable).toBe(false)
    expect(explanation.reason).toContain('context only')
  })

  it('names the family when direct evidence carries the decision', () => {
    const explanation = explainActionability([item('device_signal', 'direct')])
    expect(explanation.actionable).toBe(true)
    expect(explanation.reason).toContain('device_signal')
  })

  it('counts independent families when corroboration carries it', () => {
    const explanation = explainActionability([
      item('peer_devices', 'corroborated'),
      item('platform_health', 'corroborated'),
    ])
    expect(explanation.reason).toContain('2 independent evidence families')
  })
})

describe('acquisition route', () => {
  it('refuses the community API', () => {
    // Not permitted for commercial production without contributing data or being whitelisted, and
    // access may be withdrawn at any time.
    expect(() => assertAcquisitionPermitted('community_api')).toThrow(ForbiddenAcquisitionError)
  })

  it('permits a self-hosted snapshot or a commercial provider', () => {
    expect(() => assertAcquisitionPermitted('self_hosted_download')).not.toThrow()
    expect(() => assertAcquisitionPermitted('commercial_provider')).not.toThrow()
  })

  it('carries the CC BY-SA attribution', () => {
    expect(OPENCELLID_ATTRIBUTION).toContain('CC BY-SA 4.0')
  })
})

// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest'

import { emitBundle, type FindingsBundle } from '../bundle/emitter.js'
import {
  MissingNarrativeError,
  UnsupportedClaimError,
  renderReport,
  type Claim,
  type NarrativeSections,
} from './render.js'

const bundle: FindingsBundle = emitBundle({
  tenantLabel: 'customer-a',
  sourceLabels: ['traccar'],
  periodStart: '2026-05-01T00:00:00.000Z',
  periodEnd: '2026-08-01T00:00:00.000Z',
  generatedAt: '2026-08-05T12:00:00.000Z',
  containerVersion: '0.1.0',
  analyserVersions: { quality: '0.1.0' },
  sections: {
    completeness: [
      {
        model: 'FMB920', source: 'traccar', day: '2026-06-01', device_count: 140,
        field_group: 'power', denominator: 12_000, numerator: 11_400, excluded: 60,
      },
    ],
    episodes: [{ episode_type: 'total_silence', episode_count: 412, device_count: 96 }],
  },
}).bundle!

const claim = (text: string, status: Claim['status'] = 'observed', inputs?: string[]): Claim =>
  inputs === undefined ? { text, status } : { text, status, inputs }

const narrative: NarrativeSections = {
  dataRights: [claim('Raw export rights are evidenced in clause 7.2 of the Traccar agreement.')],
  reportingPolicyGaps: [claim('Sleep configuration is undocumented for 3 of 5 device models.')],
  baselineFeasibility: [claim('A timeout baseline is computable over the full period.')],
  recommendation: [claim('Proceed to a pilot once sleep configuration is archived.')],
}

const BASE = {
  bundle,
  narrative,
  recommendation: 'proceed_with_conditions' as const,
  customerName: 'Example Asset Finance',
  preparedBy: 'Blackout Forensics',
  preparedAt: '2026-08-06',
}

describe('the generator refuses to ship an omission', () => {
  it('renders when every slot is filled', () => {
    const html = renderReport(BASE)
    expect(html).toContain('Telemetry Control Audit')
    expect(html).toContain('Example Asset Finance')
  })

  it('throws when a narrative slot is empty, naming the slot', () => {
    // A report that quietly drops the data-rights grading looks complete to a customer who has no
    // way to know a section was skipped.
    expect(() =>
      renderReport({ ...BASE, narrative: { ...narrative, dataRights: [] } }),
    ).toThrow(MissingNarrativeError)

    try {
      renderReport({ ...BASE, narrative: { ...narrative, dataRights: [], recommendation: [] } })
    } catch (error) {
      expect((error as MissingNarrativeError).slots).toEqual(['dataRights', 'recommendation'])
    }
  })

  it('throws when a modeled claim shows no inputs', () => {
    // A modeled number without its inputs is indistinguishable from a measurement.
    expect(() =>
      renderReport({
        ...BASE,
        narrative: { ...narrative, baselineFeasibility: [claim('Roughly 30% fewer dispatches.', 'modeled')] },
      }),
    ).toThrow(UnsupportedClaimError)
  })

  it('accepts a modeled claim that shows its inputs', () => {
    const html = renderReport({
      ...BASE,
      narrative: {
        ...narrative,
        baselineFeasibility: [
          claim('Roughly 30% fewer dispatches.', 'modeled', [
            'current dispatch count: 412 per quarter, customer-supplied',
            'assumed suppression rate: 30%, not yet measured on your data',
          ]),
        ],
      },
    })
    expect(html).toContain('current dispatch count')
    expect(html).toContain('Modeled')
  })
})

describe('evidence status is visually inescapable', () => {
  it('renders a chip for every claim', () => {
    const html = renderReport({
      ...BASE,
      narrative: {
        ...narrative,
        dataRights: [
          claim('Export rights evidenced.', 'observed'),
          claim('Confirmed by your telematics lead.', 'customer-verified'),
          claim('SIM-side data rights could not be established.', 'unconfirmed'),
        ],
      },
    })
    for (const label of ['Observed', 'Customer-verified', 'Unconfirmed']) {
      expect(html).toContain(label)
    }
  })

  it('carries the legend, so a reader knows what the chips mean', () => {
    const html = renderReport(BASE)
    expect(html).toContain('no sufficient evidence')
  })
})

describe('the no-go path is a first-class output', () => {
  it('renders a no-go report that still stands on its own', () => {
    const html = renderReport({ ...BASE, recommendation: 'no_go' })
    expect(html).toContain('do not proceed to a pilot')
    // The engagement's terms require the audit to remain useful when the platform cannot proceed.
    expect(html).toContain('actionable with your vendors')
    // Measurements are still present.
    expect(html).toContain('completeness')
  })

  it('uses the same document for every recommendation', () => {
    const lengths = (['proceed_to_pilot', 'proceed_with_conditions', 'no_go'] as const).map(
      (r) => renderReport({ ...BASE, recommendation: r }).length,
    )
    // Same structure, different recommendation section — no branch produces a stub.
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(600)
  })
})

describe('traceability and safety', () => {
  it('embeds bundle hashes so a number traces to the run that produced it', () => {
    const html = renderReport(BASE)
    expect(html).toContain(bundle.manifest.content_hashes['completeness']!.slice(0, 12))
    expect(html).toContain('0.1.0')
  })

  it('publishes the threshold reasoning rather than only the thresholds', () => {
    const html = renderReport(BASE)
    expect(html).toContain('How these thresholds were chosen')
    expect(html).toContain('modeled')
  })

  it('states the licence to the customer on the document, not in a side letter', () => {
    const html = renderReport(BASE)
    expect(html).toContain('share this report with')
    expect(html).toContain('Internal use unlimited')
  })

  it('disclaims cause, intent and fault', () => {
    // Matched tolerantly: the template wraps this sentence across lines.
    expect(renderReport(BASE)).toMatch(/does not assert cause,\s+intent or fault/)
  })

  it('escapes customer-supplied text rather than interpolating it raw', () => {
    const html = renderReport({
      ...BASE,
      customerName: '<script>alert(1)</script>',
      narrative: { ...narrative, dataRights: [claim('a & b < c')] },
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('a &amp; b &lt; c')
  })

  it('regenerates identically — no clock is read', () => {
    expect(renderReport(BASE)).toBe(renderReport(BASE))
  })

  it('says plainly when a section had no publishable rows', () => {
    const emptyBundle = emitBundle({
      tenantLabel: 'c', sourceLabels: ['s'],
      periodStart: '2026-05-01T00:00:00.000Z', periodEnd: '2026-08-01T00:00:00.000Z',
      generatedAt: '2026-08-05T12:00:00.000Z', containerVersion: '0.1.0',
      analyserVersions: { quality: '0.1.0' },
      // Every row falls below the cohort floor, so nothing is publishable.
      sections: { completeness: [{ model: 'X', device_count: 3, denominator: 10, numerator: 9 }] },
    }).bundle!

    const html = renderReport({ ...BASE, bundle: emptyBundle })
    expect(html).toContain('No rows met the cohort floor')
  })
})

// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { runScenario } from '@blackout/generator'

import { FACT_VOCABULARY_VERSION, deriveFacts } from '../rules/facts.js'
import { classify } from '../rules/classify.js'
import { CONTRADICTIONS, RULE_PACKAGES } from '../rules/packages.js'
import type { RulePackage } from '../rules/package.js'
import {
  CrossTenantCorrelationError,
  correlate,
  peerFactsFor,
  type CorrelationCandidate,
} from './peers.js'

const T0 = '2026-08-05T09:00:00.000Z'
const at = (offsetS: number): string => new Date(Date.parse(T0) + offsetS * 1000).toISOString()

const candidate = (overrides: Partial<CorrelationCandidate>): CorrelationCandidate => ({
  tenantId: 'synthetic_a',
  deviceRef: 'dev_0a000001',
  assetRef: 'ast_0a000001',
  source: 'traccar_forwarder',
  simProvider: 'safaricom_m2m',
  networkIdentity: '639-02',
  h3Cell: '86754e64fffffff',
  episodeStartAt: T0,
  ...overrides,
})

/**
 * N distinct assets, one tracker each, silent together on one source — with MIXED network
 * identities, as a real fleet has. A first draft gave them all one network, and H-NETWORK then
 * fired alongside H-VENDOR and claimed the suppressor slot: correct behaviour, careless fixture.
 * A platform outage does not imply a network outage, and the fixture should not imply it either.
 */
const outage = (n: number): CorrelationCandidate[] =>
  Array.from({ length: n }, (_, i) =>
    candidate({
      deviceRef: `dev_${String(i).padStart(8, '0')}`,
      assetRef: `ast_${String(i).padStart(8, '0')}`,
      networkIdentity: `639-${String(i % 4).padStart(2, '0')}`,
      episodeStartAt: at(i * 30),
    }),
  )

describe('a provider outage forms the expected cluster', () => {
  it('clusters five independent assets on one source', () => {
    const clusters = correlate(outage(5))
    const source = clusters.find((c) => c.dimension === 'source')

    expect(source).toBeDefined()
    expect(source?.key).toBe('traccar_forwarder')
    expect(source?.memberDevices).toHaveLength(5)
    expect(source?.independentCount).toBe(5)
    expect(source?.excluded).toEqual([])
    expect(source?.meetsMinimum).toBe(true)
  })

  it('correlates on every declared dimension the data carries', () => {
    const clusters = correlate(outage(4))
    expect(new Set(clusters.map((c) => c.dimension))).toEqual(
      new Set(['source', 'sim_provider', 'network', 'area']),
    )
  })

  it('a null dimension value never forms a key — unknown is not a group', () => {
    const clusters = correlate([
      candidate({ networkIdentity: null, h3Cell: null, simProvider: null }),
      candidate({ deviceRef: 'dev_0b000002', assetRef: 'ast_0b000002', networkIdentity: null, h3Cell: null, simProvider: null }),
    ])
    expect(clusters.every((c) => c.dimension === 'source')).toBe(true)
  })
})

describe('FR-COR-003: independence is counted over assets, with exclusions visible', () => {
  it('primary and secondary trackers on one motorcycle are one witness', () => {
    const clusters = correlate([
      candidate({ deviceRef: 'dev_11111111', assetRef: 'ast_shared01' }),
      candidate({ deviceRef: 'dev_22222222', assetRef: 'ast_shared01' }),
      candidate({ deviceRef: 'dev_33333333', assetRef: 'ast_other001' }),
    ])
    const source = clusters.find((c) => c.dimension === 'source')

    expect(source?.memberDevices).toHaveLength(3)
    expect(source?.independentCount).toBe(2)
    expect(source?.excluded).toEqual([
      { deviceRef: 'dev_22222222', reason: 'shares_asset', countedAs: 'dev_11111111' },
    ])
    // Two witnesses do not clear a floor of three: no incident is manufactured from one asset
    // wearing two trackers plus a neighbour.
    expect(source?.meetsMinimum).toBe(false)
  })

  it('the duplicated-data-path scenario counts one witness, not two', () => {
    // The generator's scenario: one device forwarded through two sources. On network and area
    // dimensions the same deviceRef appears twice and must collapse.
    const { events } = runScenario('duplicated-data-path', {
      seed: 71,
      startAt: '2026-08-05T06:00:00.000Z',
    })
    const seen = new Map<string, string>()
    for (const event of events) seen.set(`${event.device_ref}|${event.source}`, event.source)

    const candidates: CorrelationCandidate[] = [...seen.entries()].map(([key, source]) =>
      candidate({
        deviceRef: key.split('|')[0] as string,
        assetRef: 'ast_dup00001',
        source,
        episodeStartAt: T0,
      }),
    )
    expect(candidates).toHaveLength(2)

    const clusters = correlate(candidates)
    const network = clusters.find((c) => c.dimension === 'network')
    expect(network?.memberDevices).toHaveLength(1)
    expect(network?.independentCount).toBe(1)
    expect(network?.excluded).toEqual([
      expect.objectContaining({ reason: 'duplicate_device' }),
    ])
    expect(network?.meetsMinimum).toBe(false)
  })

  it('an unmapped device counts as its own witness', () => {
    // Unmapped is not co-mounted: merging the unmapped would undercount real incidents on fleets
    // with poor assignment coverage, which are precisely the fleets this product meets first.
    const clusters = correlate([
      candidate({ deviceRef: 'dev_aaaa0001', assetRef: null }),
      candidate({ deviceRef: 'dev_bbbb0002', assetRef: null }),
      candidate({ deviceRef: 'dev_cccc0003', assetRef: null }),
    ])
    expect(clusters.find((c) => c.dimension === 'source')?.independentCount).toBe(3)
  })
})

describe('FR-COR-004: the denominator travels with the cluster', () => {
  it('reports the affected fraction against the active population', () => {
    const clusters = correlate(outage(6), {
      activePopulation: { 'source:traccar_forwarder': 60 },
    })
    const source = clusters.find((c) => c.dimension === 'source')
    expect(source?.activePopulation).toBe(60)
    expect(source?.affectedFraction).toBeCloseTo(0.1)
  })

  it('an unknown population is null, never fabricated', () => {
    const source = correlate(outage(6)).find((c) => c.dimension === 'source')
    expect(source?.activePopulation).toBeNull()
    expect(source?.affectedFraction).toBeNull()
  })
})

describe('FR-COR-005: the tenant wall', () => {
  it('refuses mixed-tenant input outright', () => {
    expect(() =>
      correlate([
        candidate({}),
        candidate({ tenantId: 'synthetic_b', deviceRef: 'dev_0b000009' }),
      ]),
    ).toThrow(CrossTenantCorrelationError)
  })
})

describe('time windows', () => {
  it('splits bursts separated by more than the window', () => {
    const clusters = correlate(
      [
        candidate({ deviceRef: 'dev_00000001', assetRef: 'ast_00000001', episodeStartAt: at(0) }),
        candidate({ deviceRef: 'dev_00000002', assetRef: 'ast_00000002', episodeStartAt: at(60) }),
        candidate({ deviceRef: 'dev_00000003', assetRef: 'ast_00000003', episodeStartAt: at(7200) }),
      ],
      { windowS: 1800 },
    ).filter((c) => c.dimension === 'source')

    expect(clusters).toHaveLength(2)
    expect(clusters[0]?.memberDevices).toHaveLength(2)
    expect(clusters[1]?.memberDevices).toHaveLength(1)
  })

  it('anchors the window on the first start, so a slow drip cannot chain into one endless incident', () => {
    // Starts at 0, 25, 50, 75 minutes with a 30-minute window: a previous-member chain would make
    // one cluster of four; anchoring on the first start makes two of two.
    const clusters = correlate(
      [0, 1500, 3000, 4500].map((s, i) =>
        candidate({
          deviceRef: `dev_0000000${i}`,
          assetRef: `ast_0000000${i}`,
          episodeStartAt: at(s),
        }),
      ),
      { windowS: 1800 },
    ).filter((c) => c.dimension === 'source')

    expect(clusters.map((c) => c.memberDevices.length)).toEqual([2, 2])
  })
})

describe('determinism', () => {
  it('input order never changes the clusters', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 1, maxLength: 25 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (offsets, seed) => {
          const candidates = offsets.map((offset, i) =>
            candidate({
              deviceRef: `dev_${String(i).padStart(8, '0')}`,
              assetRef: `ast_${String(i % 7).padStart(8, '0')}`,
              episodeStartAt: at(offset * 120),
            }),
          )
          // A cheap deterministic shuffle from the seed.
          const shuffled = [...candidates].sort(
            (a, b) => ((seed * a.deviceRef.charCodeAt(6)) % 97) - ((seed * b.deviceRef.charCodeAt(6)) % 97),
          )
          return (
            JSON.stringify(correlate(candidates)) === JSON.stringify(correlate(shuffled))
          )
        },
      ),
      { numRuns: 150 },
    )
  })

  it('independence never exceeds membership, and exclusions account for the difference', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            device: fc.integer({ min: 0, max: 12 }),
            asset: fc.integer({ min: 0, max: 5 }),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (pairs) => {
          const candidates = pairs.map((p) =>
            candidate({
              deviceRef: `dev_${String(p.device).padStart(8, '0')}`,
              assetRef: `ast_${String(p.asset).padStart(8, '0')}`,
            }),
          )
          return correlate(candidates).every(
            (cluster) =>
              cluster.independentCount <= cluster.memberDevices.length &&
              cluster.independentCount + cluster.excluded.filter((e) => e.reason === 'shares_asset').length ===
                new Set(candidates.filter((c) => cluster.memberDevices.includes(c.deviceRef)).map((c) => c.deviceRef)).size,
          )
        },
      ),
      { numRuns: 150 },
    )
  })
})

describe('the §17.2 loop, closed end to end', () => {
  const classifyWith = (peers: ReturnType<typeof peerFactsFor>, extraFacts: Record<string, boolean>) => {
    const facts = deriveFacts({
      alerts: {
        powerCut: extraFacts['powerCut'] ?? false,
        tamper: extraFacts['tamper'] ?? false,
        gnssJamming: null,
        networkJamming: null,
      },
      peers,
    })
    return classify({
      facts,
      packages: [
        ...RULE_PACKAGES.filter((r) => r.hypothesis !== 'H-TAMPER'),
        // A non-direct interference reading, the shape a future inference rule takes — the shipped
        // rule is direct-only and direct evidence is constitutionally unsuppressable.
        {
          ...(RULE_PACKAGES.find((r) => r.id === 'rule.h-tamper.direct-signal') as RulePackage),
          id: 'rule.h-tamper.silence-inference',
          produces: {
            family: 'device_signal',
            strength: 'corroborated',
            summary: 'device telemetry supports possible tracker interference',
          },
        },
      ],
      contradictions: CONTRADICTIONS,
      at: '2026-09-01T00:00:00.000Z',
      factVocabularyVersion: FACT_VOCABULARY_VERSION,
    })
  }

  it('a source-wide failure suppresses an inappropriate interference escalation', () => {
    // Five independent assets silent on one platform; this device shows a non-direct interference
    // reading. Correlation → facts → classification, with no hand-assembled numbers in between.
    const fleet = outage(5)
    const clusters = correlate(fleet)
    const peers = peerFactsFor(fleet[0]!, clusters)

    expect(peers.sourceIndependentDevices).toBe(5)
    expect(peers.sourceHealthIncident).toBe(true)

    const result = classifyWith(peers, { tamper: true })
    const tamper = result.hypotheses.find((h) => h.code === 'H-TAMPER')
    const vendor = result.hypotheses.find((h) => h.code === 'H-VENDOR')

    expect(vendor?.band).toBe('corroborated')
    expect(tamper?.suppressedBy).toBe('H-VENDOR')
    expect(tamper?.band).toBe('weak')
    expect(result.urgentEligible).toBe(false)
  })

  it('the same failure cannot mask a direct power cut', () => {
    const fleet = outage(5)
    const peers = peerFactsFor(fleet[0]!, correlate(fleet))

    const result = classifyWith(peers, { powerCut: true })
    const power = result.hypotheses.find((h) => h.code === 'H-POWER')

    expect(power?.band).toBe('direct')
    expect(power?.suppressedBy).toBeNull()
    expect(result.urgentEligible).toBe(true)
  })

  it('two silent devices do not manufacture an incident', () => {
    const fleet = outage(2)
    const peers = peerFactsFor(fleet[0]!, correlate(fleet))

    expect(peers.sourceIndependentDevices).toBe(2)
    expect(peers.sourceHealthIncident).toBe(false)

    const result = classifyWith(peers, {})
    // The count is real, the rule's floor declines it: FR-COR-002 enforced exactly once.
    expect(result.hypotheses.find((h) => h.code === 'H-VENDOR')).toBeUndefined()
  })

  it('a device outside every cluster reports zero peers, not unknown ones', () => {
    const lone = candidate({ deviceRef: 'dev_ffffffff', assetRef: 'ast_ffffffff' })
    const peers = peerFactsFor(lone, [])
    expect(peers.sourceIndependentDevices).toBe(0)
    expect(peers.sourceHealthIncident).toBe(false)
    // Identity was observed, so the network count is a real zero rather than an unknown.
    expect(peers.networkIndependentDevices).toBe(0)
    expect(peers.networkIdentityKnown).toBe(true)
  })

  it('an unobserved network identity stays unknown all the way through', () => {
    const blind = candidate({ deviceRef: 'dev_eeeeeeee', networkIdentity: null })
    const peers = peerFactsFor(blind, correlate([blind]))
    expect(peers.networkIndependentDevices).toBeNull()
    expect(peers.networkIdentityKnown).toBe(false)

    // The H-NETWORK rule must be inapplicable, not merely unfired: FR-CLS-006 end to end.
    const result = classifyWith(peers, {})
    const network = result.notApplicable.find((r) => r.ruleId === 'rule.h-network.operator-cluster')
    expect(network?.missingFacts).toContain('network.independent_devices')
  })
})

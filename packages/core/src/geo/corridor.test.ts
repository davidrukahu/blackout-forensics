// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

import { latLngToCell } from 'h3-js'
import { describe, expect, it } from 'vitest'

import {
  CORRIDOR_H3_RESOLUTION,
  corridorBaseline,
  projectCorridor,
  wilsonLowerBound,
  type RoadEdge,
  type RoadGraph,
  type RoadNode,
} from './corridor.js'

const node = (id: string, lat: number, lon: number): RoadNode => ({ id, lat, lon })
const edge = (from: string, to: string, lengthM: number, overrides: Partial<RoadEdge> = {}): RoadEdge => ({
  from, to, lengthM, motorcycleAccess: true, carAccess: true, oneWay: false, roadName: null,
  ...overrides,
})
const cellOf = (n: RoadNode): string => latLngToCell(n.lat, n.lon, CORRIDOR_H3_RESOLUTION)

/**
 * Riverside: two approach routes on each side of a single bridge. The bridge is the corridor —
 * unavoidable whichever approach was ridden. Nodes are spaced ~1–2 km so each lands in its own
 * res-8 cell.
 */
const RIVERSIDE: RoadGraph = {
  snapshotId: 'snap-riverside-1',
  nodes: [
    node('A', -1.28, 36.80),
    node('N1', -1.27, 36.815), node('S1', -1.29, 36.815),
    node('B', -1.28, 36.83),
    node('N2', -1.27, 36.845), node('S2', -1.29, 36.845),
    node('Z', -1.28, 36.86),
  ],
  edges: [
    edge('A', 'N1', 2000, { roadName: 'North Approach' }),
    edge('A', 'S1', 2000, { roadName: 'South Approach' }),
    edge('N1', 'B', 2000, { roadName: 'North Approach' }),
    edge('S1', 'B', 2000, { roadName: 'South Approach' }),
    edge('B', 'N2', 2000, { roadName: 'North Exit' }),
    edge('B', 'S2', 2000, { roadName: 'South Exit' }),
    edge('N2', 'Z', 2000, { roadName: 'North Exit' }),
    edge('S2', 'Z', 2000, { roadName: 'South Exit' }),
  ],
}

/** Grid: two fully disjoint routes. Nothing interior is shared, so no corridor can be claimed. */
const GRID: RoadGraph = {
  snapshotId: 'snap-grid-1',
  nodes: [
    node('A', -1.28, 36.80),
    node('P', -1.27, 36.83),
    node('Q', -1.29, 36.83),
    node('Z', -1.28, 36.86),
  ],
  edges: [
    edge('A', 'P', 2500), edge('P', 'Z', 2500),
    edge('A', 'Q', 2500), edge('Q', 'Z', 2500),
  ],
}

/** Shortcut: the only route that fits a tight budget is a motorcycle-only path. */
const SHORTCUT: RoadGraph = {
  snapshotId: 'snap-shortcut-1',
  nodes: [
    node('A', -1.28, 36.80),
    node('M', -1.28, 36.83),
    node('P', -1.26, 36.83),
    node('Z', -1.28, 36.86),
  ],
  edges: [
    edge('A', 'M', 2000, { carAccess: false, roadName: 'Footbridge Track' }),
    edge('M', 'Z', 2000, { carAccess: false, roadName: 'Footbridge Track' }),
    edge('A', 'P', 2500), edge('P', 'Z', 2500),
  ],
}

const REQUEST = {
  graph: RIVERSIDE,
  fromNodeId: 'A',
  toNodeId: 'Z',
  elapsedS: 1200,
  maxSpeedKph: 40,
}

describe('the corridor is the intersection: what every feasible path must cross', () => {
  it('finds the bridge and only the bridge', () => {
    const result = projectCorridor(REQUEST)
    expect(result.status).toBe('corridor')
    if (result.status !== 'corridor') return

    const bridge = cellOf(RIVERSIDE.nodes.find((n) => n.id === 'B') as RoadNode)
    const endpoints = [
      cellOf(RIVERSIDE.nodes.find((n) => n.id === 'A') as RoadNode),
      cellOf(RIVERSIDE.nodes.find((n) => n.id === 'Z') as RoadNode),
    ]
    expect(result.corridorCells).toEqual([...endpoints, bridge].sort())
    // The avoidable approaches are feasible context, never the claim.
    for (const id of ['N1', 'S1', 'N2', 'S2']) {
      const cell = cellOf(RIVERSIDE.nodes.find((n) => n.id === id) as RoadNode)
      expect(result.feasibleCells).toContain(cell)
      expect(result.corridorCells).not.toContain(cell)
    }
  })

  it('returns cells, never geometry: nothing in the result can draw a line', () => {
    const result = projectCorridor(REQUEST)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('lat')
    expect(serialized).not.toContain('lon')
    expect(serialized).not.toContain('geometry')
  })

  it('fully disjoint routes are ambiguous, with the reason stated', () => {
    const result = projectCorridor({ ...REQUEST, graph: GRID })
    expect(result.status).toBe('corridor_ambiguous')
    if (result.status !== 'corridor_ambiguous') return
    expect(result.reason).toContain('below the floor')
    // The feasible region is still reported — "somewhere in here" survives; "along here" does not.
    expect(result.feasibleCells.length).toBeGreaterThan(2)
  })

  it('endpoint cells never satisfy the floor by themselves', () => {
    // The endpoints are trivially unavoidable; a corridor of nothing but endpoints is the
    // three-cell stub ticket 40 refuses to call agreement.
    const result = projectCorridor({ ...REQUEST, graph: GRID, minInteriorCells: 1 })
    expect(result.status).toBe('corridor_ambiguous')
  })
})

describe('feasibility is reachability, not routing', () => {
  it('reports infeasible when no path fits the elapsed time at the conservative bound', () => {
    const result = projectCorridor({ ...REQUEST, elapsedS: 300 })
    expect(result.status).toBe('infeasible')
    if (result.status !== 'infeasible') return
    expect(result.reason).toContain('inconsistent with the road network')
  })

  it('a wider budget widens the feasible region and never narrows the corridor claim', () => {
    const tight = projectCorridor(REQUEST)
    const loose = projectCorridor({ ...REQUEST, elapsedS: 3600 })
    if (tight.status !== 'corridor' || loose.status !== 'corridor') throw new Error('expected corridors')
    expect(loose.feasibleCells.length).toBeGreaterThanOrEqual(tight.feasibleCells.length)
  })

  it('excludes impossible paths: a one-way against travel does not carry feasibility', () => {
    const oneWayGrid: RoadGraph = {
      ...GRID,
      edges: [
        edge('A', 'P', 2500), edge('P', 'Z', 2500),
        // The Q route exists only in the wrong direction.
        edge('Z', 'Q', 2500, { oneWay: true }), edge('Q', 'A', 2500, { oneWay: true }),
      ],
    }
    const result = projectCorridor({ ...REQUEST, graph: oneWayGrid })
    expect(result.status).toBe('corridor')
    if (result.status !== 'corridor') return
    const q = cellOf(GRID.nodes.find((n) => n.id === 'Q') as RoadNode)
    expect(result.feasibleCells).not.toContain(q)
    // With Q gone, P becomes unavoidable: the intersection tightens as alternatives fall away.
    expect(result.corridorCells).toContain(cellOf(GRID.nodes.find((n) => n.id === 'P') as RoadNode))
  })
})

describe('the access profile matters, and motorcycle is the default', () => {
  const tightBudget = { graph: SHORTCUT, fromNodeId: 'A', toNodeId: 'Z', elapsedS: 400, maxSpeedKph: 40 }

  it('a car profile understates a boda: same evidence, opposite conclusions', () => {
    // Budget 4444 m: the 4000 m motorcycle track fits, the 5000 m road does not.
    const moto = projectCorridor(tightBudget)
    const car = projectCorridor({ ...tightBudget, profile: 'car' })

    expect(moto.status).toBe('corridor')
    if (moto.status === 'corridor') {
      expect(moto.corridorCells).toContain(cellOf(SHORTCUT.nodes.find((n) => n.id === 'M') as RoadNode))
    }
    // For a car the movement is impossible — which is why profile choice is an evidence question,
    // not a rendering preference.
    expect(car.status).toBe('infeasible')
  })
})

describe('the manifest makes the corridor reproducible', () => {
  it('records snapshot, profile, bounds and budget on every outcome', () => {
    for (const result of [
      projectCorridor(REQUEST),
      projectCorridor({ ...REQUEST, graph: GRID }),
      projectCorridor({ ...REQUEST, elapsedS: 300 }),
    ]) {
      expect(result.manifest.snapshotId).toMatch(/^snap-/)
      expect(result.manifest.profile).toBe('motorcycle')
      expect(result.manifest.maxSpeedKph).toBe(40)
      expect(result.manifest.budgetM).toBeGreaterThan(0)
      expect(result.manifest.minInteriorCells).toBe(1)
    }
  })

  it('is deterministic: identical requests produce identical results', () => {
    expect(JSON.stringify(projectCorridor(REQUEST))).toBe(JSON.stringify(projectCorridor(REQUEST)))
  })

  it('the table is the primary representation and names the roads through each cell', () => {
    const result = projectCorridor(REQUEST)
    if (result.status !== 'corridor') throw new Error('expected corridor')
    expect(result.table).toHaveLength(result.corridorCells.length)
    const bridgeRow = result.table.find(
      (row) => row.h3Cell === cellOf(RIVERSIDE.nodes.find((n) => n.id === 'B') as RoadNode),
    )
    expect(bridgeRow?.roadNames.length).toBeGreaterThan(0)
  })
})

describe('recurring baselines need data AND surprise', () => {
  const assetDays = (assets: number, days: number) =>
    Array.from({ length: assets * days }, (_, i) => ({
      assetRef: `ast_${String(i % assets).padStart(8, '0')}`,
      day: `2026-08-${String((i % days) + 1).padStart(2, '0')}`,
    }))

  const fleet = { traversals: 10_000, deviceHours: 50_000, blackouts: 100 }

  it('qualifies a corridor that is both sampled and genuinely worse', () => {
    const baseline = corridorBaseline(
      { h3Cell: 'cell-a', assetDays: assetDays(8, 5), traversals: 400, deviceHours: 900, blackouts: 40 },
      fleet,
    )
    expect(baseline.countFloorMet).toBe(true)
    expect(baseline.significantlyAboveByTraversals).toBe(true)
    expect(baseline.significantlyAboveByDeviceHours).toBe(true)
    expect(baseline.denominatorsDisagree).toBe(false)
    expect(baseline.qualified).toBe(true)
  })

  it('volume alone does not qualify: a busy corridor at the fleet rate is just busy', () => {
    const baseline = corridorBaseline(
      { h3Cell: 'cell-b', assetDays: assetDays(40, 10), traversals: 5000, deviceHours: 20_000, blackouts: 50 },
      fleet,
    )
    expect(baseline.countFloorMet).toBe(true)
    expect(baseline.qualified).toBe(false)
  })

  it('one bad afternoon does not qualify: the floor blocks tiny samples', () => {
    const baseline = corridorBaseline(
      { h3Cell: 'cell-c', assetDays: [{ assetRef: 'ast_00000001', day: '2026-08-01' }], traversals: 4, deviceHours: 6, blackouts: 3 },
      fleet,
    )
    expect(baseline.countFloorMet).toBe(false)
    expect(baseline.qualified).toBe(false)
  })

  it('disagreeing denominators are surfaced, not blended', () => {
    // High rate per traversal, unremarkable per device-hour: the shape of map-matching failing
    // exactly where the numerator grows.
    const baseline = corridorBaseline(
      { h3Cell: 'cell-d', assetDays: assetDays(8, 5), traversals: 30, deviceHours: 5000, blackouts: 9 },
      fleet,
    )
    expect(baseline.significantlyAboveByTraversals).toBe(true)
    expect(baseline.significantlyAboveByDeviceHours).toBe(false)
    expect(baseline.denominatorsDisagree).toBe(true)
    expect(baseline.qualified).toBe(false)
  })

  it('both denominators are always present, and an empty one is null rather than zero', () => {
    const baseline = corridorBaseline(
      { h3Cell: 'cell-e', assetDays: assetDays(6, 4), traversals: 0, deviceHours: 100, blackouts: 2 },
      fleet,
    )
    expect(baseline.ratePerTraversal).toBeNull()
    expect(baseline.ratePerDeviceHour).toBeCloseTo(0.02)
  })

  it('the Wilson bound behaves at its edges', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0)
    expect(wilsonLowerBound(0, 100)).toBe(0)
    expect(wilsonLowerBound(100, 100)).toBeGreaterThan(0.9)
    expect(wilsonLowerBound(5, 10)).toBeLessThan(0.5)
  })
})

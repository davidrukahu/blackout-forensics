// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Corridor projection: where a silent vehicle could have been, said honestly.
 *
 * Ticket 40's decisions, implemented literally:
 *
 *   * The output is a set of H3 cells — never a line. A line is the most confident-looking thing
 *     on a map and claims more than two fixes and an elapsed time can support (§9.3).
 *   * Feasibility comes from BIDIRECTIONAL REACHABILITY, not routing. A router assumes a
 *     destination and therefore intent, which a theft or a breakdown violates. A node lies on some
 *     feasible path exactly when forward-distance + backward-distance fits the budget.
 *   * The published corridor is the INTERSECTION: cells every feasible path must cross. A bridge
 *     over a river is unavoidable; four parallel city streets are not. Ambiguity falls out of the
 *     definition — divergent paths share nothing — with only an interior-cell floor as a constant.
 *   * The speed bound is the CONSERVATIVE (upper) bound. Overestimating speed inflates the region,
 *     which is safe; underestimating it manufactures false confidence, which is not.
 *
 * The road graph is a port. Production binds it to an OSRM/PostGIS-backed implementation over the
 * pinned snapshot; tests bind it to synthetic topology. The geometry logic itself is deterministic
 * and network-free (§12.6), which is also what makes a corridor reproducible from its manifest.
 */

import { latLngToCell } from 'h3-js'

/** Ticket 32: res 8 (~0.74 km²) for corridor geometry. */
export const CORRIDOR_H3_RESOLUTION = 8

export interface RoadNode {
  readonly id: string
  readonly lat: number
  readonly lon: number
}

export interface RoadEdge {
  readonly from: string
  readonly to: string
  readonly lengthM: number
  /**
   * Boda riders use paths and crossings a car profile excludes. Computing reachability with a car
   * profile understates where a motorcycle could be and produces a falsely tight corridor — the
   * unsafe direction — so access is per-mode and the motorcycle profile is the default.
   */
  readonly motorcycleAccess: boolean
  readonly carAccess: boolean
  readonly oneWay: boolean
  readonly roadName: string | null
}

export interface RoadGraph {
  readonly nodes: readonly RoadNode[]
  readonly edges: readonly RoadEdge[]
  /** The pinned map snapshot this graph was built from (FR-GEO-005). */
  readonly snapshotId: string
}

export type AccessProfile = 'motorcycle' | 'car'

export interface CorridorRequest {
  readonly graph: RoadGraph
  /** Nearest node to the last valid fix. */
  readonly fromNodeId: string
  /** Nearest node to the first recovery fix. */
  readonly toNodeId: string
  readonly elapsedS: number
  /** Upper plausible speed for the vehicle class — the conservative bound. */
  readonly maxSpeedKph: number
  readonly profile?: AccessProfile
  /**
   * Interior unavoidable cells required before a corridor is published. Endpoint cells are
   * trivially unavoidable and never count toward the floor — that is the "three-cell endpoint
   * stub" ticket 40 refuses to call agreement. Modeled default: 1.
   */
  readonly minInteriorCells?: number
}

export interface CorridorTableRow {
  readonly h3Cell: string
  readonly roadNames: readonly string[]
}

/**
 * §17.3: the exact language a corridor claim ships under. A corridor is a constraint on where the
 * vehicle could have been, never a statement of where it was — the phrase carries that epistemic
 * limit into every rendering, the same way the tamper phrase does for H-TAMPER.
 */
export const CORRIDOR_CLAIM_LABEL = 'possible corridor'

export type CorridorResult =
  | {
      readonly status: 'corridor'
      /** Always `CORRIDOR_CLAIM_LABEL`: outputs may not rename the claim into something stronger. */
      readonly claim: typeof CORRIDOR_CLAIM_LABEL
      /** Cells every feasible path must cross — the claim that holds whichever route was taken. */
      readonly corridorCells: readonly string[]
      /** The whole feasible region, for context rendering. Union, clearly weaker, never the claim. */
      readonly feasibleCells: readonly string[]
      /** §12.4/§17.3: the primary representation. The map is supplementary and disableable. */
      readonly table: readonly CorridorTableRow[]
      readonly manifest: CorridorManifest
    }
  | {
      readonly status: 'corridor_ambiguous'
      readonly reason: string
      readonly feasibleCells: readonly string[]
      readonly manifest: CorridorManifest
    }
  | {
      /**
       * No path fits the elapsed time even at the conservative bound. This is a finding in its own
       * right — recorded movement inconsistent with the road network, e.g. a vehicle carried rather
       * than ridden — and must never be papered over with an empty corridor.
       */
      readonly status: 'infeasible'
      readonly reason: string
      readonly manifest: CorridorManifest
    }

export interface CorridorManifest {
  readonly snapshotId: string
  readonly profile: AccessProfile
  readonly elapsedS: number
  readonly maxSpeedKph: number
  readonly budgetM: number
  readonly feasibleNodeCount: number
  readonly minInteriorCells: number
}

interface Adjacency {
  readonly forward: ReadonlyMap<string, readonly { to: string; lengthM: number }[]>
  readonly backward: ReadonlyMap<string, readonly { to: string; lengthM: number }[]>
}

function buildAdjacency(graph: RoadGraph, profile: AccessProfile): Adjacency {
  const forward = new Map<string, { to: string; lengthM: number }[]>()
  const backward = new Map<string, { to: string; lengthM: number }[]>()
  const add = (map: Map<string, { to: string; lengthM: number }[]>, from: string, to: string, lengthM: number): void => {
    map.set(from, [...(map.get(from) ?? []), { to, lengthM }])
  }

  for (const edge of graph.edges) {
    const passable = profile === 'motorcycle' ? edge.motorcycleAccess : edge.carAccess
    if (!passable) continue
    add(forward, edge.from, edge.to, edge.lengthM)
    add(backward, edge.to, edge.from, edge.lengthM)
    if (!edge.oneWay) {
      add(forward, edge.to, edge.from, edge.lengthM)
      add(backward, edge.from, edge.to, edge.lengthM)
    }
  }
  return { forward, backward }
}

/** Dijkstra over metres. Plain binary-heap-free implementation: graphs here are city-sized, not planetary. */
function shortestDistances(
  adjacency: ReadonlyMap<string, readonly { to: string; lengthM: number }[]>,
  start: string,
  budgetM: number,
): Map<string, number> {
  const distances = new Map<string, number>([[start, 0]])
  const settled = new Set<string>()

  for (;;) {
    let current: string | null = null
    let best = Number.POSITIVE_INFINITY
    for (const [node, distance] of distances) {
      if (!settled.has(node) && distance < best) {
        best = distance
        current = node
      }
    }
    if (current === null || best > budgetM) break
    settled.add(current)

    for (const { to, lengthM } of adjacency.get(current) ?? []) {
      const candidate = best + lengthM
      if (candidate <= budgetM && candidate < (distances.get(to) ?? Number.POSITIVE_INFINITY)) {
        distances.set(to, candidate)
      }
    }
  }

  for (const [node, distance] of [...distances]) {
    if (distance > budgetM) distances.delete(node)
  }
  return distances
}

const cellOfNode = (node: RoadNode): string =>
  latLngToCell(node.lat, node.lon, CORRIDOR_H3_RESOLUTION)

/**
 * Nodes lying on at least one feasible path: forward + backward distance fits the budget.
 */
function feasibleNodes(
  graph: RoadGraph,
  adjacency: Adjacency,
  fromNodeId: string,
  toNodeId: string,
  budgetM: number,
): Set<string> {
  const forward = shortestDistances(adjacency.forward, fromNodeId, budgetM)
  const backward = shortestDistances(adjacency.backward, toNodeId, budgetM)
  const feasible = new Set<string>()
  for (const node of graph.nodes) {
    const df = forward.get(node.id)
    const db = backward.get(node.id)
    if (df !== undefined && db !== undefined && df + db <= budgetM) feasible.add(node.id)
  }
  return feasible
}

/**
 * Project a corridor.
 *
 * Unavoidability is decided by deletion: a cell every feasible path must cross is exactly a cell
 * whose removal leaves no feasible path. Exact rather than sampled — a corridor is evidence, and
 * "we checked the paths we happened to enumerate" is not a claim that survives a dispute.
 */
export function projectCorridor(request: CorridorRequest): CorridorResult {
  const profile = request.profile ?? 'motorcycle'
  const minInteriorCells = request.minInteriorCells ?? 1
  const budgetM = (request.elapsedS * request.maxSpeedKph) / 3.6

  const adjacency = buildAdjacency(request.graph, profile)
  const nodesById = new Map(request.graph.nodes.map((n) => [n.id, n]))
  const from = nodesById.get(request.fromNodeId)
  const to = nodesById.get(request.toNodeId)
  if (from === undefined || to === undefined) {
    throw new Error('corridor endpoints must be nodes of the supplied graph')
  }

  const feasible = feasibleNodes(request.graph, adjacency, request.fromNodeId, request.toNodeId, budgetM)

  const manifest: CorridorManifest = {
    snapshotId: request.graph.snapshotId,
    profile,
    elapsedS: request.elapsedS,
    maxSpeedKph: request.maxSpeedKph,
    budgetM: Math.round(budgetM),
    feasibleNodeCount: feasible.size,
    minInteriorCells,
  }

  if (!feasible.has(request.fromNodeId) || !feasible.has(request.toNodeId) || feasible.size === 0) {
    return {
      status: 'infeasible',
      reason:
        'no road path fits the elapsed time even at the conservative speed bound; the recorded ' +
        'movement is inconsistent with the road network under this profile',
      manifest,
    }
  }

  const feasibleCells = [...new Set(
    [...feasible].map((id) => cellOfNode(nodesById.get(id) as RoadNode)),
  )].sort()

  // Endpoint cells are trivially unavoidable and never count toward agreement.
  const endpointCells = new Set([cellOfNode(from), cellOfNode(to)])
  const candidateCells = feasibleCells.filter((cell) => !endpointCells.has(cell))

  const unavoidable: string[] = []
  for (const cell of candidateCells) {
    const removed = new Set(
      [...feasible].filter((id) => cellOfNode(nodesById.get(id) as RoadNode) === cell),
    )
    const survivingAdjacency: Adjacency = {
      forward: filterAdjacency(adjacency.forward, removed),
      backward: filterAdjacency(adjacency.backward, removed),
    }
    const still = feasibleNodes(
      request.graph, survivingAdjacency, request.fromNodeId, request.toNodeId, budgetM,
    )
    if (!still.has(request.toNodeId)) unavoidable.push(cell)
  }

  if (unavoidable.length < minInteriorCells) {
    return {
      status: 'corridor_ambiguous',
      reason:
        `feasible paths share ${unavoidable.length} interior cell(s), below the floor of ` +
        `${minInteriorCells}: the routes diverge too much for any corridor to hold whichever ` +
        'path was taken',
      feasibleCells,
      manifest,
    }
  }

  const corridorCells = [...endpointCells, ...unavoidable].sort()
  const namesByCell = new Map<string, Set<string>>()
  for (const edge of request.graph.edges) {
    if (edge.roadName === null) continue
    for (const nodeId of [edge.from, edge.to]) {
      const node = nodesById.get(nodeId)
      if (node === undefined || !feasible.has(nodeId)) continue
      const cell = cellOfNode(node)
      if (!corridorCells.includes(cell)) continue
      namesByCell.set(cell, new Set([...(namesByCell.get(cell) ?? []), edge.roadName]))
    }
  }

  return {
    status: 'corridor',
    claim: CORRIDOR_CLAIM_LABEL,
    corridorCells,
    feasibleCells,
    table: corridorCells.map((cell) => ({
      h3Cell: cell,
      roadNames: [...(namesByCell.get(cell) ?? [])].sort(),
    })),
    manifest,
  }
}

function filterAdjacency(
  adjacency: ReadonlyMap<string, readonly { to: string; lengthM: number }[]>,
  removed: ReadonlySet<string>,
): ReadonlyMap<string, readonly { to: string; lengthM: number }[]> {
  const out = new Map<string, readonly { to: string; lengthM: number }[]>()
  for (const [from, edges] of adjacency) {
    if (removed.has(from)) continue
    out.set(from, edges.filter((e) => !removed.has(e.to)))
  }
  return out
}

// ---------------------------------------------------------------- recurring baselines

export interface CorridorExposure {
  readonly h3Cell: string
  /** Distinct (asset, day) pairs — FR-GEO-007's floor counts assets and days, not events. */
  readonly assetDays: readonly { readonly assetRef: string; readonly day: string }[]
  readonly traversals: number
  readonly deviceHours: number
  readonly blackouts: number
}

export interface FleetExposure {
  readonly traversals: number
  readonly deviceHours: number
  readonly blackouts: number
}

export interface CorridorBaseline {
  readonly h3Cell: string
  readonly distinctAssets: number
  readonly distinctDays: number
  readonly countFloorMet: boolean
  /** Both denominators, always together: they are biased in opposite directions. */
  readonly ratePerTraversal: number | null
  readonly ratePerDeviceHour: number | null
  readonly fleetRatePerTraversal: number | null
  readonly fleetRatePerDeviceHour: number | null
  readonly significantlyAboveByTraversals: boolean
  readonly significantlyAboveByDeviceHours: boolean
  /**
   * Bad under traversals but fine under device-hours says map-matching is failing here — a
   * data-quality finding worth surfacing on its own, which one blended number would bury.
   */
  readonly denominatorsDisagree: boolean
  readonly qualified: boolean
}

export interface BaselineOptions {
  /** FR-GEO-007's suggested defaults, configurable and shown in evidence. */
  readonly minAssets?: number
  readonly minDays?: number
}

/** Wilson score lower bound at 95%: the cautious end of what the sample supports. */
export function wilsonLowerBound(successes: number, trials: number): number {
  if (trials === 0) return 0
  const z = 1.96
  const p = successes / trials
  const denominator = 1 + (z * z) / trials
  const centre = p + (z * z) / (2 * trials)
  const margin = z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))
  return Math.max(0, (centre - margin) / denominator)
}

/**
 * Qualify a corridor as a recurring baseline: data AND surprise.
 *
 * The count floor establishes that there is data; the comparison against the fleet base rate, on
 * the Wilson lower bound, establishes that the data is unusual. A busy corridor qualifies on
 * neither volume alone nor a single bad afternoon.
 */
export function corridorBaseline(
  exposure: CorridorExposure,
  fleet: FleetExposure,
  options: BaselineOptions = {},
): CorridorBaseline {
  const minAssets = options.minAssets ?? 5
  const minDays = options.minDays ?? 3

  const distinctAssets = new Set(exposure.assetDays.map((a) => a.assetRef)).size
  const distinctDays = new Set(exposure.assetDays.map((a) => a.day)).size
  const countFloorMet = distinctAssets >= minAssets && distinctDays >= minDays

  const ratePerTraversal = exposure.traversals === 0 ? null : exposure.blackouts / exposure.traversals
  const ratePerDeviceHour = exposure.deviceHours === 0 ? null : exposure.blackouts / exposure.deviceHours
  const fleetRatePerTraversal = fleet.traversals === 0 ? null : fleet.blackouts / fleet.traversals
  const fleetRatePerDeviceHour = fleet.deviceHours === 0 ? null : fleet.blackouts / fleet.deviceHours

  const significantlyAboveByTraversals =
    fleetRatePerTraversal !== null &&
    exposure.traversals > 0 &&
    wilsonLowerBound(exposure.blackouts, exposure.traversals) > fleetRatePerTraversal

  const significantlyAboveByDeviceHours =
    fleetRatePerDeviceHour !== null &&
    exposure.deviceHours > 0 &&
    wilsonLowerBound(exposure.blackouts, Math.round(exposure.deviceHours)) > fleetRatePerDeviceHour

  return {
    h3Cell: exposure.h3Cell,
    distinctAssets,
    distinctDays,
    countFloorMet,
    ratePerTraversal,
    ratePerDeviceHour,
    fleetRatePerTraversal,
    fleetRatePerDeviceHour,
    significantlyAboveByTraversals,
    significantlyAboveByDeviceHours,
    denominatorsDisagree: significantlyAboveByTraversals !== significantlyAboveByDeviceHours,
    qualified: countFloorMet && significantlyAboveByTraversals && significantlyAboveByDeviceHours,
  }
}

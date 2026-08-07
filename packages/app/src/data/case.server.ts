// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Case detail assembly — PRD §9.3's mandated order as a data shape.
 *
 * The route renders `CaseDetail.sections` in array order and nothing else, so the §9.3 ordering
 * (reason and uncertainty before everything; the corridor's table before any map; peers with
 * their denominator) is decided here, testably, not in JSX. Every value is computed by the same
 * domain functions production uses; where something cannot be computed, the section says so and
 * says why — an absent section would be indistinguishable from an empty result.
 */

import { CORRIDORS, distanceM, type CanonicalEvent, type Corridor } from '@blackout/generator'

import {
  ALLOWED_TRANSITIONS,
  CORPUS_POLICY,
  RULE_PACKAGES,
  correlate,
  currentEpisodeVersion,
  projectCorridor,
  type ClassificationResult,
  type CorrelationCandidate,
  type CorridorResult,
  type Episode,
  type PeerCluster,
  type QueueItem,
  type RoadGraph,
} from './core.server.js'

/** §9.3's order, fixed here. The route maps over this array; reordering is a test failure. */
export const CASE_SECTION_ORDER = [
  'reason_and_uncertainty',
  'evidence',
  'timeline',
  'observations',
  'corridor',
  'peers',
  'policies',
  'actions_and_decisions',
] as const
export type CaseSection = (typeof CASE_SECTION_ORDER)[number]

export interface TimelineEntry {
  readonly at: string
  readonly kind: 'transition' | 'action'
  readonly summary: string
  readonly actor: string
}

export interface EvidenceEntry {
  readonly code: string
  readonly ruleId: string
  readonly ruleVersion: string
  readonly band: string
  readonly summary: string
  readonly supporting: string
  readonly counterevidence: readonly string[]
  readonly missingExpected: readonly string[]
  readonly suppressedBy: string | null
  readonly humanReview: boolean
}

export type CorridorSection =
  | { readonly state: 'not_computed'; readonly reason: string }
  | { readonly state: 'corridor' | 'corridor_ambiguous' | 'infeasible'; readonly result: CorridorResult }

export interface CaseDetail {
  readonly sections: typeof CASE_SECTION_ORDER
  readonly item: QueueItem
  readonly reason: {
    readonly headline: string
    readonly priorityFactors: readonly { factor: string; effect: string; fromRule: string }[]
    readonly urgentEligible: boolean
    readonly uncertainty: string
  }
  readonly evidence: {
    readonly entries: readonly EvidenceEntry[]
    readonly notApplicable: readonly { code: string; missingFacts: readonly string[] }[]
    readonly unknown: { readonly reason: string; readonly missingExpected: readonly string[] } | null
  }
  readonly timeline: readonly TimelineEntry[]
  readonly observations: {
    readonly lastValidAt: string | null
    readonly nextValidAt: string | null
    readonly note: string
  }
  readonly corridor: CorridorSection
  readonly peers: {
    readonly clusters: readonly PeerCluster[]
    readonly fleetSize: number
    readonly note: string
  }
  readonly policies: {
    readonly record: typeof CORPUS_POLICY
    readonly suppressionWindows: readonly unknown[]
  }
  readonly decisions: {
    readonly prior: readonly { kind: string; at: string; reference: string }[]
    readonly available: readonly string[]
  }
}

// ------------------------------------------------------------------ corridor graph

/**
 * A road graph from the corridor skeleton the generator drove over: waypoints as nodes, legs as
 * edges. Where the corridor declares an ambiguity-dense junction, a parallel leg models it —
 * synthetic geometry for synthetic data, and the projection over it is computed, never asserted.
 */
export function graphForCorridor(corridor: Corridor): RoadGraph {
  const nodes = corridor.waypoints.map((w, i) => ({ id: `w${i}`, lat: w.lat, lon: w.lon }))
  const edges = corridor.waypoints.slice(0, -1).flatMap((from, i) => {
    const to = corridor.waypoints[i + 1]!
    return [{
      from: `w${i}`, to: `w${i + 1}`,
      lengthM: Math.max(1, Math.round(distanceM(from, to))),
      motorcycleAccess: true, carAccess: true, oneWay: false,
      roadName: corridor.name,
    }]
  })

  if (corridor.hasAmbiguousJunction && corridor.waypoints.length >= 3) {
    const k = Math.floor(corridor.waypoints.length / 2) - 1
    const from = corridor.waypoints[k]!
    const to = corridor.waypoints[k + 1]!
    const detourId = `w${k}-alt`
    nodes.push({
      id: detourId,
      lat: (from.lat + to.lat) / 2 + 0.008,
      lon: (from.lon + to.lon) / 2,
    })
    const half = Math.max(1, Math.round(distanceM(from, to) / 2) + 400)
    edges.push(
      { from: `w${k}`, to: detourId, lengthM: half, motorcycleAccess: true, carAccess: true, oneWay: false, roadName: `${corridor.name} (parallel route)` },
      { from: detourId, to: `w${k + 1}`, lengthM: half, motorcycleAccess: true, carAccess: true, oneWay: false, roadName: `${corridor.name} (parallel route)` },
    )
  }

  return { snapshotId: `skeleton-${corridor.id}`, nodes, edges }
}

function nearestNodeId(corridor: Corridor, lat: number, lon: number): string {
  let best = 0
  let bestD = Number.POSITIVE_INFINITY
  corridor.waypoints.forEach((w, i) => {
    const d = distanceM(w, { lat, lon })
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return `w${best}`
}

function positionOf(event: CanonicalEvent): { lat: number; lon: number } | null {
  const position = event.position as { lat?: number; lon?: number; valid?: boolean } | null | undefined
  if (position?.valid !== true || position.lat === undefined || position.lon === undefined) return null
  return { lat: position.lat, lon: position.lon }
}

export function corridorSectionFor(params: {
  readonly episode: Episode
  readonly events: readonly CanonicalEvent[]
  readonly corridorId: string
}): CorridorSection {
  const corridor = CORRIDORS.find((c) => c.id === params.corridorId)
  if (corridor === undefined) {
    return { state: 'not_computed', reason: 'no route skeleton covers this episode' }
  }
  const version = currentEpisodeVersion(params.episode)
  if (version.endAt === null) {
    return {
      state: 'not_computed',
      reason: 'the episode is still open: a corridor needs a recovery fix to bound it',
    }
  }

  const startMs = Date.parse(version.startAt)
  const endMs = Date.parse(version.endAt)
  const timeOf = (e: CanonicalEvent): number => Date.parse((e.device_time ?? e.received_at) as string)

  const lastValid = [...params.events]
    .filter((e) => timeOf(e) <= startMs && positionOf(e) !== null)
    .sort((a, b) => timeOf(a) - timeOf(b))
    .at(-1)
  const nextValid = [...params.events]
    .filter((e) => timeOf(e) >= endMs && positionOf(e) !== null)
    .sort((a, b) => timeOf(a) - timeOf(b))[0]

  if (lastValid === undefined || nextValid === undefined) {
    return {
      state: 'not_computed',
      reason: 'no valid fix on both sides of the gap: nothing bounds where the vehicle could have been',
    }
  }

  const from = positionOf(lastValid)!
  const to = positionOf(nextValid)!
  const result = projectCorridor({
    graph: graphForCorridor(corridor),
    fromNodeId: nearestNodeId(corridor, from.lat, from.lon),
    toNodeId: nearestNodeId(corridor, to.lat, to.lon),
    elapsedS: Math.max(60, (timeOf(nextValid) - timeOf(lastValid)) / 1000),
    maxSpeedKph: 90,
  })
  return { state: result.status, result }
}

// ------------------------------------------------------------------ assembly

export interface CaseSource {
  readonly episode: Episode
  readonly classification: ClassificationResult
  readonly events: readonly CanonicalEvent[]
  readonly corridorId: string
}

export function buildCaseDetail(params: {
  readonly record: CaseSource
  readonly item: QueueItem
  readonly fleet: readonly CaseSource[]
}): CaseDetail {
  const { record, item, fleet } = params
  const { classification, episode } = record
  const version = currentEpisodeVersion(episode)

  const ruleById = new Map(RULE_PACKAGES.map((rule) => [rule.id, rule]))

  const evidenceEntries: EvidenceEntry[] = classification.hypotheses.map((h) => {
    const rule = ruleById.get(h.ruleId)
    return {
      code: h.code,
      ruleId: h.ruleId,
      ruleVersion: h.ruleVersion,
      band: h.band,
      summary: rule?.produces.summary ?? h.evidence.summary,
      supporting: h.evidence.summary,
      counterevidence: h.counterevidence.map((c) => c.summary),
      missingExpected: h.missingExpected,
      suppressedBy: h.suppressedBy,
      humanReview: h.humanReview,
    }
  })

  const timeline: TimelineEntry[] = [
    ...episode.versions.map((v) => ({
      at: v.at,
      kind: 'transition' as const,
      summary: `${v.supersedes === null ? 'opened as' : '→'} ${v.state} (${v.cause}): ${v.reason}`,
      actor: v.actor,
    })),
    ...episode.actions.map((a) => ({
      at: a.at,
      kind: 'action' as const,
      summary: `${a.kind.replaceAll('_', ' ')} — ${a.reference}`,
      actor: 'recorded action',
    })),
  ].sort((a, b) => a.at.localeCompare(b.at))

  const timeOf = (e: CanonicalEvent): number => Date.parse((e.device_time ?? e.received_at) as string)
  const lastValid = [...record.events]
    .filter((e) => timeOf(e) <= Date.parse(version.startAt) && positionOf(e) !== null)
    .sort((a, b) => timeOf(a) - timeOf(b))
    .at(-1)
  const nextValid =
    version.endAt === null
      ? undefined
      : [...record.events]
          .filter((e) => timeOf(e) >= Date.parse(version.endAt as string) && positionOf(e) !== null)
          .sort((a, b) => timeOf(a) - timeOf(b))[0]

  const candidates: CorrelationCandidate[] = fleet.map((source) => {
    const network = source.events[0]?.network as { mcc?: number; mnc?: number } | null | undefined
    const identity =
      network?.mcc !== undefined && network.mnc !== undefined
        ? `${network.mcc}-${String(network.mnc).padStart(2, '0')}`
        : null
    return {
      tenantId: source.events[0]?.tenant_id ?? 'synthetic_demo',
      deviceRef: source.episode.deviceRef,
      assetRef: null,
      source: source.events[0]?.source ?? 'unknown',
      simProvider: identity,
      networkIdentity: identity,
      h3Cell: null,
      episodeStartAt: currentEpisodeVersion(source.episode).startAt,
    }
  })
  // Only clusters meeting FR-COR-002's independent-device minimum are shown as peer evidence;
  // a cluster of one is not corroboration and must not dress up as it.
  const clusters = correlate(candidates).filter(
    (cluster) => cluster.memberDevices.includes(episode.deviceRef) && cluster.meetsMinimum,
  )
  const fleetSize = new Set(fleet.map((source) => source.episode.deviceRef)).size

  return {
    sections: CASE_SECTION_ORDER,
    item,
    reason: {
      headline:
        classification.unknown !== null
          ? `Unknown cause: ${classification.unknown.reason}`
          : `Hypotheses: ${classification.hypotheses.map((h) => h.code).join(', ')}`,
      priorityFactors: classification.priorityFactors,
      urgentEligible: classification.urgentEligible,
      uncertainty:
        classification.unknown !== null
          ? `Missing expected evidence: ${classification.unknown.missingExpected.join(', ') || 'none listed'}`
          : evidenceEntries.some((e) => e.missingExpected.length > 0)
            ? 'Some expected evidence could not be read; each hypothesis lists what was missing.'
            : 'All expected evidence was readable.',
    },
    evidence: {
      entries: evidenceEntries,
      notApplicable: classification.notApplicable.map((n) => ({
        code: n.code,
        missingFacts: n.missingFacts,
      })),
      unknown: classification.unknown,
    },
    timeline,
    observations: {
      lastValidAt: lastValid === undefined ? null : new Date(timeOf(lastValid)).toISOString(),
      nextValidAt: nextValid === undefined ? null : new Date(timeOf(nextValid)).toISOString(),
      note:
        version.endAt === null
          ? 'The episode is open: there is no next valid observation yet.'
          : 'Valid means the fix passed quality checks; an invalid fix cannot bound the gap.',
    },
    corridor: corridorSectionFor({
      episode,
      events: record.events,
      corridorId: record.corridorId,
    }),
    peers: {
      clusters,
      fleetSize,
      note:
        clusters.length === 0
          ? `No peer cluster includes this device (fleet of ${fleetSize} observed devices).`
          : `Denominators: activePopulation is the devices known active on the dimension; the fleet here is ${fleetSize}.`,
    },
    policies: {
      record: CORPUS_POLICY,
      suppressionWindows: [],
    },
    decisions: {
      prior: episode.actions.map((a) => ({ kind: a.kind, at: a.at, reference: a.reference })),
      available: [...(ALLOWED_TRANSITIONS[version.state] ?? [])],
    },
  }
}

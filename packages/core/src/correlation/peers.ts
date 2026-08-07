// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Peer correlation and source health.
 *
 * This is the module that turns "this device is silent" into "eleven independent assets on one
 * platform went silent together" — and, just as importantly, refuses to say that when the eleven
 * are two motorcycles carrying five trackers and a duplicated feed.
 *
 * The requirements it implements, and where each lives:
 *
 *   * FR-COR-001 — correlate by source, SIM provider, radio identity, time and coarse H3 area.
 *     Tenant is not a dimension: it is a wall (FR-COR-005), enforced by refusing mixed input.
 *   * FR-COR-002 — the minimum independent count lives in the RULE PACKAGE (`gte 3`,
 *     policy-controlled), not here. This module reports the true count; hiding sub-minimum
 *     clusters would also hide the data-quality signal they carry.
 *   * FR-COR-003 — independence is counted over ASSETS, not devices. Primary and secondary
 *     trackers on one motorcycle are one witness; the same device arriving through two data paths
 *     is one witness. Exclusions are returned by name, because a count whose exclusions are
 *     invisible is a count nobody can audit.
 *   * FR-COR-004 — every cluster carries its denominator. Twelve silent devices means one thing on
 *     a fleet of fifteen and another on a fleet of four thousand, and a cluster shown without its
 *     population invites exactly that confusion.
 */

export interface CorrelationCandidate {
  readonly tenantId: string
  readonly deviceRef: string
  /** Null when no effective assignment resolves — the device then counts as its own witness. */
  readonly assetRef: string | null
  readonly source: string
  readonly simProvider: string | null
  /** e.g. "639-02" (mcc-mnc). Null when the serving identity was never observed. */
  readonly networkIdentity: string | null
  /** Coarse cell at H3 resolution 6, matching the bundle's coarsening floor. */
  readonly h3Cell: string | null
  readonly episodeStartAt: string
}

export type ClusterDimension = 'source' | 'sim_provider' | 'network' | 'area'

export interface ExcludedMember {
  readonly deviceRef: string
  readonly reason: 'shares_asset' | 'duplicate_device'
  /** The witness this member collapsed into, so the exclusion is auditable. */
  readonly countedAs: string
}

export interface PeerCluster {
  readonly dimension: ClusterDimension
  readonly key: string
  readonly windowStart: string
  readonly windowEnd: string
  /** Every silent device seen, before exclusions. */
  readonly memberDevices: readonly string[]
  /** Independent witnesses after FR-COR-003's exclusions. */
  readonly independentCount: number
  readonly excluded: readonly ExcludedMember[]
  /** Active devices for this dimension key, when the caller knows it. Never fabricated. */
  readonly activePopulation: number | null
  readonly affectedFraction: number | null
  readonly meetsMinimum: boolean
}

export interface CorrelationOptions {
  /** FR-COR-002's default. The rule package applies its own policy-controlled floor as well. */
  readonly minimumIndependentDevices?: number
  /** Episodes whose starts fall within this window of a cluster's first start correlate. */
  readonly windowS?: number
  /** Denominators keyed as `${dimension}:${key}` — e.g. `source:traccar_forwarder`. */
  readonly activePopulation?: Readonly<Record<string, number>>
}

export class CrossTenantCorrelationError extends Error {
  constructor(readonly tenants: readonly string[]) {
    super(
      `refusing to correlate across tenants [${tenants.join(', ')}]: FR-COR-005 keeps cross-tenant ` +
        'correlation disabled by default, and the strongest form of disabled is a function that ' +
        'cannot be handed mixed input at all.',
    )
    this.name = 'CrossTenantCorrelationError'
  }
}

const DEFAULT_MINIMUM = 3
const DEFAULT_WINDOW_S = 1800

interface DimensionKey {
  readonly dimension: ClusterDimension
  keyOf(candidate: CorrelationCandidate): string | null
}

const DIMENSIONS: readonly DimensionKey[] = [
  { dimension: 'source', keyOf: (c) => c.source },
  { dimension: 'sim_provider', keyOf: (c) => c.simProvider },
  { dimension: 'network', keyOf: (c) => c.networkIdentity },
  { dimension: 'area', keyOf: (c) => c.h3Cell },
]

/**
 * Collapse members to independent witnesses.
 *
 * Dedupe by device first (a duplicated data path is one device seen twice), then group by asset
 * (two trackers on one motorcycle are one witness). A device with no resolved assignment counts as
 * its own witness — unmapped is not the same as co-mounted, and merging the unmapped would
 * undercount real incidents on fleets with poor assignment coverage.
 */
function independence(members: readonly CorrelationCandidate[]): {
  independentCount: number
  excluded: ExcludedMember[]
} {
  const excluded: ExcludedMember[] = []
  const byDevice = new Map<string, CorrelationCandidate>()

  for (const member of [...members].sort((a, b) => a.deviceRef.localeCompare(b.deviceRef))) {
    if (byDevice.has(member.deviceRef)) {
      excluded.push({
        deviceRef: member.deviceRef,
        reason: 'duplicate_device',
        countedAs: member.deviceRef,
      })
    } else {
      byDevice.set(member.deviceRef, member)
    }
  }

  const byWitness = new Map<string, string>()
  for (const candidate of byDevice.values()) {
    const witness = candidate.assetRef ?? candidate.deviceRef
    const existing = byWitness.get(witness)
    if (existing === undefined) {
      byWitness.set(witness, candidate.deviceRef)
    } else {
      excluded.push({
        deviceRef: candidate.deviceRef,
        reason: 'shares_asset',
        countedAs: existing,
      })
    }
  }

  return { independentCount: byWitness.size, excluded }
}

/**
 * Correlate one tenant's episode candidates into peer clusters.
 *
 * Time clustering is a deterministic greedy chain over start-sorted members: an episode joins the
 * open cluster when its start is within the window of the cluster's FIRST start, else opens a new
 * one. Anchoring on the first start rather than the previous member stops a slow drip of episodes
 * chaining into one endless "incident" — a cluster is a burst, not a season.
 */
export function correlate(
  candidates: readonly CorrelationCandidate[],
  options: CorrelationOptions = {},
): PeerCluster[] {
  const tenants = [...new Set(candidates.map((c) => c.tenantId))].sort()
  if (tenants.length > 1) throw new CrossTenantCorrelationError(tenants)

  const minimum = options.minimumIndependentDevices ?? DEFAULT_MINIMUM
  const windowS = options.windowS ?? DEFAULT_WINDOW_S
  const clusters: PeerCluster[] = []

  for (const { dimension, keyOf } of DIMENSIONS) {
    const byKey = new Map<string, CorrelationCandidate[]>()
    for (const candidate of candidates) {
      const key = keyOf(candidate)
      if (key === null) continue
      byKey.set(key, [...(byKey.get(key) ?? []), candidate])
    }

    for (const [key, members] of [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const ordered = [...members].sort(
        (a, b) =>
          Date.parse(a.episodeStartAt) - Date.parse(b.episodeStartAt) ||
          a.deviceRef.localeCompare(b.deviceRef),
      )

      let window: CorrelationCandidate[] = []
      const flush = (): void => {
        if (window.length === 0) return
        const { independentCount, excluded } = independence(window)
        const population = options.activePopulation?.[`${dimension}:${key}`] ?? null
        clusters.push({
          dimension,
          key,
          windowStart: window[0]!.episodeStartAt,
          windowEnd: window[window.length - 1]!.episodeStartAt,
          memberDevices: [...new Set(window.map((m) => m.deviceRef))].sort(),
          independentCount,
          excluded,
          activePopulation: population,
          affectedFraction:
            population === null || population === 0 ? null : independentCount / population,
          meetsMinimum: independentCount >= minimum,
        })
        window = []
      }

      for (const candidate of ordered) {
        if (
          window.length > 0 &&
          Date.parse(candidate.episodeStartAt) - Date.parse(window[0]!.episodeStartAt) >
            windowS * 1000
        ) {
          flush()
        }
        window.push(candidate)
      }
      flush()
    }
  }

  return clusters
}

/** The `peers` input `deriveFacts` expects — the bridge from correlation into classification. */
export interface PeerFacts {
  readonly sourceIndependentDevices: number
  readonly networkIndependentDevices: number | null
  readonly networkIdentityKnown: boolean
  readonly sourceHealthIncident: boolean
}

/**
 * Derive one device's peer facts from the clusters it belongs to.
 *
 * The counts are the TRUE independent counts, including sub-minimum ones: FR-COR-002's floor
 * belongs to the rule package, where it is policy-controlled and versioned. A device in a
 * two-device cluster reports 2, and the rule declines to fire — the floor is enforced exactly
 * once, in the artefact an approver signs.
 */
export function peerFactsFor(
  candidate: CorrelationCandidate,
  clusters: readonly PeerCluster[],
): PeerFacts {
  const containing = (dimension: ClusterDimension): PeerCluster | undefined =>
    clusters.find(
      (cluster) =>
        cluster.dimension === dimension &&
        cluster.memberDevices.includes(candidate.deviceRef) &&
        Date.parse(candidate.episodeStartAt) >= Date.parse(cluster.windowStart) &&
        Date.parse(candidate.episodeStartAt) <= Date.parse(cluster.windowEnd),
    )

  const sourceCluster = containing('source')
  const networkCluster = containing('network')

  return {
    sourceIndependentDevices: sourceCluster?.independentCount ?? 0,
    networkIndependentDevices:
      candidate.networkIdentity === null ? null : (networkCluster?.independentCount ?? 0),
    networkIdentityKnown: candidate.networkIdentity !== null,
    sourceHealthIncident:
      sourceCluster !== undefined && sourceCluster.meetsMinimum,
  }
}

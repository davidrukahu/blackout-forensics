// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Data-quality analysers — the bulk of what a customer pays for in a Telemetry Control Audit.
 *
 * FR-TEL-006 completeness by device model, source and day, with denominators.
 * FR-TEL-004 clock skew and delivery lag where sufficient times exist.
 * FR-POL-002 lag distributions, separating device silence from platform receipt delay.
 * FR-TEL-005 impossible values flagged without deleting the receipt.
 *
 * Plus two checks the platform research added, which are cheap to run and usually news to the
 * customer: platform-side filters that destroy records at write time, and the raw-retention window
 * that actually bounds how far back an audit can see.
 */

import {
  addExclusion,
  emptyDenominated,
  percentiles,
  type Denominated,
  type Percentiles,
} from './distribution.js'

export interface ObservedEvent {
  readonly source: string
  readonly device_ref: string
  readonly received_at: string
  readonly vendor_received_at?: string | null
  readonly device_time?: string | null
  readonly device?: { vendor?: string | null; model?: string | null; sleep_state?: string | null }
  readonly position?: { lat?: number; lon?: number; valid?: boolean; accuracy_m?: number | null } | null
  readonly motion?: Record<string, unknown> | null
  readonly power?: Record<string, unknown> | null
  readonly network?: Record<string, unknown> | null
  readonly event_identity?: { basis?: string; value?: string }
  readonly quality?: { parse_warnings?: string[] }
}

/** Cohort key for every grouped measure: model, source and UTC day. */
export interface Cohort {
  readonly model: string
  readonly source: string
  readonly day: string
}

export function cohortOf(event: ObservedEvent): Cohort {
  return {
    model: event.device?.model ?? 'unknown',
    source: event.source,
    day: event.received_at.slice(0, 10),
  }
}

export const cohortKey = (c: Cohort): string => `${c.model}|${c.source}|${c.day}`

/** Field groups reported separately, because a device supporting one rarely supports all. */
export const FIELD_GROUPS = {
  position: (e: ObservedEvent) => e.position != null && e.position.lat != null,
  motion: (e: ObservedEvent) => e.motion != null && Object.keys(e.motion).length > 0,
  power: (e: ObservedEvent) => e.power != null && Object.keys(e.power).length > 0,
  network: (e: ObservedEvent) => e.network != null && Object.keys(e.network).length > 0,
  device_time: (e: ObservedEvent) => e.device_time != null,
  vendor_time: (e: ObservedEvent) => e.vendor_received_at != null,
} as const

export type FieldGroup = keyof typeof FIELD_GROUPS

export interface CompletenessReport {
  readonly cohort: Cohort
  readonly groups: Readonly<Record<FieldGroup, Denominated>>
}

/**
 * Field completeness per cohort.
 *
 * A sleeping device is *excluded*, not counted as incomplete. Deep Sleep strips IO elements by
 * design, so counting those rows as missing data would blame the customer's fleet for behaving
 * exactly as documented — and would bury the genuine gaps in noise.
 */
export function analyseCompleteness(events: readonly ObservedEvent[]): CompletenessReport[] {
  const byCohort = new Map<string, { cohort: Cohort; events: ObservedEvent[] }>()

  for (const event of events) {
    const cohort = cohortOf(event)
    const key = cohortKey(cohort)
    const bucket = byCohort.get(key) ?? { cohort, events: [] }
    bucket.events.push(event)
    byCohort.set(key, bucket)
  }

  return [...byCohort.values()].map(({ cohort, events: bucket }) => {
    const groups = {} as Record<FieldGroup, Denominated>

    for (const group of Object.keys(FIELD_GROUPS) as FieldGroup[]) {
      let d: Denominated = emptyDenominated()
      for (const event of bucket) {
        const asleep = event.device?.sleep_state === 'deep_sleep' || event.device?.sleep_state === 'light_sleep'
        if (asleep && group !== 'device_time') {
          d = addExclusion(d, 'device_asleep')
          continue
        }
        d = {
          ...d,
          denominator: d.denominator + 1,
          numerator: d.numerator + (FIELD_GROUPS[group](event) ? 1 : 0),
        }
      }
      groups[group] = d
    }

    return { cohort, groups }
  })
}

export interface TimingReport {
  /** received_at − vendor_received_at: how long the platform held it. */
  readonly platformLagS: Percentiles
  /** received_at − device_time: total observed delay, device to us. */
  readonly totalLagS: Percentiles
  /** vendor_received_at − device_time: the device-to-platform leg. */
  readonly deviceToVendorLagS: Percentiles
  /** Events whose device clock runs ahead of receipt — impossible without skew. */
  readonly negativeLagCount: number
  readonly clockSkewSuspectDevices: readonly string[]
  /** Events lacking the times needed to compute lag at all. */
  readonly insufficientTimes: number
}

const secondsBetween = (later: string, earlier: string): number =>
  (Date.parse(later) - Date.parse(earlier)) / 1000

/**
 * Separate device silence from platform receipt delay.
 *
 * This distinction is the whole point: an offline alert caused by a slow platform is a vendor SLA
 * matter, and one caused by a silent device is a recovery matter. A single last_seen timestamp
 * cannot tell them apart, which is why three times are carried and never overwritten.
 */
export function analyseTiming(events: readonly ObservedEvent[]): TimingReport {
  const platformLag: number[] = []
  const totalLag: number[] = []
  const deviceToVendor: number[] = []
  const skewSuspects = new Set<string>()
  let negativeLag = 0
  let insufficient = 0

  for (const event of events) {
    if (event.vendor_received_at != null) {
      platformLag.push(secondsBetween(event.received_at, event.vendor_received_at))
    }
    if (event.device_time != null) {
      const total = secondsBetween(event.received_at, event.device_time)
      totalLag.push(total)
      // A device clock ahead of our receipt time cannot happen without skew — physics, not policy.
      if (total < 0) {
        negativeLag += 1
        skewSuspects.add(event.device_ref)
      }
      if (event.vendor_received_at != null) {
        deviceToVendor.push(secondsBetween(event.vendor_received_at, event.device_time))
      }
    }
    if (event.device_time == null && event.vendor_received_at == null) insufficient += 1
  }

  return {
    platformLagS: percentiles(platformLag),
    totalLagS: percentiles(totalLag),
    deviceToVendorLagS: percentiles(deviceToVendor),
    negativeLagCount: negativeLag,
    clockSkewSuspectDevices: [...skewSuspects].sort(),
    insufficientTimes: insufficient,
  }
}

export interface IntegrityReport {
  readonly total: number
  readonly duplicateIdentities: number
  readonly outOfOrderByDeviceTime: number
  /** Records whose receipt lags device time by more than the threshold — buffered backfill. */
  readonly backfilled: number
  readonly backfillThresholdS: number
  readonly impossibleValues: Readonly<Record<string, number>>
}

/**
 * Duplicates, ordering, backfill and impossible values.
 *
 * Impossible values are counted, never corrected. FR-TEL-005 requires them flagged without deleting
 * the receipt: a voltage of 6553.5 V is a vendor sentinel, and silently normalising it to null
 * destroys the evidence that the device is misreporting.
 */
export function analyseIntegrity(
  events: readonly ObservedEvent[],
  backfillThresholdS = 900,
): IntegrityReport {
  const seen = new Set<string>()
  let duplicates = 0
  let outOfOrder = 0
  let backfilled = 0
  const impossible: Record<string, number> = {}

  const bump = (key: string): void => {
    impossible[key] = (impossible[key] ?? 0) + 1
  }

  const lastDeviceTime = new Map<string, number>()

  for (const event of events) {
    const identity = `${event.source}|${event.event_identity?.basis ?? '?'}|${event.event_identity?.value ?? '?'}`
    if (seen.has(identity)) duplicates += 1
    else seen.add(identity)

    if (event.device_time != null) {
      const t = Date.parse(event.device_time)
      const previous = lastDeviceTime.get(event.device_ref)
      if (previous !== undefined && t < previous) outOfOrder += 1
      lastDeviceTime.set(event.device_ref, Math.max(previous ?? t, t))

      if (secondsBetween(event.received_at, event.device_time) > backfillThresholdS) backfilled += 1
    }

    const lat = event.position?.lat
    const lon = event.position?.lon
    if (lat != null && (lat < -90 || lat > 90)) bump('position.lat_out_of_range')
    if (lon != null && (lon < -180 || lon > 180)) bump('position.lon_out_of_range')
    // 0,0 is in the Gulf of Guinea. For a Kenyan fleet it is a null island sentinel, not a fix.
    if (lat === 0 && lon === 0) bump('position.null_island')
    const speed = (event.motion as { speed_kph?: number } | null | undefined)?.speed_kph
    if (speed != null && (speed < 0 || speed > 400)) bump('motion.speed_implausible')
    const volts = (event.power as { external_v?: number } | null | undefined)?.external_v
    if (volts != null && (volts < 0 || volts > 100)) bump('power.external_v_sentinel')
  }

  return {
    total: events.length,
    duplicateIdentities: duplicates,
    outOfOrderByDeviceTime: outOfOrder,
    backfilled,
    backfillThresholdS,
    impossibleValues: impossible,
  }
}

export interface DestructiveSetting {
  readonly source: string
  readonly setting: string
  readonly effect: string
  readonly enabled: boolean
  readonly defaultEnabled: boolean
}

export interface RetentionFinding {
  readonly source: string
  readonly rawDays: number | null
  readonly customerReducible: boolean
  /** Days of history the audit actually asked for. */
  readonly requestedDays: number
  readonly sufficient: boolean | null
}

/**
 * Findings drawn from platform configuration rather than from the telemetry.
 *
 * These cost minutes to collect and are usually news: records destroyed at write time cannot be
 * recovered by any export, and a retention window shorter than the audit period silently truncates
 * every measure computed over it.
 */
export function analysePlatformConfiguration(params: {
  destructive: readonly DestructiveSetting[]
  retention: readonly Omit<RetentionFinding, 'sufficient'>[]
}): {
  activeDestructiveSettings: readonly DestructiveSetting[]
  retention: readonly RetentionFinding[]
  blockingFindings: readonly string[]
} {
  const active = params.destructive.filter((d) => d.enabled)
  const retention = params.retention.map((r) => ({
    ...r,
    sufficient: r.rawDays === null ? null : r.rawDays >= r.requestedDays,
  }))

  const blocking: string[] = []
  for (const d of active) {
    blocking.push(`${d.source}: ${d.setting} is destroying records before they can be exported`)
  }
  for (const r of retention) {
    if (r.sufficient === false) {
      blocking.push(
        `${r.source}: raw retention is ${String(r.rawDays)} days but the audit requests ${r.requestedDays}`,
      )
    }
    if (r.rawDays === null) {
      blocking.push(`${r.source}: raw retention window is undocumented and must be established`)
    }
  }

  return { activeDestructiveSettings: active, retention, blockingFindings: blocking }
}

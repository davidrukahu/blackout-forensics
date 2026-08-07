// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reference scenarios: PRD §15.2's mandatory edge cases, plus three the platform research made
 * mandatory.
 *
 * Each scenario damages a clean baseline in one documented way and records the ground truth of what
 * it did. Labels live in a sidecar, never inside the events, so a label can never leak into the data
 * under test.
 *
 * Two of PRD §15.2's cases — deleted source data required by an old report, and the maker-checker
 * race with a stale UI — are workflow and storage concerns rather than telemetry shapes. They belong
 * to the workflow test suite and are deliberately absent here.
 */

import { createRng } from './prng.js'
import {
  DEFAULT_POLICY,
  QUECLINK_GV75,
  generateBaseline,
  type CanonicalEvent,
} from './generate.js'

/** What actually happened, as opposed to what a detector might infer. */
export interface GroundTruth {
  readonly scenario: string
  /** The cause a perfect classifier would land on, or 'none' where no episode should open. */
  readonly trueCause:
    | 'none'
    | 'expected_sleep'
    | 'gnss_only_loss'
    | 'vendor_ingestion_delay'
    | 'power_disconnect'
    | 'device_fault'
    | 'network_incident'
    | 'unknown'
  /** True where a correct system opens at least one blackout episode. */
  readonly opensEpisode: boolean
  /** Device-time bounds of the real gap, where one exists. */
  readonly gap?: { readonly startAt: string; readonly endAt: string }
  /** What a naive detector gets wrong here, and why it matters. */
  readonly trap: string
}

export interface ScenarioResult {
  readonly events: CanonicalEvent[]
  readonly truth: GroundTruth
}

export interface ScenarioContext {
  readonly seed: number
  readonly startAt: string
}

export type Scenario = (ctx: ScenarioContext) => ScenarioResult

const baselineFor = (ctx: ScenarioContext, overrides = {}): ReturnType<typeof generateBaseline> =>
  generateBaseline({ seed: ctx.seed, startAt: ctx.startAt, pointCount: 40, ...overrides })

const deviceTimeOf = (e: CanonicalEvent): string => e.device_time ?? e.received_at

// ---------------------------------------------------------------- PRD §15.2

const duplicatesAndOutOfOrder: Scenario = (ctx) => {
  const { events } = baselineFor(ctx)
  const rng = createRng(ctx.seed + 1)
  const withDuplicates = [...events]
  for (const index of [5, 12, 23]) {
    const original = events[index]
    if (original !== undefined) withDuplicates.push(structuredClone(original))
  }
  // Shuffle a window, as a platform that does not preserve order would deliver.
  const head = withDuplicates.slice(0, 10)
  const middle = rng.shuffle(withDuplicates.slice(10, 25))
  const tail = withDuplicates.slice(25)
  return {
    events: [...head, ...middle, ...tail],
    truth: {
      scenario: 'duplicates-and-out-of-order',
      trueCause: 'none',
      opensEpisode: false,
      trap:
        'Three records are byte-identical duplicates and a window arrives out of order. A detector ' +
        'keyed on arrival order will see phantom gaps; one that deduplicates on payload equality ' +
        'alone will also collapse legitimate repeated readings.',
    },
  }
}

const veryLateBackfill: Scenario = (ctx) => {
  const { events } = baselineFor(ctx)
  const buffered = events.slice(15, 25)
  const rest = [...events.slice(0, 15), ...events.slice(25)]
  // Buffered records arrive four hours after the fact, once the device reconnects.
  const delivered = buffered.map((e) => ({
    ...structuredClone(e),
    received_at: new Date(new Date(e.received_at).getTime() + 4 * 3600 * 1000).toISOString(),
    quality: { ...e.quality, parse_warnings: ['buffered record delivered after reconnection'] },
  }))
  return {
    events: [...rest, ...delivered],
    truth: {
      scenario: 'very-late-backfill',
      trueCause: 'none',
      opensEpisode: true,
      gap: { startAt: deviceTimeOf(events[15] as CanonicalEvent), endAt: deviceTimeOf(events[24] as CanonicalEvent) },
      trap:
        'An episode legitimately opens on receipt time and must then be RETRACTED when the buffered ' +
        'records arrive. A system that cannot retract will have dispatched against a gap that never ' +
        'existed.',
    },
  }
}

const driftingDeviceClock: Scenario = (ctx) => {
  const { events } = baselineFor(ctx)
  const skewed = events.map((e, i) => {
    if (i < 20) return e
    // Clock jumps 47 minutes backwards mid-stream and stays there.
    const shifted = new Date(new Date(deviceTimeOf(e)).getTime() - 47 * 60 * 1000).toISOString()
    return {
      ...structuredClone(e),
      device_time: shifted,
      quality: { ...e.quality, clock_skew_s: 2820 },
    }
  })
  return {
    events: skewed,
    truth: {
      scenario: 'drifting-device-clock',
      trueCause: 'none',
      opensEpisode: false,
      trap:
        'Device time jumps backwards by 47 minutes. Ordering or gap detection on device time will ' +
        'invent a gap and then a burst. Receipt time stays monotonic throughout, which is why it is ' +
        'the SLA clock until device clocks pass quality checks (FR-POL-003).',
    },
  }
}

const rebootAndSequenceReset: Scenario = (ctx) => {
  const { events } = baselineFor(ctx, { device: QUECLINK_GV75 })
  const out = events.map((e, i) => {
    if (i < 18) return e
    // Sequence restarts from zero after a reboot; the 18th record announces the reason.
    const value = String(i - 18)
    return {
      ...structuredClone(e),
      event_identity: { basis: 'vendor_sequence' as const, value },
      device: { ...(e.device ?? {}), reboot_reason: i === 18 ? 'power_on_reset' : null },
    }
  })
  return {
    events: out,
    truth: {
      scenario: 'reboot-and-sequence-reset',
      trueCause: 'device_fault',
      opensEpisode: false,
      trap:
        'Sequence numbers restart at zero. Gap detection on sequence continuity sees a catastrophic ' +
        'rollback; deduplication keyed on sequence alone will discard every post-reboot record as ' +
        'already seen.',
    },
  }
}

const deviceSwapMidEpisode: Scenario = (ctx) => {
  const { events, deviceRef } = baselineFor(ctx)
  const replacement = `${deviceRef.slice(0, 4)}ffff9999`.slice(0, 12)
  const gapStart = 20
  const out = [
    ...events.slice(0, gapStart),
    ...events.slice(gapStart + 8).map((e) => ({
      ...structuredClone(e),
      device_ref: replacement,
      device: { ...(e.device ?? {}), firmware: '03.28.01' },
    })),
  ]
  return {
    events: out,
    truth: {
      scenario: 'device-swap-mid-episode',
      trueCause: 'device_fault',
      opensEpisode: true,
      gap: { startAt: deviceTimeOf(events[gapStart] as CanonicalEvent), endAt: deviceTimeOf(events[gapStart + 8] as CanonicalEvent) },
      trap:
        'The tracker is replaced during the gap. Resolution must use the effective-dated assignment ' +
        'at event time (FR-AST-002): events before and after belong to the same asset but different ' +
        'devices, and treating them as one device hides the replacement.',
    },
  }
}

const maintenanceWindowOverlap: Scenario = (ctx) => {
  const { events } = baselineFor(ctx)
  const out = [...events.slice(0, 14), ...events.slice(24)]
  return {
    events: out,
    truth: {
      scenario: 'maintenance-window-overlap',
      trueCause: 'none',
      opensEpisode: false,
      gap: { startAt: deviceTimeOf(events[14] as CanonicalEvent), endAt: deviceTimeOf(events[23] as CanonicalEvent) },
      trap:
        'The gap falls entirely inside an approved maintenance window, so no actionable case should ' +
        'open — but the suppression must remain auditable and the window must appear in excluded ' +
        'denominators (FR-POL-004). Silently dropping it corrupts the SLA numerator.',
    },
  }
}

const vendorOutageWithIndividualPowerCut: Scenario = (ctx) => {
  const { events } = baselineFor(ctx)
  const cutAt = 22
  const out = [
    ...events.slice(0, cutAt),
    {
      ...structuredClone(events[cutAt] as CanonicalEvent),
      power: { external_state: 'absent', internal_pct: 64 },
      alerts: [{ code: 'power_cut', source_code: 'IO_252' }],
    },
  ]
  return {
    events: out,
    truth: {
      scenario: 'vendor-outage-with-individual-power-cut',
      trueCause: 'power_disconnect',
      opensEpisode: true,
      gap: { startAt: deviceTimeOf(events[cutAt] as CanonicalEvent), endAt: deviceTimeOf(events[events.length - 1] as CanonicalEvent) },
      trap:
        'A platform-wide outage is happening at the same moment, so peer correlation will want to ' +
        'explain this away as vendor ingestion failure. The direct power-cut alert must survive that ' +
        'suppression — this is the case where a correlated incident masks a real one (§17.2).',
    },
  }
}

const gnssLossCellularContinues: Scenario = (ctx) => {
  const { events } = baselineFor(ctx)
  const out = events.map((e, i) => {
    if (i < 16 || i > 30) return e
    return {
      ...structuredClone(e),
      position: { lat: (e.position as { lat: number }).lat, lon: (e.position as { lon: number }).lon, fix_type: 'gps', valid: false },
      motion: { ...(e.motion ?? {}), speed_kph: null, motion_state: 'unknown' },
    }
  })
  return {
    events: out,
    truth: {
      scenario: 'gnss-loss-cellular-continues',
      trueCause: 'gnss_only_loss',
      opensEpisode: true,
      gap: { startAt: deviceTimeOf(events[16] as CanonicalEvent), endAt: deviceTimeOf(events[30] as CanonicalEvent) },
      trap:
        'Reports keep arriving on schedule, so a timeout detector sees nothing wrong. Position quality ' +
        'has failed but cellular is healthy — this is GNSS-only loss, not silence, and calling it a ' +
        'cellular outage is a prohibited conclusion (§8.1 H-GNSS).',
    },
  }
}

const transientHeartbeatMidBlackout: Scenario = (ctx) => {
  const { events } = baselineFor(ctx)
  const out = [...events.slice(0, 12), events[21] as CanonicalEvent, ...events.slice(34)]
  return {
    events: out,
    truth: {
      scenario: 'transient-heartbeat-mid-blackout',
      trueCause: 'unknown',
      opensEpisode: true,
      gap: { startAt: deviceTimeOf(events[12] as CanonicalEvent), endAt: deviceTimeOf(events[34] as CanonicalEvent) },
      trap:
        'A single heartbeat lands in the middle of an otherwise continuing blackout. A detector that ' +
        'closes on one valid report will close the case and reopen it, producing two short episodes ' +
        'instead of one long one — which is why closure requires configurable confirmation reports ' +
        '(FR-EPI-003).',
    },
  }
}

const duplicatedDataPath: Scenario = (ctx) => {
  const { events } = baselineFor(ctx)
  // The same physical device forwarded through two sources — not two independent devices.
  const mirrored = events.map((e) => ({
    ...structuredClone(e),
    source: 'wialon_retranslator',
    received_at: new Date(new Date(e.received_at).getTime() + 4000).toISOString(),
  }))
  return {
    events: [...events, ...mirrored],
    truth: {
      scenario: 'duplicated-data-path',
      trueCause: 'none',
      opensEpisode: false,
      trap:
        'One device arrives via two sources. Peer correlation must exclude duplicated data paths from ' +
        'independence counts (FR-COR-003) — counting these as two independent devices manufactures a ' +
        'provider-incident cluster from a single asset.',
    },
  }
}

const ambiguousCorridor: Scenario = (ctx) => {
  const { events } = baselineFor(ctx, { corridorId: 'thika-road' })
  const out = [...events.slice(0, 10), ...events.slice(28)]
  return {
    events: out,
    truth: {
      scenario: 'ambiguous-corridor',
      trueCause: 'unknown',
      opensEpisode: true,
      gap: { startAt: deviceTimeOf(events[10] as CanonicalEvent), endAt: deviceTimeOf(events[28] as CanonicalEvent) },
      trap:
        'The gap spans a junction where two routes fit the elapsed time equally well. Corridor ' +
        'projection must return corridor_ambiguous and no line (FR-GEO-004). A drawn path here is a ' +
        'confident-looking fabrication.',
    },
  }
}

// ------------------------------------------------- forced by the platform research

const teltonikaDeepSleep: Scenario = (ctx) => {
  const { events } = baselineFor(ctx)
  const sleepFrom = 18
  const out = events.map((e, i) => {
    if (i < sleepFrom) return e
    if ((i - sleepFrom) % 12 !== 0) return null
    // Deep Sleep: stale coordinates, IO elements stripped, BOTH jamming detectors disabled.
    return {
      ...structuredClone(e),
      position: { ...(events[sleepFrom - 1]?.position as object), valid: false },
      motion: { ignition: 'off', motion_state: 'stationary' },
      power: { external_state: 'present' },
      network: null,
      device: { vendor: 'teltonika', model: 'FMB920', sleep_state: 'deep_sleep' },
      alerts: [],
      quality: { ...e.quality, parse_warnings: ['io elements absent in deep sleep'] },
    }
  })
  return {
    events: out.filter((e): e is CanonicalEvent => e !== null),
    truth: {
      scenario: 'teltonika-deep-sleep',
      trueCause: 'expected_sleep',
      opensEpisode: false,
      trap:
        'Deep Sleep strips 13 IO elements, emits stale coordinates and disables BOTH jamming ' +
        'detectors. The absence of a jamming flag here is not weak evidence against jamming — it is ' +
        'no evidence, and the capability manifest must make jamming rules inapplicable rather than ' +
        'let them evaluate to false (FR-CLS-006).',
    },
  }
}

const byteIdenticalResends: Scenario = (ctx) => {
  const { events } = baselineFor(ctx)
  const out: CanonicalEvent[] = []
  events.forEach((e, i) => {
    out.push(e)
    // Teltonika resends byte-identical records after an unacknowledged batch.
    if (i % 9 === 0) out.push(structuredClone(e))
  })
  return {
    events: out,
    truth: {
      scenario: 'byte-identical-resends',
      trueCause: 'none',
      opensEpisode: false,
      trap:
        'Teltonika Codec 8/8E carries no record identifier and documents byte-identical resends. ' +
        'Identity must be synthesised and declared as such; deduplication cannot distinguish a resend ' +
        'from a genuine repeated reading without knowing the identity basis.',
    },
  }
}

const writeTimeDestruction: Scenario = (ctx) => {
  const { events } = baselineFor(ctx)
  // Traccar filter.past discarded these before storage. No export can recover them.
  const survived = events.filter((_, i) => !(i >= 24 && i <= 29))
  return {
    events: survived,
    truth: {
      scenario: 'write-time-destruction',
      trueCause: 'unknown',
      opensEpisode: true,
      gap: { startAt: deviceTimeOf(events[24] as CanonicalEvent), endAt: deviceTimeOf(events[29] as CanonicalEvent) },
      trap:
        'The records were destroyed at write time by a platform filter, not lost by the device. The ' +
        'gap is indistinguishable from device silence in the data alone — which is why the platform ' +
        'configuration check is part of the audit, and why this episode should resolve to unknown ' +
        'rather than to a device or network cause.',
    },
  }
}

export const SCENARIOS: Readonly<Record<string, Scenario>> = {
  'duplicates-and-out-of-order': duplicatesAndOutOfOrder,
  'very-late-backfill': veryLateBackfill,
  'drifting-device-clock': driftingDeviceClock,
  'reboot-and-sequence-reset': rebootAndSequenceReset,
  'device-swap-mid-episode': deviceSwapMidEpisode,
  'maintenance-window-overlap': maintenanceWindowOverlap,
  'vendor-outage-with-individual-power-cut': vendorOutageWithIndividualPowerCut,
  'gnss-loss-cellular-continues': gnssLossCellularContinues,
  'transient-heartbeat-mid-blackout': transientHeartbeatMidBlackout,
  'duplicated-data-path': duplicatedDataPath,
  'ambiguous-corridor': ambiguousCorridor,
  'teltonika-deep-sleep': teltonikaDeepSleep,
  'byte-identical-resends': byteIdenticalResends,
  'write-time-destruction': writeTimeDestruction,
}

export const SCENARIO_NAMES: readonly string[] = Object.keys(SCENARIOS)

export function runScenario(name: string, ctx: ScenarioContext): ScenarioResult {
  const scenario = SCENARIOS[name]
  if (scenario === undefined) throw new Error(`unknown scenario: ${name}`)
  return scenario(ctx)
}

/** Policy change mid-episode, kept separate because it alters the policy rather than the events. */
export const POLICY_CHANGE_MID_EPISODE = {
  before: DEFAULT_POLICY,
  after: { ...DEFAULT_POLICY, movingIntervalS: 300 },
  changeAtIndex: 20,
  trap:
    'The expected-report interval changes from 60s to 300s mid-stream. Replaying the earlier interval ' +
    'under the later policy invents four missing reports for every real one; FR-TEN-003 requires the ' +
    'policy effective at event time.',
} as const

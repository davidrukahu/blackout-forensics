// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Baseline telemetry generation.
 *
 * Produces a clean, policy-conformant event stream. Scenarios then damage it in specific,
 * documented ways and record the ground truth of what they did — so a detector can be measured
 * against what actually happened rather than against what it inferred.
 */

import { createRng, syntheticRef, type Rng } from './prng.js'
import { CORRIDORS, walkCorridor, type Corridor, type TrackPoint } from './geography.js'

/** Every synthetic tenant carries this prefix, asserted in CI. Synthetic data must never pass for real. */
export const SYNTHETIC_TENANT_PREFIX = 'synthetic_'

export type MotionState = 'moving' | 'stationary'

export interface ReportingPolicy {
  readonly movingIntervalS: number
  readonly stationaryIntervalS: number
  /** Interval once the device enters its documented sleep state. */
  readonly sleepIntervalS: number
  /** Stationary seconds before the device sleeps. */
  readonly sleepAfterStationaryS: number
}

export const DEFAULT_POLICY: ReportingPolicy = {
  movingIntervalS: 60,
  stationaryIntervalS: 300,
  sleepIntervalS: 3600,
  sleepAfterStationaryS: 900,
}

export interface DeviceProfile {
  readonly vendor: string
  readonly model: string
  readonly firmware: string
  /**
   * Whether the source supplies a usable per-record identity. Teltonika Codec 8/8E does not, so
   * adapters must synthesise one — and say so.
   */
  readonly suppliesEventId: boolean
  readonly suppliesSequence: boolean
  /** Fields the device never reports, regardless of state. */
  readonly unsupported: readonly string[]
}

export const TELTONIKA_FMB920: DeviceProfile = {
  vendor: 'teltonika',
  model: 'FMB920',
  firmware: '03.27.07',
  suppliesEventId: false,
  suppliesSequence: false,
  unsupported: ['device.sleep_state'],
}

export const QUECLINK_GV75: DeviceProfile = {
  vendor: 'queclink',
  model: 'GV75',
  firmware: 'R2.03',
  suppliesEventId: false,
  suppliesSequence: true,
  unsupported: [],
}

export interface CanonicalEvent {
  schema_version: string
  tenant_id: string
  source: string
  event_identity: { basis: 'vendor_event_id' | 'vendor_sequence' | 'synthesised'; value: string; algorithm?: string }
  asset_ref: string
  device_ref: string
  sim_ref?: string
  received_at: string
  vendor_received_at?: string | null
  device_time?: string | null
  position?: Record<string, unknown> | null
  motion?: Record<string, unknown> | null
  power?: Record<string, unknown> | null
  network?: Record<string, unknown> | null
  device?: Record<string, unknown>
  alerts?: { code: string; source_code: string }[]
  quality: { raw_sha256: string; adapter_version: string; clock_skew_s?: number | null; parse_warnings?: string[] }
  ext?: Record<string, Record<string, unknown>>
}

export interface BaselineOptions {
  readonly seed: number
  readonly tenantId?: string
  readonly source?: string
  readonly corridorId?: string
  readonly device?: DeviceProfile
  readonly policy?: ReportingPolicy
  /** Simulation start, ISO 8601. Passed in rather than read from the clock, for determinism. */
  readonly startAt: string
  readonly pointCount?: number
  /** Delivery lag applied to received_at, seconds. */
  readonly deliveryLagS?: number
}

export interface Baseline {
  readonly events: CanonicalEvent[]
  readonly assetRef: string
  readonly deviceRef: string
  readonly corridor: Corridor
  readonly policy: ReportingPolicy
  readonly device: DeviceProfile
}

/** Deterministic stand-in for a payload hash. Never a real hash of real data. */
function syntheticHash(rng: Rng): string {
  let hex = ''
  while (hex.length < 64) hex += Math.floor(rng.next() * 16).toString(16)
  return hex.slice(0, 64)
}

function isoAdd(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString()
}

export function generateBaseline(options: BaselineOptions): Baseline {
  const {
    seed,
    tenantId = `${SYNTHETIC_TENANT_PREFIX}demo`,
    source = 'traccar_forwarder',
    corridorId = 'thika-road',
    device = TELTONIKA_FMB920,
    policy = DEFAULT_POLICY,
    startAt,
    pointCount = 60,
    deliveryLagS = 3,
  } = options

  if (!tenantId.startsWith(SYNTHETIC_TENANT_PREFIX)) {
    throw new Error(`synthetic tenant ids must start with "${SYNTHETIC_TENANT_PREFIX}"`)
  }

  const corridor = CORRIDORS.find((c) => c.id === corridorId)
  if (corridor === undefined) throw new Error(`unknown corridor: ${corridorId}`)

  const rng = createRng(seed)
  const assetRef = syntheticRef('ast', seed, 1)
  const deviceRef = syntheticRef('dev', seed, 2)
  const simRef = syntheticRef('sim', seed, 3)

  const track: TrackPoint[] = walkCorridor(corridor, policy.movingIntervalS, pointCount, rng)
  const events: CanonicalEvent[] = []

  track.forEach((point, index) => {
    const deviceTime = isoAdd(startAt, index * policy.movingIntervalS)
    const lag = deliveryLagS + rng.float(0, 2)

    events.push({
      schema_version: '0.1.0',
      tenant_id: tenantId,
      source,
      event_identity: device.suppliesSequence
        ? { basis: 'vendor_sequence', value: String(10_000 + index) }
        : {
            basis: 'synthesised',
            value: `h:${syntheticHash(rng).slice(0, 12)}`,
            algorithm: 'sha256(device_ref|device_time|payload)',
          },
      asset_ref: assetRef,
      device_ref: deviceRef,
      sim_ref: simRef,
      received_at: isoAdd(deviceTime, lag),
      vendor_received_at: isoAdd(deviceTime, lag * 0.6),
      device_time: deviceTime,
      position: {
        lat: Math.round(point.lat * 1e6) / 1e6,
        lon: Math.round(point.lon * 1e6) / 1e6,
        accuracy_m: Math.round(rng.float(6, 24)),
        fix_type: 'gps',
        satellites: rng.int(7, 14),
        hdop: Math.round(rng.float(0.6, 1.8) * 10) / 10,
        valid: true,
      },
      motion: {
        speed_kph: point.speedKph,
        heading_deg: point.headingDeg,
        ignition: 'on',
        motion_state: 'moving',
        odometer_m: point.odometerM,
      },
      power: {
        external_state: 'present',
        external_v: Math.round(rng.float(12.9, 14.1) * 10) / 10,
        internal_pct: rng.int(72, 99),
      },
      network: {
        mcc: 639,
        mnc: rng.pick([2, 3, 7]),
        radio: rng.pick(['4G', '4G', '3G']),
        rssi_dbm: Math.round(rng.float(-105, -68)),
        registration: 'registered',
      },
      device: {
        vendor: device.vendor,
        model: device.model,
        firmware: device.firmware,
        ...(device.unsupported.includes('device.sleep_state') ? {} : { sleep_state: 'awake' }),
      },
      alerts: [],
      quality: {
        raw_sha256: syntheticHash(rng),
        adapter_version: `${device.vendor}-0.1.0`,
      },
    })
  })

  return { events, assetRef, deviceRef, corridor, policy, device }
}

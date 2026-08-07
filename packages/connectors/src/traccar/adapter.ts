// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: Apache-2.0

/**
 * Traccar forwarding adapter — the reference adapter.
 *
 * Traccar is Apache-2.0 with publicly documented forwarding, which is why it is the reference: the
 * adapter can be written, published and tested without a vendor agreement. That is not true of most
 * of this market, and the difference is the subject of an open licensing decision.
 *
 * Traccar's forward payload wraps a position, its device, and optionally an event. The mapping below
 * is deliberately conservative: where Traccar cannot tell us something, the field is absent rather
 * than defaulted, because a default here becomes a measurement three layers downstream.
 */

import { createHash } from 'node:crypto'

export const TRACCAR_ADAPTER_VERSION = '0.1.0'

/** The shape Traccar forwards. Only the fields this adapter reads are described. */
export interface TraccarForwardPayload {
  readonly position?: {
    readonly id?: number
    readonly deviceId?: number
    readonly protocol?: string
    readonly serverTime?: string
    readonly deviceTime?: string
    readonly fixTime?: string
    readonly valid?: boolean
    readonly latitude?: number
    readonly longitude?: number
    readonly altitude?: number
    readonly speed?: number
    readonly course?: number
    readonly accuracy?: number
    readonly attributes?: Record<string, unknown>
  }
  readonly device?: {
    readonly id?: number
    readonly uniqueId?: string
    readonly name?: string
    readonly model?: string | null
    readonly status?: string
  }
  readonly event?: {
    readonly type?: string
    readonly attributes?: Record<string, unknown>
  }
}

export interface TraccarAdapterOptions {
  readonly tenantId: string
  readonly source: string
  /** Receipt time, supplied by the ingestion boundary — never read from the clock here. */
  readonly receivedAt: string
  /**
   * Pseudonymous references. Traccar's uniqueId is usually an IMEI, so it must never reach a
   * canonical event: mapping happens outside this adapter, in a schema with narrower permissions.
   */
  readonly assetRef: string
  readonly deviceRef: string
  readonly simRef?: string
}

/** Knots to km/h. Traccar reports speed in knots, which is a classic silent-error source. */
const KNOTS_TO_KPH = 1.852

function tristate(value: unknown): 'on' | 'off' | 'unknown' | undefined {
  if (value === undefined) return undefined
  if (value === true) return 'on'
  if (value === false) return 'off'
  return 'unknown'
}

/**
 * Map Traccar's alarm strings to canonical alert codes.
 *
 * Anything unrecognised becomes `other` with the original preserved, rather than being dropped:
 * an alarm this adapter has not seen before is still evidence that something happened.
 */
function mapAlarm(alarm: string): { code: string; source_code: string } {
  const normalized: Record<string, string> = {
    powerCut: 'power_cut',
    powerOff: 'power_cut',
    powerRestored: 'other',
    tampering: 'tamper',
    removing: 'unplug',
    jamming: 'gnss_jamming',
    tow: 'towing',
  }
  return { code: normalized[alarm] ?? 'other', source_code: alarm }
}

/**
 * Convert one forwarded payload into a canonical event.
 *
 * Throws on a payload with no position: Traccar always forwards one, so its absence means the
 * payload is not what this adapter claims to read, and guessing would be worse than failing.
 */
export function decodeTraccar(
  payload: TraccarForwardPayload,
  options: TraccarAdapterOptions,
): Record<string, unknown> {
  const position = payload.position
  if (position === undefined) throw new Error('traccar payload carries no position')

  const attributes = position.attributes ?? {}

  const event: Record<string, unknown> = {
    schema_version: '0.1.0',
    tenant_id: options.tenantId,
    source: options.source,

    // Traccar's position id is stable per position and unique per server, so it is a genuine vendor
    // event id — unlike the device families that force synthesis.
    event_identity:
      position.id !== undefined
        ? { basis: 'vendor_event_id', value: String(position.id) }
        : {
            basis: 'synthesised',
            value: `h:${createHash('sha256')
              .update(`${options.tenantId}|${options.source}|${options.deviceRef}|${position.deviceTime ?? ''}|${JSON.stringify(position)}`)
              .digest('hex')
              .slice(0, 32)}`,
            algorithm: 'sha256(tenant|source|device_ref|device_time|position)',
          },

    asset_ref: options.assetRef,
    device_ref: options.deviceRef,
    ...(options.simRef !== undefined ? { sim_ref: options.simRef } : {}),

    received_at: options.receivedAt,
    // Traccar's serverTime is when Traccar accepted it — a vendor receipt, not ours.
    ...(position.serverTime !== undefined ? { vendor_received_at: new Date(position.serverTime).toISOString() } : {}),
    ...(position.deviceTime !== undefined ? { device_time: new Date(position.deviceTime).toISOString() } : {}),

    quality: {
      raw_sha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      adapter_version: `traccar-${TRACCAR_ADAPTER_VERSION}`,
      ...(position.fixTime !== undefined && position.deviceTime !== undefined &&
        position.fixTime !== position.deviceTime
        ? { parse_warnings: ['fixTime differs from deviceTime; position may be stale'] }
        : {}),
    },
  }

  if (position.latitude !== undefined && position.longitude !== undefined) {
    event['position'] = {
      lat: position.latitude,
      lon: position.longitude,
      ...(position.accuracy !== undefined ? { accuracy_m: position.accuracy } : {}),
      fix_type: 'gps',
      ...(typeof attributes['sat'] === 'number' ? { satellites: attributes['sat'] } : {}),
      ...(typeof attributes['hdop'] === 'number' ? { hdop: attributes['hdop'] } : {}),
      // Traccar's `valid` is the device's own fix validity. Absent means the device did not say.
      valid: position.valid ?? false,
    }
  }

  const motion: Record<string, unknown> = {}
  if (position.speed !== undefined) {
    motion['speed_kph'] = Math.round(position.speed * KNOTS_TO_KPH * 10) / 10
  }
  if (position.course !== undefined) motion['heading_deg'] = position.course
  const ignition = tristate(attributes['ignition'])
  if (ignition !== undefined) motion['ignition'] = ignition
  if (typeof attributes['motion'] === 'boolean') {
    motion['motion_state'] = attributes['motion'] ? 'moving' : 'stationary'
  }
  if (typeof attributes['totalDistance'] === 'number') {
    motion['odometer_m'] = Math.round(attributes['totalDistance'])
  }
  if (Object.keys(motion).length > 0) event['motion'] = motion

  const power: Record<string, unknown> = {}
  if (typeof attributes['power'] === 'number') power['external_v'] = attributes['power']
  if (typeof attributes['battery'] === 'number') power['internal_v'] = attributes['battery']
  if (typeof attributes['batteryLevel'] === 'number') power['internal_pct'] = attributes['batteryLevel']
  if (attributes['charge'] === true) power['external_state'] = 'present'
  else if (attributes['charge'] === false) power['external_state'] = 'absent'
  if (Object.keys(power).length > 0) event['power'] = power

  const network: Record<string, unknown> = {}
  if (typeof attributes['rssi'] === 'number') network['rssi_dbm'] = attributes['rssi']
  if (typeof attributes['mcc'] === 'number') network['mcc'] = attributes['mcc']
  if (typeof attributes['mnc'] === 'number') network['mnc'] = attributes['mnc']
  if (typeof attributes['cid'] === 'number') network['cell_id'] = attributes['cid']
  if (typeof attributes['lac'] === 'number') network['lac'] = attributes['lac']
  if (Object.keys(network).length > 0) event['network'] = network

  const device: Record<string, unknown> = { vendor: 'traccar' }
  if (payload.device?.model != null && payload.device.model !== '') {
    device['model'] = payload.device.model
  }
  if (typeof attributes['version'] === 'string') device['firmware'] = attributes['version']
  // Traccar exposes no sleep state. Declaring the field absent is correct; inventing 'awake' would
  // be a measurement the source never made, and the capability manifest says so.
  event['device'] = device

  const alerts: { code: string; source_code: string }[] = []
  if (typeof attributes['alarm'] === 'string') alerts.push(mapAlarm(attributes['alarm']))
  if (payload.event?.type === 'deviceOverspeed') alerts.push({ code: 'other', source_code: 'deviceOverspeed' })
  event['alerts'] = alerts

  // Everything Traccar sent that this adapter did not map, kept namespaced so it is available
  // without ever being mistaken for a canonical fact (FR-SRC-007).
  const mapped = new Set([
    'sat', 'hdop', 'ignition', 'motion', 'totalDistance', 'power', 'battery', 'batteryLevel',
    'charge', 'rssi', 'mcc', 'mnc', 'cid', 'lac', 'alarm', 'version',
  ])
  const extras = Object.fromEntries(Object.entries(attributes).filter(([k]) => !mapped.has(k)))
  if (Object.keys(extras).length > 0) event['ext'] = { traccar: extras }

  return event
}

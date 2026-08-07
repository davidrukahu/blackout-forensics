// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import { validateCanonicalEvent } from '@blackout/spec'

import { decodeTraccar, TRACCAR_ADAPTER_VERSION, type TraccarForwardPayload } from './adapter.js'

const OPTIONS = {
  tenantId: 'synthetic_demo',
  source: 'traccar_forwarder',
  receivedAt: '2026-08-05T09:20:04.000Z',
  assetRef: 'ast_9a3f0011',
  deviceRef: 'dev_c8240022',
}

const payload = (overrides: Partial<TraccarForwardPayload> = {}): TraccarForwardPayload => ({
  position: {
    id: 88_121,
    deviceId: 7,
    protocol: 'osmand',
    serverTime: '2026-08-05T09:20:02.000Z',
    deviceTime: '2026-08-05T09:19:55.000Z',
    fixTime: '2026-08-05T09:19:55.000Z',
    valid: true,
    latitude: -1.2864,
    longitude: 36.8172,
    speed: 11.5,
    course: 143.2,
    accuracy: 18,
    attributes: { sat: 11, ignition: true, motion: true, totalDistance: 184_320.4, batteryLevel: 88 },
  },
  device: { id: 7, uniqueId: '860123456789012', name: 'boda-01', model: 'FMB920' },
  ...overrides,
})

describe('the adapter produces schema-valid canonical events', () => {
  it('validates a typical forwarded position', () => {
    const event = decodeTraccar(payload(), OPTIONS)
    const result = validateCanonicalEvent(event)
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
  })

  it('uses Traccar position id as a genuine vendor event id', () => {
    // Traccar's position id is stable per position and unique per server — unlike the device
    // families that force synthesis.
    const event = decodeTraccar(payload(), OPTIONS)
    expect(event['event_identity']).toEqual({ basis: 'vendor_event_id', value: '88121' })
  })

  it('synthesises identity and declares the algorithm when Traccar omits the id', () => {
    // Omit the key rather than setting it undefined: with exactOptionalPropertyTypes, "absent"
    // and "present but undefined" are different types — the same distinction the schema enforces.
    const { id: _omitted, ...withoutId } = payload().position!
    const event = decodeTraccar({ ...payload(), position: withoutId }, OPTIONS)
    const identity = event['event_identity'] as { basis: string; algorithm?: string }
    expect(identity.basis).toBe('synthesised')
    expect(identity.algorithm).toContain('sha256')
    expect(validateCanonicalEvent(event).valid).toBe(true)
  })
})

describe('unit conversion and time handling', () => {
  it('converts knots to km/h — Traccar reports speed in knots', () => {
    // A classic silent-error source: 11.5 knots read as km/h understates by 85%.
    const event = decodeTraccar(payload(), OPTIONS)
    expect((event['motion'] as { speed_kph: number }).speed_kph).toBeCloseTo(21.3, 1)
  })

  it('keeps Traccar server time as a vendor receipt, not as ours', () => {
    const event = decodeTraccar(payload(), OPTIONS)
    expect(event['vendor_received_at']).toBe('2026-08-05T09:20:02.000Z')
    expect(event['received_at']).toBe(OPTIONS.receivedAt)
    expect(event['device_time']).toBe('2026-08-05T09:19:55.000Z')
  })

  it('warns when the fix is older than the report', () => {
    // fixTime behind deviceTime means the device reported a position it no longer holds.
    const event = decodeTraccar(
      payload({ position: { ...payload().position, fixTime: '2026-08-05T09:10:00.000Z' } }),
      OPTIONS,
    )
    const quality = event['quality'] as { parse_warnings?: string[] }
    expect(quality.parse_warnings?.[0]).toContain('stale')
  })
})

describe('absent stays absent — FR-TEL-002', () => {
  it('omits motion entirely when Traccar sent nothing about it', () => {
    const event = decodeTraccar(
      { position: { id: 1, latitude: -1.2, longitude: 36.8, valid: true, attributes: {} } },
      OPTIONS,
    )
    expect('motion' in event).toBe(false)
    expect('power' in event).toBe(false)
    expect('network' in event).toBe(false)
    expect(validateCanonicalEvent(event).valid).toBe(true)
  })

  it('never invents a sleep state Traccar cannot report', () => {
    // Declaring the field absent is correct; inventing 'awake' would be a measurement the source
    // never made. The capability manifest records this as unsupported.
    const device = decodeTraccar(payload(), OPTIONS)['device'] as Record<string, unknown>
    expect('sleep_state' in device).toBe(false)
  })

  it('treats an unreadable ignition value as unknown rather than false', () => {
    const event = decodeTraccar(
      payload({ position: { ...payload().position, attributes: { ignition: 'maybe' } } }),
      OPTIONS,
    )
    expect((event['motion'] as { ignition: string }).ignition).toBe('unknown')
  })

  it('records a device fix as invalid when Traccar says nothing', () => {
    const event = decodeTraccar(
      { position: { id: 2, latitude: -1.2, longitude: 36.8 } },
      OPTIONS,
    )
    expect((event['position'] as { valid: boolean }).valid).toBe(false)
  })
})

describe('alerts and extensions', () => {
  it('maps a known alarm and preserves the vendor code', () => {
    const event = decodeTraccar(
      payload({ position: { ...payload().position, attributes: { alarm: 'powerCut' } } }),
      OPTIONS,
    )
    expect(event['alerts']).toEqual([{ code: 'power_cut', source_code: 'powerCut' }])
  })

  it('keeps an unrecognised alarm rather than dropping it', () => {
    // An alarm this adapter has not seen is still evidence that something happened.
    const event = decodeTraccar(
      payload({ position: { ...payload().position, attributes: { alarm: 'geofenceExit' } } }),
      OPTIONS,
    )
    expect(event['alerts']).toEqual([{ code: 'other', source_code: 'geofenceExit' }])
  })

  it('namespaces unmapped attributes rather than promoting them', () => {
    const event = decodeTraccar(
      payload({ position: { ...payload().position, attributes: { sat: 9, io239: 1, custom: 'x' } } }),
      OPTIONS,
    )
    expect(event['ext']).toEqual({ traccar: { io239: 1, custom: 'x' } })
    expect(validateCanonicalEvent(event).valid).toBe(true)
  })
})

describe('identifiers never reach a canonical event', () => {
  it('drops the Traccar uniqueId, which is usually an IMEI', () => {
    const event = decodeTraccar(payload(), OPTIONS)
    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain('860123456789012')
    expect(event['device_ref']).toBe('dev_c8240022')
  })
})

describe('failure is loud', () => {
  it('refuses a payload with no position rather than guessing', () => {
    expect(() => decodeTraccar({ device: { id: 1 } }, OPTIONS)).toThrow(/no position/)
  })

  it('stamps its own version on every event', () => {
    const quality = decodeTraccar(payload(), OPTIONS)['quality'] as { adapter_version: string }
    expect(quality.adapter_version).toBe(`traccar-${TRACCAR_ADAPTER_VERSION}`)
  })
})

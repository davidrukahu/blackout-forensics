// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'

import { validateAdapterManifest, validateCanonicalEvent } from './validate.js'
import { SCHEMA_VERSION } from './canonical-event.js'
import { MANIFEST_VERSION } from './adapter-manifest.js'

function baseEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    tenant_id: 'synthetic_demo',
    source: 'traccar_forwarder',
    event_identity: { basis: 'vendor_event_id', value: 'evt_01JEXAMPLE' },
    asset_ref: 'ast_9a3f0011',
    device_ref: 'dev_c8240022',
    received_at: '2026-08-05T09:20:04.000Z',
    quality: { raw_sha256: 'a'.repeat(64), adapter_version: 'traccar-1.0.0' },
    ...overrides,
  }
}

describe('canonical event validation', () => {
  it('accepts a minimal valid event', () => {
    expect(validateCanonicalEvent(baseEvent())).toEqual({ valid: true, errors: [] })
  })

  it('reports every error, not just the first', () => {
    const result = validateCanonicalEvent({
      schema_version: SCHEMA_VERSION,
      tenant_id: 'synthetic_demo',
      // missing: source, event_identity, asset_ref, device_ref, received_at, quality
    })
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(3)
  })

  it('rejects a synthesised identity with no algorithm', () => {
    const result = validateCanonicalEvent(
      baseEvent({ event_identity: { basis: 'synthesised', value: 'h:abc123' } }),
    )
    expect(result.valid).toBe(false)
  })

  it('accepts a synthesised identity that declares its algorithm', () => {
    const result = validateCanonicalEvent(
      baseEvent({
        event_identity: {
          basis: 'synthesised',
          value: 'h:abc123',
          algorithm: 'sha256(device_ref|device_time|payload)',
        },
      }),
    )
    expect(result.valid).toBe(true)
  })

  it('never coerces a string into a number', () => {
    const result = validateCanonicalEvent(
      baseEvent({ motion: { speed_kph: '21.4' } }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path.includes('speed_kph'))).toBe(true)
  })

  it('keeps unknown distinct from false', () => {
    // "unknown" is a legal value; false is not, because ignition is tri-state.
    expect(validateCanonicalEvent(baseEvent({ motion: { ignition: 'unknown' } })).valid).toBe(true)
    expect(validateCanonicalEvent(baseEvent({ motion: { ignition: false } })).valid).toBe(false)
  })

  it('allows null to mean "reported as unknown by the source"', () => {
    expect(validateCanonicalEvent(baseEvent({ device_time: null })).valid).toBe(true)
  })

  it('rejects unnamespaced source-specific fields with a pointed message', () => {
    const result = validateCanonicalEvent(baseEvent({ teltonika_io_239: 1 }))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.message.includes('ext.<adapter_id>'))).toBe(true)
  })

  it('accepts namespaced extension fields', () => {
    const result = validateCanonicalEvent(baseEvent({ ext: { teltonika: { io_239: 1 } } }))
    expect(result.valid).toBe(true)
  })

  it('rejects a malformed pseudonymous reference', () => {
    expect(validateCanonicalEvent(baseEvent({ asset_ref: 'KMEX 123A' })).valid).toBe(false)
  })

  it('rejects an impossible coordinate', () => {
    const result = validateCanonicalEvent(
      baseEvent({ position: { lat: 99, lon: 36.8172, valid: true } }),
    )
    expect(result.valid).toBe(false)
  })

  it('requires provenance on every event', () => {
    const event = baseEvent()
    delete (event as Record<string, unknown>)['quality']
    expect(validateCanonicalEvent(event).valid).toBe(false)
  })
})

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifest_version: MANIFEST_VERSION,
    adapter: {
      name: 'traccar',
      version: '0.1.0',
      source_versions: ['6.x'],
      provenance: 'vendor_documentation_public',
    },
    identity: { basis: 'vendor_event_id' },
    times: { precedence: ['received_at', 'vendor_received_at', 'device_time'] },
    delivery: {
      mechanisms: ['raw_forward'],
      push_reliability: 'buffered_and_confirmed',
      buffering: { offline_buffer: true },
    },
    fields: [{ path: 'position.lat', support: 'supported' }],
    readiness: { level: 'parsed', evidence: ['conformance fixtures pass'] },
    ...overrides,
  }
}

describe('adapter manifest validation', () => {
  it('accepts a minimal valid manifest', () => {
    expect(validateAdapterManifest(baseManifest()).valid).toBe(true)
  })

  it('requires a condition when field support is conditional', () => {
    const result = validateAdapterManifest(
      baseManifest({ fields: [{ path: 'network.rssi_dbm', support: 'conditional' }] }),
    )
    expect(result.valid).toBe(false)
  })

  it('accepts a conditional field that names its condition', () => {
    const result = validateAdapterManifest(
      baseManifest({
        fields: [
          { path: 'network.rssi_dbm', support: 'conditional', condition: 'absent in Deep Sleep' },
        ],
      }),
    )
    expect(result.valid).toBe(true)
  })

  it('refuses forensics_ready when push can drop silently and no pull reconciler exists', () => {
    const result = validateAdapterManifest(
      baseManifest({
        delivery: {
          mechanisms: ['webhook'],
          push_reliability: 'drops_silently',
          buffering: { offline_buffer: false },
        },
        readiness: { level: 'forensics_ready', evidence: ['timestamps verified'] },
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors[0]?.message).toContain('pull_reconciler_required')
  })

  it('allows forensics_ready once a pull reconciler is declared', () => {
    const result = validateAdapterManifest(
      baseManifest({
        delivery: {
          mechanisms: ['webhook', 'rest_poll'],
          push_reliability: 'drops_silently',
          pull_reconciler: true,
          buffering: { offline_buffer: false },
        },
        readiness: { level: 'forensics_ready', evidence: ['timestamps verified', 'reconciler tested'] },
      }),
    )
    expect(result.valid).toBe(true)
  })

  it('permits parsed level without a reconciler — the bar applies only above it', () => {
    const result = validateAdapterManifest(
      baseManifest({
        delivery: {
          mechanisms: ['webhook'],
          push_reliability: 'drops_silently',
          buffering: { offline_buffer: false },
        },
      }),
    )
    expect(result.valid).toBe(true)
  })

  it('records the second-server distinction that a feature list would hide', () => {
    const ruptela = validateAdapterManifest(
      baseManifest({
        delivery: {
          mechanisms: ['raw_forward'],
          push_reliability: 'best_effort',
          pull_reconciler: true,
          second_server_mode: 'delete_on_first_ack',
          buffering: { offline_buffer: true },
        },
      }),
    )
    expect(ruptela.valid).toBe(true)
  })
})

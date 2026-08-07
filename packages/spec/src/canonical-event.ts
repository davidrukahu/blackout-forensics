// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: Apache-2.0


/**
 * Canonical telemetry event, schema v0.
 *
 * Decisions this encodes:
 *  - Absent, unknown and zero are distinct. Field omitted = never reported; explicit null =
 *    reported as unknown by the source; a value = measured. Adapters must not coerce between them.
 *  - Event identity is a structured object, not a scalar. Teltonika Codec 8/8E carry no record id
 *    and document byte-identical resends, so identity is often synthesised — and every downstream
 *    duplicate and ordering claim depends on knowing which basis produced it.
 *  - Sleep state is carried explicitly with an explicit unknown, never inferred from silence.
 *    Deep Sleep disables jamming detectors, so absence of a jamming flag is not a measurement.
 *
 * Decision record: ADR 0008.
 */

export const SCHEMA_VERSION = '0.1.0'

/** How this event's identity was established. */
export type EventIdentityBasis = 'vendor_event_id' | 'vendor_sequence' | 'synthesised'

export const CANONICAL_EVENT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://blackout-forensics.org/schema/canonical-event/0.1.0.json',
  title: 'Canonical telemetry event',
  type: 'object',
  required: ['schema_version', 'tenant_id', 'source', 'event_identity', 'asset_ref', 'device_ref', 'received_at', 'quality'],
  additionalProperties: false,
  properties: {
    schema_version: { type: 'string', const: SCHEMA_VERSION },
    tenant_id: { type: 'string', minLength: 1 },
    source: { type: 'string', minLength: 1 },

    event_identity: {
      type: 'object',
      required: ['basis', 'value'],
      additionalProperties: false,
      properties: {
        basis: { enum: ['vendor_event_id', 'vendor_sequence', 'synthesised'] },
        value: { type: 'string', minLength: 1 },
        // Required when basis is 'synthesised': how the adapter derived it.
        algorithm: { type: 'string' },
      },
      allOf: [{
        if: { properties: { basis: { const: 'synthesised' } } },
        // ajv strictRequired wants the branch to declare what it requires.
        then: {
          properties: { algorithm: { type: 'string', minLength: 1 } },
          required: ['algorithm'],
        },
      }],
    },

    asset_ref: { $ref: '#/$defs/pseudonym' },
    device_ref: { $ref: '#/$defs/pseudonym' },
    sim_ref: { $ref: '#/$defs/pseudonym' },

    // Times are never overwritten by any processing step (FR-TEL-003).
    received_at: { type: 'string', format: 'date-time' },
    vendor_received_at: { type: ['string', 'null'], format: 'date-time' },
    device_time: { type: ['string', 'null'], format: 'date-time' },

    position: { $ref: '#/$defs/position' },
    motion: { $ref: '#/$defs/motion' },
    power: { $ref: '#/$defs/power' },
    network: { $ref: '#/$defs/network' },
    device: { $ref: '#/$defs/device' },
    alerts: { type: 'array', items: { $ref: '#/$defs/alert' } },
    quality: { $ref: '#/$defs/quality' },

    // Source-specific fields, namespaced by adapter id. Never canonical facts (FR-SRC-007).
    ext: { type: 'object', additionalProperties: { type: 'object' } },
  },

  $defs: {
    pseudonym: { type: 'string', pattern: '^(ast|dev|sim)_[0-9a-f]{8,}$' },

    position: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        lat: { type: 'number', minimum: -90, maximum: 90 },
        lon: { type: 'number', minimum: -180, maximum: 180 },
        accuracy_m: { type: ['number', 'null'], minimum: 0 },
        fix_type: { enum: ['gps', 'gnss', 'cell', 'wifi', 'unknown', null] },
        satellites: { type: ['integer', 'null'], minimum: 0 },
        hdop: { type: ['number', 'null'], minimum: 0 },
        valid: { type: 'boolean' },
      },
      required: ['valid'],
    },

    motion: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        speed_kph: { type: ['number', 'null'], minimum: 0 },
        heading_deg: { type: ['number', 'null'], minimum: 0, exclusiveMaximum: 360 },
        // Tri-state throughout: unknown is not false.
        ignition: { enum: ['on', 'off', 'unknown', null] },
        motion_state: { enum: ['moving', 'stationary', 'unknown', null] },
        odometer_m: { type: ['number', 'null'], minimum: 0 },
      },
    },

    power: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        external_state: { enum: ['present', 'absent', 'unknown', null] },
        external_v: { type: ['number', 'null'] },
        internal_v: { type: ['number', 'null'] },
        internal_pct: { type: ['number', 'null'], minimum: 0, maximum: 100 },
      },
    },

    network: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        mcc: { type: ['integer', 'null'] },
        mnc: { type: ['integer', 'null'] },
        lac: { type: ['integer', 'null'] },
        tac: { type: ['integer', 'null'] },
        cell_id: { type: ['integer', 'null'] },
        radio: { enum: ['2G', '3G', '4G', '5G', 'unknown', null] },
        rssi_dbm: { type: ['number', 'null'] },
        rsrp_dbm: { type: ['number', 'null'] },
        registration: { enum: ['registered', 'searching', 'denied', 'unknown', null] },
      },
    },

    device: {
      type: 'object',
      additionalProperties: false,
      properties: {
        vendor: { type: ['string', 'null'] },
        model: { type: ['string', 'null'] },
        firmware: { type: ['string', 'null'] },
        reboot_reason: { type: ['string', 'null'] },
        // Explicit, never inferred from silence. 'unknown' is a real and common answer.
        sleep_state: { enum: ['awake', 'light_sleep', 'deep_sleep', 'unknown', null] },
        temperature_c: { type: ['number', 'null'] },
      },
    },

    alert: {
      type: 'object',
      required: ['code', 'source_code'],
      additionalProperties: false,
      properties: {
        code: {
          enum: ['power_cut', 'unplug', 'tamper', 'gnss_jamming', 'network_jamming', 'towing', 'other'],
        },
        // The original vendor code is preserved alongside the normalized one.
        source_code: { type: 'string' },
      },
    },

    quality: {
      type: 'object',
      required: ['raw_sha256', 'adapter_version'],
      additionalProperties: false,
      properties: {
        raw_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        adapter_version: { type: 'string' },
        clock_skew_s: { type: ['number', 'null'] },
        parse_warnings: { type: 'array', items: { type: 'string' } },
      },
    },
  },
} as const

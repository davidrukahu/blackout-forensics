// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: Apache-2.0


import { describe, expect, it } from 'vitest'
import { CANONICAL_EVENT_SCHEMA, SCHEMA_VERSION } from './canonical-event.js'

describe('canonical event schema v0', () => {
  it('pins its version', () => {
    expect(SCHEMA_VERSION).toBe('0.1.0')
    expect(CANONICAL_EVENT_SCHEMA.properties.schema_version.const).toBe(SCHEMA_VERSION)
  })

  it('requires an event identity basis, because Teltonika supplies none', () => {
    const identity = CANONICAL_EVENT_SCHEMA.properties.event_identity
    expect(identity.required).toContain('basis')
    expect(identity.properties.basis.enum).toEqual([
      'vendor_event_id', 'vendor_sequence', 'synthesised',
    ])
  })

  it('demands an algorithm when identity is synthesised', () => {
    const rule = CANONICAL_EVENT_SCHEMA.properties.event_identity.allOf[0]
    expect(rule.if.properties.basis.const).toBe('synthesised')
    expect(rule.then.required).toContain('algorithm')
  })

  it('keeps unknown distinct from false on every tri-state field', () => {
    const { motion, power, device } = CANONICAL_EVENT_SCHEMA.$defs
    expect(motion.properties.ignition.enum).toContain('unknown')
    expect(motion.properties.motion_state.enum).toContain('unknown')
    expect(power.properties.external_state.enum).toContain('unknown')
    expect(device.properties.sleep_state.enum).toContain('unknown')
  })

  it('carries sleep state explicitly, so silence is never read as a measurement', () => {
    expect(CANONICAL_EVENT_SCHEMA.$defs.device.properties.sleep_state.enum)
      .toEqual(['awake', 'light_sleep', 'deep_sleep', 'unknown', null])
  })

  it('preserves the original vendor code alongside every normalized alert', () => {
    expect(CANONICAL_EVENT_SCHEMA.$defs.alert.required).toEqual(['code', 'source_code'])
  })

  it('forbids unnamespaced source-specific fields at the top level', () => {
    expect(CANONICAL_EVENT_SCHEMA.additionalProperties).toBe(false)
  })

  it('requires receipt time and provenance on every event', () => {
    expect(CANONICAL_EVENT_SCHEMA.required).toContain('received_at')
    expect(CANONICAL_EVENT_SCHEMA.$defs.quality.required)
      .toEqual(['raw_sha256', 'adapter_version'])
  })
})

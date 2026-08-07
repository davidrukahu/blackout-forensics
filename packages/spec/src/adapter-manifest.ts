// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter capability manifest, v0.
 *
 * The contract that lets the evidence engine avoid requiring fields a device cannot produce
 * (FR-AST-004), and that grades an adapter Parsed / Forensics-ready / Recovery-ready.
 *
 * Several declarations here exist because platform research found vendors differing dangerously
 * in ways a feature list hides.
 */

export const MANIFEST_VERSION = '0.1.0'

export const ADAPTER_MANIFEST_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://blackout-forensics.org/schema/adapter-manifest/0.1.0.json',
  title: 'Adapter capability manifest',
  type: 'object',
  additionalProperties: false,
  required: [
    'manifest_version',
    'adapter',
    'identity',
    'times',
    'delivery',
    'fields',
    'readiness',
  ],
  properties: {
    manifest_version: { type: 'string', const: MANIFEST_VERSION },

    adapter: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'version', 'source_versions', 'provenance'],
      properties: {
        name: { type: 'string', minLength: 1 },
        version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+' },
        source_versions: { type: 'array', items: { type: 'string' }, minItems: 1 },
        /**
         * How this adapter was built. Several vendor protocol specifications are marked
         * confidential and one forbids use rather than merely redistribution, so provenance is
         * declared rather than assumed.
         */
        provenance: {
          enum: ['vendor_documentation_public', 'vendor_agreement', 'clean_room', 'unknown'],
        },
      },
    },

    identity: {
      type: 'object',
      additionalProperties: false,
      required: ['basis'],
      properties: {
        basis: { enum: ['vendor_event_id', 'vendor_sequence', 'synthesised'] },
        /** Required when synthesised — how the adapter derives identity. */
        algorithm: { type: 'string' },
        /**
         * True where the source is documented to resend byte-identical records, as Teltonika
         * Codec 8/8E does. Deduplication cannot rely on payload equality alone in that case.
         */
        byte_identical_resends: { type: 'boolean' },
      },
      allOf: [
        {
          if: { properties: { basis: { const: 'synthesised' } } },
          then: {
            properties: { algorithm: { type: 'string', minLength: 1 } },
            required: ['algorithm'],
          },
        },
      ],
    },

    times: {
      type: 'object',
      additionalProperties: false,
      required: ['precedence'],
      properties: {
        /** Which time this source is authoritative for, in order of trust. */
        precedence: {
          type: 'array',
          minItems: 1,
          items: { enum: ['received_at', 'vendor_received_at', 'device_time'] },
        },
        device_clock_trusted: { type: 'boolean' },
      },
    },

    delivery: {
      type: 'object',
      additionalProperties: false,
      required: ['mechanisms', 'push_reliability', 'buffering'],
      properties: {
        mechanisms: {
          type: 'array',
          minItems: 1,
          items: { enum: ['webhook', 'rest_poll', 'sftp', 'object_storage', 'raw_forward', 'database'] },
        },
        /**
         * Whether the push path buffers and confirms, or drops silently. Research found three of
         * five sources unsafe push-only: Wialon retranslator, Navixy webhooks (no retries, no
         * failure logging) and Ruptela SSE (no continuity management).
         */
        push_reliability: { enum: ['buffered_and_confirmed', 'best_effort', 'drops_silently', 'not_applicable'] },
        /** Required for Forensics-ready: a pull path that can reconcile what push dropped. */
        pull_reconciler: { type: 'boolean' },
        /**
         * Teltonika's Duplicate mode is safe — both servers must acknowledge. Ruptela's deletes
         * records on the first server's acknowledgement with no retransmission to the second.
         * These look identical in a feature list and behave oppositely.
         */
        second_server_mode: { enum: ['none', 'duplicate_both_ack', 'delete_on_first_ack', 'unknown'] },
        buffering: {
          type: 'object',
          additionalProperties: false,
          required: ['offline_buffer'],
          properties: {
            offline_buffer: { type: 'boolean' },
            capacity_records: { type: ['integer', 'null'], minimum: 0 },
            backfill_marked: { type: 'boolean' },
          },
        },
        normal_delay_s: { type: ['number', 'null'], minimum: 0 },
        worst_case_delay_s: { type: ['number', 'null'], minimum: 0 },
      },
    },

    /**
     * Platform-side filters that discard records before any export can reach them. No amount of
     * export tooling recovers these, and customers generally do not know they are enabled.
     */
    write_time_destruction: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['setting', 'effect', 'default_enabled'],
        properties: {
          setting: { type: 'string' },
          effect: { type: 'string' },
          default_enabled: { type: 'boolean' },
        },
      },
    },

    /** Retention, not schema, sets the usable audit depth. */
    retention: {
      type: 'object',
      additionalProperties: false,
      properties: {
        raw_days: { type: ['integer', 'null'], minimum: 0 },
        decoded_days: { type: ['integer', 'null'], minimum: 0 },
        customer_reducible: { type: 'boolean' },
        notes: { type: 'string' },
      },
    },

    fields: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'support'],
        properties: {
          /** Dotted path into the canonical event, e.g. "power.external_state". */
          path: { type: 'string', pattern: '^[a-z_]+(\\.[a-z_]+)*$' },
          support: { enum: ['supported', 'unsupported', 'conditional'] },
          /** Required when conditional — e.g. "absent in Deep Sleep". */
          condition: { type: 'string' },
          models: { type: 'array', items: { type: 'string' } },
          firmware_min: { type: ['string', 'null'] },
        },
        allOf: [
          {
            if: { properties: { support: { const: 'conditional' } } },
            then: {
              properties: { condition: { type: 'string', minLength: 1 } },
              required: ['condition'],
            },
          },
        ],
      },
    },

    readiness: {
      type: 'object',
      additionalProperties: false,
      required: ['level', 'evidence'],
      properties: {
        level: { enum: ['parsed', 'forensics_ready', 'recovery_ready'] },
        evidence: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
    },
  },
} as const

/**
 * Readiness rules that cannot be expressed in JSON Schema.
 *
 * A manifest can be schema-valid and still make a claim the evidence does not support, so these
 * run alongside validation.
 */
export interface ReadinessViolation {
  readonly rule: string
  readonly detail: string
}

export function checkReadinessClaims(manifest: {
  identity?: { basis?: string; algorithm?: string }
  delivery?: { push_reliability?: string; pull_reconciler?: boolean }
  readiness?: { level?: string }
}): ReadinessViolation[] {
  const violations: ReadinessViolation[] = []
  const level = manifest.readiness?.level
  const atLeastForensics = level === 'forensics_ready' || level === 'recovery_ready'

  if (atLeastForensics) {
    const push = manifest.delivery?.push_reliability
    const unsafePush = push === 'best_effort' || push === 'drops_silently'
    if (unsafePush && manifest.delivery?.pull_reconciler !== true) {
      violations.push({
        rule: 'pull_reconciler_required',
        detail:
          `push_reliability is "${push}" but no pull reconciler is declared. An adapter whose ` +
          'push path can drop records silently cannot reach forensics_ready without a pull path ' +
          'that reconciles what was lost.',
      })
    }

    if (manifest.identity?.basis === 'synthesised' && !manifest.identity.algorithm) {
      violations.push({
        rule: 'synthesised_identity_needs_algorithm',
        detail:
          'identity.basis is "synthesised" but no algorithm is declared. Duplicate and ordering ' +
          'claims cannot be assessed without knowing how identity was derived.',
      })
    }
  }

  return violations
}

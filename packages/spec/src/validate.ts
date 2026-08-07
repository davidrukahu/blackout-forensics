// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema validation for canonical events and adapter manifests.
 *
 * FR-TEL-001 requires field-level errors and forbids silent coercion, so validation runs with
 * coercion off and reports every error rather than the first.
 */

import _Ajv2020 from 'ajv/dist/2020.js'
import _addFormats from 'ajv-formats'
import type { ErrorObject, ValidateFunction } from 'ajv'

// ajv 8 ships CommonJS. Under NodeNext ESM with verbatimModuleSyntax the default export is not
// unwrapped automatically, so bind it explicitly rather than reaching through `.default` at
// every call site.
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default
const addFormats = _addFormats as unknown as typeof _addFormats.default

import { CANONICAL_EVENT_SCHEMA } from './canonical-event.js'
import { ADAPTER_MANIFEST_SCHEMA, checkReadinessClaims } from './adapter-manifest.js'

export interface ValidationError {
  /** JSON Pointer to the offending value, e.g. "/power/external_state". */
  readonly path: string
  readonly message: string
}

export interface ValidationResult {
  readonly valid: boolean
  readonly errors: readonly ValidationError[]
}

function buildAjv(): InstanceType<typeof Ajv2020> {
  const ajv = new Ajv2020({
    allErrors: true,
    // Coercion would silently convert "unknown" into a boolean, or a string into a number, which
    // is precisely the failure FR-TEL-002 exists to prevent.
    coerceTypes: false,
    useDefaults: false,
    strict: true,
    strictTypes: false,
  })
  addFormats(ajv)
  return ajv
}

const ajv = buildAjv()

const validateEvent: ValidateFunction = ajv.compile(CANONICAL_EVENT_SCHEMA)
const validateManifest: ValidateFunction = ajv.compile(ADAPTER_MANIFEST_SCHEMA)

function toErrors(errors: ErrorObject[] | null | undefined): ValidationError[] {
  return (errors ?? []).map((e) => ({
    path: e.instancePath === '' ? '/' : e.instancePath,
    message:
      e.keyword === 'additionalProperties' && typeof e.params['additionalProperty'] === 'string'
        ? `unknown field "${e.params['additionalProperty']}" — source-specific fields belong under ext.<adapter_id>`
        : (e.message ?? 'invalid'),
  }))
}

export function validateCanonicalEvent(event: unknown): ValidationResult {
  const valid = validateEvent(event) as boolean
  return { valid, errors: valid ? [] : toErrors(validateEvent.errors) }
}

/**
 * Validates an adapter manifest against the schema, then against the readiness rules that JSON
 * Schema cannot express — a manifest can be structurally valid while claiming a readiness level
 * its own declarations contradict.
 */
export function validateAdapterManifest(manifest: unknown): ValidationResult {
  const structurallyValid = validateManifest(manifest) as boolean
  const errors = structurallyValid ? [] : toErrors(validateManifest.errors)

  if (!structurallyValid) return { valid: false, errors }

  const readiness = checkReadinessClaims(manifest as Parameters<typeof checkReadinessClaims>[0])
  return {
    valid: readiness.length === 0,
    errors: readiness.map((v) => ({ path: '/readiness', message: `${v.rule}: ${v.detail}` })),
  }
}

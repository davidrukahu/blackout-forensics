// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: Apache-2.0

export { CANONICAL_EVENT_SCHEMA, SCHEMA_VERSION } from './canonical-event.js'
export type { EventIdentityBasis } from './canonical-event.js'
export { ADAPTER_MANIFEST_SCHEMA, MANIFEST_VERSION, checkReadinessClaims } from './adapter-manifest.js'
export type { ReadinessViolation } from './adapter-manifest.js'
export { validateCanonicalEvent, validateAdapterManifest } from './validate.js'
export type { ValidationError, ValidationResult } from './validate.js'

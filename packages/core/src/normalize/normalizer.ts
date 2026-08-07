// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Normalization and observation versioning.
 *
 * FR-TEL-001 forbids silent coercion and requires field-level errors. FR-TEL-002 keeps absent,
 * unknown and zero distinct. FR-TEL-003 forbids any processing step from overwriting one of the
 * three times. FR-TEL-007 requires re-decoding with a new adapter version to create a *new*
 * normalized version, leaving the original untouched.
 *
 * The last of those is the interesting one. A newer adapter is not a correction — it is a second
 * opinion. An episode already classified from version 1 must stay reproducible from version 1, or
 * the evidence record becomes something that changes underneath a decision that has already been
 * made and acted on. So versions accumulate; nothing is rewritten.
 */

import { validateCanonicalEvent, type ValidationError } from '@blackout/spec'

/** A vendor-shaped record turned into canonical form by an adapter. */
export interface Adapter {
  readonly name: string
  /** Semantic version. Two adapters differing only by version produce two observation versions. */
  readonly version: string
  /** Convert a vendor record. Must not coerce; must not invent. */
  decode(raw: unknown): Record<string, unknown>
}

export interface NormalizeResult {
  readonly ok: boolean
  readonly event?: Record<string, unknown>
  readonly errors: readonly ValidationError[]
  readonly adapterVersion: string
}

/** Fields no normalization step may alter, once an adapter has set them. */
export const IMMUTABLE_TIME_FIELDS = ['received_at', 'vendor_received_at', 'device_time'] as const

export class TimeOverwriteError extends Error {
  constructor(readonly field: string) {
    super(
      `refusing to overwrite ${field}: the three times are recorded as they arrived and are never ` +
        'rewritten (FR-TEL-003). A processing step that needs a different value is computing a new ' +
        'field, not correcting an old one.',
    )
    this.name = 'TimeOverwriteError'
  }
}

/**
 * Normalize one vendor record.
 *
 * Validation runs on the adapter's output rather than trusting it: an adapter that coerces, invents
 * or drops a field is a defect, and the schema is where that gets caught. The errors returned carry
 * paths, never values, so a rejection can safely reach a diagnostic queue.
 */
export function normalize(raw: unknown, adapter: Adapter): NormalizeResult {
  let decoded: Record<string, unknown>
  try {
    decoded = adapter.decode(raw)
  } catch {
    return {
      ok: false,
      errors: [{ path: '/', message: `adapter ${adapter.name}@${adapter.version} failed to decode` }],
      adapterVersion: `${adapter.name}-${adapter.version}`,
    }
  }

  const validation = validateCanonicalEvent(decoded)
  if (!validation.valid) {
    return { ok: false, errors: validation.errors, adapterVersion: `${adapter.name}-${adapter.version}` }
  }

  return {
    ok: true,
    event: decoded,
    errors: [],
    adapterVersion: `${adapter.name}-${adapter.version}`,
  }
}

/**
 * Merge derived fields into an observation without touching the times.
 *
 * Enrichment is a real need — clock skew, delivery lag, quality flags all get computed after
 * normalization. This is the guarded way to add them: an attempt to write one of the three times
 * throws rather than silently succeeding, because a silently rewritten timestamp is undetectable
 * afterwards and invalidates every episode boundary derived from it.
 */
export function enrich(
  observation: Record<string, unknown>,
  additions: Record<string, unknown>,
): Record<string, unknown> {
  for (const field of IMMUTABLE_TIME_FIELDS) {
    if (field in additions) throw new TimeOverwriteError(field)
  }
  return { ...observation, ...additions }
}

export interface ObservationVersion {
  readonly version: number
  readonly adapterVersion: string
  readonly rawSha256: string
  readonly payload: Record<string, unknown>
  readonly superseded: boolean
}

/**
 * Decide what a re-decode produces.
 *
 * Returns the next version number, or `undefined` when this adapter version has already decoded
 * this receipt — re-running the same adapter is a replay, not a new opinion, and must not
 * manufacture a version that says nothing new.
 */
export function nextVersionFor(
  existing: readonly ObservationVersion[],
  adapterVersion: string,
): number | undefined {
  if (existing.some((v) => v.adapterVersion === adapterVersion)) return undefined
  return existing.reduce((max, v) => Math.max(max, v.version), 0) + 1
}

/** The version a reader should use: highest, not superseded. */
export function currentVersion(
  versions: readonly ObservationVersion[],
): ObservationVersion | undefined {
  return [...versions]
    .filter((v) => !v.superseded)
    .sort((a, b) => b.version - a.version)[0]
}

export interface VersionDiff {
  readonly field: string
  readonly changed: boolean
}

/**
 * What a re-decode actually changed.
 *
 * A new adapter version usually improves a handful of fields and leaves the rest alone. Recording
 * which is which is what makes a re-decode reviewable rather than an act of faith — and it is the
 * evidence for whether the new adapter should be trusted over the old one for existing episodes.
 */
export function diffVersions(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): VersionDiff[] {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  return fields.map((field) => ({
    field,
    changed: JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  }))
}

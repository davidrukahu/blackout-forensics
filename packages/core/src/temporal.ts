// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Effective-dated intervals.
 *
 * FR-TEN-003 requires replaying a past episode to use the policy that was effective at event time,
 * and FR-AST-002 requires events before and after a reassignment to resolve to the correct
 * historical relationships. Both reduce to the same primitive: a value that is true over a bounded
 * period, resolved by asking what held at an instant.
 *
 * Intervals are **half-open**: `[validFrom, validTo)`. The instant a record ends is the instant its
 * successor begins, so back-to-back periods neither overlap nor leave a one-millisecond hole. Every
 * off-by-one bug in temporal data comes from getting this wrong, so it is stated once here and
 * enforced everywhere.
 */

export interface Interval {
  /** Inclusive lower bound, ISO 8601. */
  readonly validFrom: string
  /** Exclusive upper bound, ISO 8601. Null means open-ended — still in force. */
  readonly validTo: string | null
}

export type EffectiveDated<T> = T & Interval

const ms = (iso: string): number => {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) throw new Error(`invalid timestamp: ${iso}`)
  return t
}

export function contains(interval: Interval, at: string): boolean {
  const t = ms(at)
  if (t < ms(interval.validFrom)) return false
  return interval.validTo === null || t < ms(interval.validTo)
}

export function overlaps(a: Interval, b: Interval): boolean {
  const aStart = ms(a.validFrom)
  const bStart = ms(b.validFrom)
  const aEnd = a.validTo === null ? Number.POSITIVE_INFINITY : ms(a.validTo)
  const bEnd = b.validTo === null ? Number.POSITIVE_INFINITY : ms(b.validTo)
  return aStart < bEnd && bStart < aEnd
}

/** Zero-length and inverted intervals are always errors — they can never resolve. */
export function isWellFormed(interval: Interval): boolean {
  try {
    if (interval.validTo === null) return true
    return ms(interval.validFrom) < ms(interval.validTo)
  } catch {
    return false
  }
}

/** The record in force at `at`, or undefined. Records are assumed to belong to one logical key. */
export function resolveAt<T>(records: readonly EffectiveDated<T>[], at: string): EffectiveDated<T> | undefined {
  const matches = records.filter((r) => contains(r, at))
  if (matches.length <= 1) return matches[0]
  // Overlapping records mean the data is broken. Returning the latest silently would hide it, so
  // callers that care must run detectOverlaps; this exists so resolution stays total.
  return [...matches].sort((a, b) => ms(b.validFrom) - ms(a.validFrom))[0]
}

export interface TemporalDefect<T> {
  readonly kind: 'overlap' | 'gap' | 'malformed'
  readonly key: string
  readonly records: readonly EffectiveDated<T>[]
  /** For gaps: the uncovered span. */
  readonly from?: string
  readonly to?: string
}

/**
 * Find overlaps, gaps and malformed records within one logical key.
 *
 * FR-AST-005 requires the data-quality queue to identify every overlap and unmapped active device.
 * Gaps are reported separately because they are not always defects — an asset genuinely can have no
 * tracker for a period — whereas an overlap always is.
 */
export function detectDefects<T>(
  key: string,
  records: readonly EffectiveDated<T>[],
): TemporalDefect<T>[] {
  const defects: TemporalDefect<T>[] = []

  const malformed = records.filter((r) => !isWellFormed(r))
  if (malformed.length > 0) defects.push({ kind: 'malformed', key, records: malformed })

  const sound = records.filter(isWellFormed)
  const sorted = [...sound].sort((a, b) => ms(a.validFrom) - ms(b.validFrom))

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i] as EffectiveDated<T>
      const b = sorted[j] as EffectiveDated<T>
      if (overlaps(a, b)) defects.push({ kind: 'overlap', key, records: [a, b] })
    }
  }

  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1] as EffectiveDated<T>
    const current = sorted[i] as EffectiveDated<T>
    if (previous.validTo === null) continue
    if (ms(previous.validTo) < ms(current.validFrom)) {
      defects.push({
        kind: 'gap',
        key,
        records: [previous, current],
        from: previous.validTo,
        to: current.validFrom,
      })
    }
  }

  return defects
}

// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Distributions with visible denominators.
 *
 * Every number this project publishes must carry the population it was computed over. PRD §6.12
 * requires denominators, exclusions and clock basis on every report; FR-GEO-006 forbids displaying
 * raw counts without exposure. A percentage without its denominator is the single easiest way to
 * mislead a customer about their own fleet, so the type makes it impossible to have one without the
 * other.
 */

export interface Denominated {
  /** Rows considered. Never inferred — always carried. */
  readonly denominator: number
  /** Rows meeting the condition. */
  readonly numerator: number
  /** Rows excluded before evaluation, with the reason. */
  readonly excluded: number
  readonly exclusionReasons: Readonly<Record<string, number>>
}

export function ratio(d: Denominated): number | null {
  // A ratio over an empty population is unknown, not zero. Reporting 0% completeness for a device
  // that produced no events would be a fabricated finding.
  return d.denominator === 0 ? null : d.numerator / d.denominator
}

export interface Percentiles {
  readonly count: number
  readonly p50: number | null
  readonly p95: number | null
  readonly p99: number | null
  readonly min: number | null
  readonly max: number | null
}

/**
 * Nearest-rank percentiles.
 *
 * Deliberately not interpolated: an interpolated p95 of a delivery-lag distribution reports a
 * latency that never actually occurred, and these numbers end up in SLA evidence a vendor may
 * dispute. Nearest-rank always names a real observation.
 */
export function percentiles(values: readonly number[]): Percentiles {
  if (values.length === 0) {
    return { count: 0, p50: null, p95: null, p99: null, min: null, max: null }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number): number => {
    const rank = Math.ceil((p / 100) * sorted.length)
    return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number
  }
  return {
    count: sorted.length,
    p50: at(50),
    p95: at(95),
    p99: at(99),
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
  }
}

export function emptyDenominated(): Denominated {
  return { denominator: 0, numerator: 0, excluded: 0, exclusionReasons: {} }
}

export function addExclusion(d: Denominated, reason: string): Denominated {
  return {
    ...d,
    excluded: d.excluded + 1,
    exclusionReasons: { ...d.exclusionReasons, [reason]: (d.exclusionReasons[reason] ?? 0) + 1 },
  }
}

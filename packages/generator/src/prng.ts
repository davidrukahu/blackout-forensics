// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Seeded pseudo-random number generator.
 *
 * Determinism is not a nicety here. FR-EPI-004 requires replay to produce identical version
 * histories, and a fixture corpus that varies between runs cannot prove that. Every scenario must
 * be byte-reproducible from its seed — which is also why a live device rig is used only for adapter
 * conformance, never for scenario generation.
 */

/** mulberry32 — small, fast, adequate for fixture generation. Not cryptographic. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    float: (min, max) => min + next() * (max - min),
    bool: (probability = 0.5) => next() < probability,
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error('cannot pick from an empty list')
      return items[Math.floor(next() * items.length)] as T
    },
    /** Fisher-Yates on a copy, so the caller's array is untouched. */
    shuffle: <T>(items: readonly T[]): T[] => {
      const out = [...items]
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        ;[out[i], out[j]] = [out[j] as T, out[i] as T]
      }
      return out
    },
  }
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number
  /** Uniform integer in [min, max], inclusive. */
  int(min: number, max: number): number
  float(min: number, max: number): number
  bool(probability?: number): boolean
  pick<T>(items: readonly T[]): T
  shuffle<T>(items: readonly T[]): T[]
}

/**
 * Deterministic pseudonymous reference, so the same logical asset gets the same ref across runs
 * without ever deriving from a real identifier.
 */
export function syntheticRef(prefix: 'ast' | 'dev' | 'sim', seed: number, index: number): string {
  const rng = createRng(seed + index * 7919)
  let hex = ''
  while (hex.length < 8) hex += Math.floor(rng.next() * 16).toString(16)
  return `${prefix}_${hex.slice(0, 8)}`
}

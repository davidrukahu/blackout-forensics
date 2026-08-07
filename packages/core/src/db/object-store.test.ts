// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Object-store unit tests. No database, so these run in the default suite.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'

import { FileObjectStore, sha256Hex, verifySample } from './object-store.js'

const roots: string[] = []
const store = (): FileObjectStore => {
  const root = mkdtempSync(join(tmpdir(), 'bf-os-'))
  roots.push(root)
  return new FileObjectStore(root)
}
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

describe('sample verification terminates', () => {
  // This regressed once: the original sampler drew until N distinct keys appeared, which can loop
  // forever when the sample size approaches the population — a linear congruential sequence taken
  // modulo the key count need never visit every index. It hung the integration suite with no output.
  it('terminates for every sample size up to and beyond the population', async () => {
    const s = store()
    for (let i = 0; i < 12; i++) await s.put(`payload-${i}`)

    for (const sampleSize of [1, 5, 11, 12, 13, 100]) {
      const report = await verifySample(s, { sampleSize, seed: 3 })
      expect(report.sampled).toBe(Math.min(sampleSize, 12))
      expect(report.verified).toBe(report.sampled)
    }
  })

  it('terminates for any seed and any sample size', async () => {
    const s = store()
    for (let i = 0; i < 8; i++) await s.put(`p-${i}`)

    await fc.assert(
      fc.asyncProperty(fc.integer(), fc.integer({ min: 1, max: 40 }), async (seed, sampleSize) => {
        const report = await verifySample(s, { sampleSize, seed })
        return report.sampled === Math.min(sampleSize, 8)
      }),
      { numRuns: 60 },
    )
  })

  it('reports nothing sampled for an empty store rather than looping', async () => {
    expect(await verifySample(store(), { sampleSize: 10, seed: 1 })).toEqual({
      sampled: 0, verified: 0, failures: [],
    })
  })

  it('samples the same keys for the same seed', async () => {
    const s = store()
    for (let i = 0; i < 20; i++) await s.put(`q-${i}`)
    const a = await verifySample(s, { sampleSize: 6, seed: 99 })
    const b = await verifySample(s, { sampleSize: 6, seed: 99 })
    expect(a).toEqual(b)
  })
})

describe('content addressing', () => {
  it('returns the hash of what was stored, for any payload', async () => {
    const s = store()
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 200 }), async (payload) => {
        const sha = await s.put(payload)
        return sha === sha256Hex(payload) && (await s.get(sha)).toString('utf8') === payload
      }),
      { numRuns: 80 },
    )
  })

  it('stores identical bytes once', async () => {
    const s = store()
    await s.put('same')
    await s.put('same')
    expect(await s.keys()).toHaveLength(1)
  })
})

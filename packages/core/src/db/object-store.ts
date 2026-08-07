// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Content-addressed storage for raw payloads.
 *
 * PRD §12.3 keeps raw payloads in object storage rather than unbounded database rows, and
 * NFR-DUR-001 requires hash verification on write plus periodic sample verification.
 *
 * Content addressing does most of the work: the key *is* the hash, so a payload that fails
 * verification cannot be silently swapped for another — the wrong bytes land at the wrong key.
 * What that does not catch is bit rot at rest, which is what the sample verification is for.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class IntegrityError extends Error {
  constructor(
    readonly key: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `integrity failure at ${key}: expected sha256 ${expected.slice(0, 12)}, ` +
        `stored bytes hash to ${actual.slice(0, 12)}`,
    )
    this.name = 'IntegrityError'
  }
}

export interface ObjectStore {
  /** Store bytes and return the content hash. Verifies before returning. */
  put(payload: Buffer | string): Promise<string>
  /** Read bytes by hash. Verifies before returning — a caller cannot opt out. */
  get(sha256: string): Promise<Buffer>
  has(sha256: string): Promise<boolean>
  /** Every key held, for sample verification. */
  keys(): Promise<string[]>
}

export function sha256Hex(payload: Buffer | string): string {
  return createHash('sha256').update(payload).digest('hex')
}

/**
 * Filesystem-backed store, sharded two levels deep by hash prefix.
 *
 * This is the community-profile implementation and what tests run against. An S3-compatible store
 * implements the same interface; the verification behaviour is the part that must not differ.
 */
export class FileObjectStore implements ObjectStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true })
  }

  private path(sha: string): string {
    return join(this.root, sha.slice(0, 2), sha.slice(2, 4), sha)
  }

  async put(payload: Buffer | string): Promise<string> {
    const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
    const sha = sha256Hex(bytes)
    const target = this.path(sha)

    // Already present: content-addressed, so identical bytes are already stored. Re-writing would
    // be harmless but pointless, and skipping keeps the write path idempotent.
    if (existsSync(target)) return sha

    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes)

    // Verify on write (NFR-DUR-001). A truncated write that still returns success is exactly the
    // failure this catches, and catching it now is far cheaper than discovering it at audit time.
    const readBack = sha256Hex(readFileSync(target))
    if (readBack !== sha) throw new IntegrityError(sha, sha, readBack)

    return sha
  }

  async get(sha256: string): Promise<Buffer> {
    const bytes = readFileSync(this.path(sha256))
    const actual = sha256Hex(bytes)
    if (actual !== sha256) throw new IntegrityError(sha256, sha256, actual)
    return bytes
  }

  async has(sha256: string): Promise<boolean> {
    return existsSync(this.path(sha256))
  }

  async keys(): Promise<string[]> {
    const out: string[] = []
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name))
        else out.push(entry.name)
      }
    }
    walk(this.root)
    return out.sort()
  }
}

export interface VerificationReport {
  readonly sampled: number
  readonly verified: number
  readonly failures: readonly { key: string; reason: 'missing' | 'hash_mismatch' }[]
}

/**
 * Periodic sample verification (NFR-DUR-001).
 *
 * Deterministic given a seed rather than randomly sampled, so a failing verification run can be
 * reproduced exactly — "it failed last night but passes now" is not an acceptable state for the
 * integrity of evidence.
 */
export async function verifySample(
  store: ObjectStore,
  params: { sampleSize: number; seed: number },
): Promise<VerificationReport> {
  const keys = await store.keys()
  if (keys.length === 0) return { sampled: 0, verified: 0, failures: [] }

  // A seeded permutation, not rejection sampling. Drawing until N distinct keys appear can loop
  // forever once the sample size approaches the population: a linear congruential sequence taken
  // modulo the key count need never visit every index. This shuffles once and takes a prefix, so
  // the work is bounded no matter what the caller asks for.
  const wanted = Math.min(params.sampleSize, keys.length)
  const order = [...keys]
  let cursor = params.seed >>> 0
  for (let i = order.length - 1; i > 0; i--) {
    cursor = (cursor * 1_103_515_245 + 12_345) >>> 0
    const j = cursor % (i + 1)
    ;[order[i], order[j]] = [order[j] as string, order[i] as string]
  }
  const picked = new Set(order.slice(0, wanted))

  const failures: { key: string; reason: 'missing' | 'hash_mismatch' }[] = []
  let verified = 0

  for (const key of picked) {
    if (!(await store.has(key))) {
      failures.push({ key, reason: 'missing' })
      continue
    }
    try {
      await store.get(key)
      verified += 1
    } catch {
      failures.push({ key, reason: 'hash_mismatch' })
    }
  }

  return { sampled: picked.size, verified, failures }
}

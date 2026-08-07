// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: Apache-2.0

/**
 * Conformance fixtures are the executable definition of compliance. A third party runs these
 * against their adapter output; the manifest's claims are verified, not asserted.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { validateAdapterManifest, validateCanonicalEvent } from './validate.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

const read = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'))
const jsonFiles = (dir: string): string[] =>
  readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'))

describe('conformance fixtures — valid events', () => {
  const dir = join(FIXTURES, 'events', 'valid')
  const files = jsonFiles(dir)

  it('has fixtures to run', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files)('%s validates', (file) => {
    const result = validateCanonicalEvent(read(join(dir, file)))
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
  })
})

describe('conformance fixtures — invalid events', () => {
  const dir = join(FIXTURES, 'events', 'invalid')
  const files = jsonFiles(dir)
  const reasons = read(join(dir, '_reasons.json')) as Record<string, string>

  it('documents why every invalid fixture is invalid', () => {
    for (const file of files) {
      expect(reasons[file.replace('.json', '')], file).toBeTypeOf('string')
    }
  })

  it.each(files)('%s is rejected', (file) => {
    const result = validateCanonicalEvent(read(join(dir, file)))
    expect(result.valid, `${file}: ${reasons[file.replace('.json', '')]}`).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })
})

describe('conformance fixtures — adapter manifests', () => {
  const dir = join(FIXTURES, 'manifests')

  it.each(jsonFiles(dir))('%s validates', (file) => {
    const result = validateAdapterManifest(read(join(dir, file)))
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
  })

  it('the Traccar reference manifest declares a pull reconciler, since its push path is best-effort', () => {
    const m = read(join(dir, 'traccar.json')) as {
      delivery: { push_reliability: string; pull_reconciler: boolean }
      write_time_destruction: { setting: string }[]
    }
    expect(m.delivery.push_reliability).toBe('best_effort')
    expect(m.delivery.pull_reconciler).toBe(true)
    // filter.past destroys records before storage; no export recovers them.
    expect(m.write_time_destruction.map((d) => d.setting)).toContain('filter.past')
  })
})

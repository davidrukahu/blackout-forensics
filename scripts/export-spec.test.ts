// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only


import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collect, isExportable } from './export-spec.js'

describe('public export allowlist', () => {
  it('permits the spec package files that are meant to be public', () => {
    for (const p of [
      'package.json', 'LICENSE', 'README.md',
      'src/canonical-event.ts', 'fixtures/traccar/basic.ndjson', 'schema/canonical-event.json',
    ]) expect(isExportable(p), p).toBe(true)
  })

  it('refuses anything not explicitly named — the gate fails closed', () => {
    for (const p of [
      '.env',
      'src/secret-key.pem',
      'customer-data/export.parquet',
      '../core/src/index.ts',
      'notes/pricing.md',
      '.scratch/blackout-v1/map.md',
      'src/nested/deep.ts',
    ]) expect(isExportable(p), p).toBe(false)
  })
})

describe('export gate as actually invoked', () => {
  // This gate once passed silently because the main-module check never matched — the repository
  // path contains a space. A gate that no-ops is worse than no gate, so assert it really runs.
  it('runs and prints its verdict when invoked as a CLI', () => {
    const out = execFileSync('npx', ['tsx', 'scripts/export-spec.ts'], {
      cwd: process.cwd(), encoding: 'utf8',
    })
    expect(out).toContain('allowed')
    expect(out).toContain('allowlist')
  })

  it('rejects an unexpected file placed in the spec package', () => {
    const root = mkdtempSync(join(tmpdir(), 'bf-export-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'ok.ts'), '')
    writeFileSync(join(root, 'secrets.env'), 'TOKEN=nope')
    const { allowed, rejected } = collect(root)
    expect(allowed).toContain('src/ok.ts')
    expect(rejected).toContain('secrets.env')
  })
})

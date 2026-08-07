// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Repository-wide guard: no fixture may carry a non-synthetic tenant id.
 *
 * PRD §15.4 forbids customer telemetry from entering the repository or ordinary CI. A unit test
 * covers the generator's own output; this covers everything committed, including fixtures a future
 * contributor adds by hand.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SYNTHETIC = 'synthetic_'
const SEARCH_ROOTS = ['packages']

function jsonFilesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const abs = join(d, entry)
      if (statSync(abs).isDirectory()) walk(abs)
      else if (entry.endsWith('.json') || entry.endsWith('.ndjson')) out.push(abs)
    }
  }
  walk(dir)
  return out
}

const violations: string[] = []

for (const root of SEARCH_ROOTS) {
  for (const file of jsonFilesUnder(join(process.cwd(), root))) {
    const raw = readFileSync(file, 'utf8')
    if (!raw.includes('tenant_id')) continue
    for (const match of raw.matchAll(/"tenant_id"\s*:\s*"([^"]*)"/g)) {
      const tenant = match[1] ?? ''
      if (!tenant.startsWith(SYNTHETIC)) {
        violations.push(`${file.replace(process.cwd() + '/', '')}: tenant_id "${tenant}"`)
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Non-synthetic tenant ids found in committed fixtures:')
  for (const v of violations) console.error('  ', v)
  console.error('\nPRD §15.4: customer telemetry must never enter this repository.')
  process.exit(1)
}
console.log('All committed fixtures carry synthetic tenant ids.')

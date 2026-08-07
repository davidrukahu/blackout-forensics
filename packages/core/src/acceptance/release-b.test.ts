// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Release B exit criteria, run for real.
 *
 * The suite writes the evidence pack the acceptance process signs: release-b-acceptance.json is
 * the machine record, release-b-acceptance.txt the human summary. The tests then assert the
 * verdicts — every criterion must pass, because §16.2's exit is all-or-nothing.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { runAcceptance, summarise } from './release-a.js'
import { releaseBCriteria } from './release-b.js'

const GENERATED_AT = '2026-08-08T00:00:00.000Z'

describe('Release B exit criteria', () => {
  it('runs every criterion and writes the evidence pack', async () => {
    const report = await runAcceptance(releaseBCriteria(), GENERATED_AT, 'B')

    mkdirSync(join(process.cwd(), 'release'), { recursive: true })
    writeFileSync(
      join(process.cwd(), 'release', 'release-b-acceptance.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    )
    writeFileSync(
      join(process.cwd(), 'release', 'release-b-acceptance.txt'),
      `${summarise(report)}\n`,
    )

    expect(report.release).toBe('B')
    expect(report.criteria).toHaveLength(12)
    for (const criterion of report.criteria) {
      expect(['pass', 'fail', 'not_met']).toContain(criterion.status)
      expect(criterion.evidence.length).toBeGreaterThan(0)
    }
  })

  it('meets every §17.2 detection-and-evidence item', async () => {
    const report = await runAcceptance(releaseBCriteria(), GENERATED_AT, 'B')
    const detection = report.criteria.filter((c) => Number(c.id.slice(2)) <= 6)
    expect(
      detection.map((c) => `${c.id}:${c.status}${c.status === 'pass' ? '' : ` ${c.evidence.join('; ')}`}`),
    ).toEqual(['B-1:pass', 'B-2:pass', 'B-3:pass', 'B-4:pass', 'B-5:pass', 'B-6:pass'])
  })

  it('meets every §17.3 corridor-and-maps item', async () => {
    const report = await runAcceptance(releaseBCriteria(), GENERATED_AT, 'B')
    const corridor = report.criteria.filter((c) => Number(c.id.slice(2)) >= 7)
    expect(
      corridor.map((c) => `${c.id}:${c.status}${c.status === 'pass' ? '' : ` ${c.evidence.join('; ')}`}`),
    ).toEqual(['B-7:pass', 'B-8:pass', 'B-9:pass', 'B-10:pass', 'B-11:pass', 'B-12:pass'])
  })

  it('declares Release B complete — the §16.2 exit condition', async () => {
    const report = await runAcceptance(releaseBCriteria(), GENERATED_AT, 'B')
    expect(report.complete).toBe(true)
    expect(summarise(report)).toContain('Release B exit criteria are met.')
  })
})

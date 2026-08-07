// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end dry run: the complete engagement against the synthetic corpus, as if it were a real
 * customer. Files in, aggregates computed, listing produced, bundle emitted, report rendered.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { generateBaseline, runScenario, SCENARIO_NAMES } from '@blackout/generator'
import { renderReport, type NarrativeSections } from '@blackout/core'

import { runAudit } from './pipeline.js'
import { main, parseArgs } from './cli.js'

const workDir = mkdtempSync(join(tmpdir(), 'bf-e2e-'))
afterAll(() => rmSync(workDir, { recursive: true, force: true }))

const POLICY = {
  cohort: 'default',
  intervals: { moving: 60, ignition_on: 120, parked: 300, sleep: 3600, exception: 30 },
  provenance: 'assumed' as const,
  sleepAfterStationaryS: null,
  graceFactor: 1.5,
  version: '0.1.0',
}

const BASE = {
  tenantId: 'synthetic_demo',
  tenantLabel: 'Example Asset Finance',
  source: 'traccar_forwarder',
  periodStart: '2026-08-01T00:00:00.000Z',
  periodEnd: '2026-08-31T00:00:00.000Z',
  runAt: '2026-09-01T09:00:00.000Z',
  containerVersion: '0.1.0',
  policy: POLICY,
}

/** Write a fleet large enough to clear the cohort floor, as a real audit would have. */
function writeFleet(name: string, deviceCount: number, pointCount = 30): string {
  const lines: string[] = []
  for (let i = 0; i < deviceCount; i++) {
    const { events } = generateBaseline({
      seed: 1000 + i,
      startAt: '2026-08-05T06:00:00.000Z',
      pointCount,
    })
    for (const event of events) lines.push(JSON.stringify(event))
  }
  const path = join(workDir, `${name}.ndjson`)
  writeFileSync(path, lines.join('\n'))
  return path
}

describe('end-to-end audit run', () => {
  it('turns a fleet of batch files into a publishable bundle', async () => {
    const file = writeFleet('fleet', 40)
    const result = await runAudit({ ...BASE, files: [file] })

    expect(result.observationCount).toBeGreaterThan(1000)
    expect(result.quarantinedCount).toBe(0)
    expect(result.emit.violations).toEqual([])
    expect(result.emit.ok).toBe(true)
  })

  it('emits a bundle with no coordinates, identifiers or row-level records', async () => {
    const file = writeFleet('privacy', 40)
    const result = await runAudit({ ...BASE, files: [file] })
    const serialized = JSON.stringify(result.emit.bundle)

    expect(serialized).not.toMatch(/-1\.\d{4}/)      // Nairobi latitudes
    expect(serialized).not.toMatch(/36\.\d{4}/)      // Nairobi longitudes
    expect(serialized).not.toContain('device_ref')
    expect(serialized).not.toContain('asset_ref')
    expect(serialized).not.toContain('raw_sha256')
    expect(serialized).not.toContain('event_identity')
  })

  it('suppresses a fleet too small to publish, rather than exposing it', async () => {
    // Three devices cannot clear a cohort floor of 25, so the completeness rows are withheld
    // entirely. An audit on a fleet this size returns findings, not tables.
    const file = writeFleet('tiny', 3)
    const result = await runAudit({ ...BASE, files: [file] })

    expect(result.emit.ok).toBe(true)
    expect(result.emit.suppressedRows).toBeGreaterThan(0)
    expect((result.emit.bundle?.sections['completeness'] as unknown[]).length).toBe(0)
  })

  it('carries every measure a report needs', async () => {
    const file = writeFleet('measures', 40)
    const { emit } = await runAudit({ ...BASE, files: [file] })
    const sections = emit.bundle!.sections

    for (const name of [
      'completeness', 'timing', 'integrity', 'episodes', 'assignments', 'platform_configuration',
    ]) {
      expect(sections, name).toHaveProperty(name)
    }
    expect((sections['timing'] as { total_lag_s: { p95: number } }).total_lag_s.p95).toBeGreaterThan(0)
  })

  it('surfaces platform configuration findings the telemetry cannot show', async () => {
    const file = writeFleet('config', 40)
    const { emit } = await runAudit({
      ...BASE,
      files: [file],
      destructiveSettings: [
        {
          source: 'traccar', setting: 'filter.past',
          effect: 'discards positions older than the threshold before storage',
          enabled: true, defaultEnabled: false,
        },
      ],
      retention: [{ source: 'traccar', rawDays: 30, customerReducible: true, requestedDays: 90 }],
    })

    const config = emit.bundle!.sections['platform_configuration'] as {
      blocking_findings: string[]
      destructive_settings: unknown[]
    }
    expect(config.destructive_settings).toHaveLength(1)
    expect(config.blocking_findings.join(' ')).toContain('filter.past')
    expect(config.blocking_findings.join(' ')).toContain('30')
  })

  it('handles every reference scenario without quarantining a row', async () => {
    for (const name of SCENARIO_NAMES) {
      const { events } = runScenario(name, { seed: 77, startAt: '2026-08-05T06:00:00.000Z' })
      const path = join(workDir, `${name}.ndjson`)
      writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n'))

      const result = await runAudit({ ...BASE, files: [path] })
      expect(result.quarantinedCount, name).toBe(0)
      expect(result.emit.violations, name).toEqual([])
    }
  })

  it('produces a report from the bundle', async () => {
    const file = writeFleet('report', 40)
    const { emit } = await runAudit({ ...BASE, files: [file] })

    const narrative: NarrativeSections = {
      dataRights: [{ text: 'Raw export rights evidenced in the platform agreement.', status: 'observed' }],
      reportingPolicyGaps: [
        { text: 'No sleep configuration was supplied, so every episode carries a weak basis.', status: 'observed' },
      ],
      baselineFeasibility: [{ text: 'A timeout baseline is computable over the period.', status: 'observed' }],
      recommendation: [{ text: 'Proceed once sleep configuration is archived.', status: 'observed' }],
    }

    const html = renderReport({
      bundle: emit.bundle!,
      narrative,
      recommendation: 'proceed_with_conditions',
      customerName: 'Example Asset Finance',
      preparedBy: 'Blackout Forensics',
      preparedAt: '2026-09-01',
    })

    expect(html).toContain('Telemetry Control Audit')
    expect(html).toContain('completeness')
    // The report inherits the bundle's safety: nothing sensitive can appear because nothing
    // sensitive reached the bundle.
    expect(html).not.toMatch(/-1\.\d{4}/)
  })
})

describe('the CLI separates computing from releasing', () => {
  it('parses arguments without reading a clock', () => {
    const args = parseArgs([
      'run', 'a.ndjson', 'b.csv', '--tenant-id', 'synthetic_demo',
      '--period-start', '2026-08-01T00:00:00.000Z', '--period-end', '2026-08-31T00:00:00.000Z',
      '--run-at', '2026-09-01T09:00:00.000Z', '--out', '/tmp/out',
    ])
    expect(args.command).toBe('run')
    expect(args.files).toEqual(['a.ndjson', 'b.csv'])
    expect(args.tenantId).toBe('synthetic_demo')
    expect(args.runAt).toBe('2026-09-01T09:00:00.000Z')
  })

  it('prints help rather than guessing when arguments are missing', async () => {
    let out = ''
    const code = await main(['run'], (s) => { out += s })
    expect(code).toBe(2)
    expect(out).toContain('Missing required arguments')
  })

  it('writes a contents listing alongside the bundle, and says nothing was transmitted', async () => {
    const file = writeFleet('cli', 40)
    const outDir = join(workDir, 'cli-out')
    let out = ''

    const code = await main(
      [
        'run', file, '--tenant-id', 'synthetic_demo', '--tenant-label', 'Example',
        '--source', 'traccar_forwarder',
        '--period-start', '2026-08-01T00:00:00.000Z', '--period-end', '2026-08-31T00:00:00.000Z',
        '--run-at', '2026-09-01T09:00:00.000Z', '--out', outDir,
      ],
      (s) => { out += s },
    )

    expect(code).toBe(0)
    expect(out).toContain('CONTENTS LISTING')
    expect(out).toContain('Nothing has been transmitted')
    expect(existsSync(join(outDir, 'CONTENTS.txt'))).toBe(true)
    expect(existsSync(join(outDir, 'findings-bundle.json'))).toBe(true)

    const listing = readFileSync(join(outDir, 'CONTENTS.txt'), 'utf8')
    expect(listing).toContain('thresholds')
    expect(listing).toContain('completeness')
  })

  it('describes itself as making no network connections', async () => {
    let out = ''
    await main([], (s) => { out += s })
    expect(out).toContain('makes no network connections')
  })
})

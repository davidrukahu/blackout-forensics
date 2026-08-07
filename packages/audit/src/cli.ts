// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The audit container's entrypoint.
 *
 * Two phases, deliberately separated by a human:
 *
 *   1. `run`     — read the customer's telemetry, compute aggregates, write a *contents listing*
 *                  and hold the bundle. Nothing has left yet.
 *   2. `release` — after the customer has read the listing, write the bundle to disk.
 *
 * The separation is the point. The customer sees a complete inventory of what would leave their
 * environment before any of it does, and approval is an explicit act rather than a default.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { serializeBundle } from '@blackout/core'
import type { ReportingPolicyRecord } from '@blackout/core'

import { runAudit } from './pipeline.js'

export const CONTAINER_VERSION = '0.1.0'

interface CliArgs {
  readonly command: 'run' | 'release' | 'help'
  readonly files: string[]
  readonly out: string
  readonly tenantId: string
  readonly tenantLabel: string
  readonly source: string
  readonly periodStart: string
  readonly periodEnd: string
  readonly runAt: string
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const [command = 'help', ...rest] = argv
  const flags = new Map<string, string>()
  const files: string[] = []

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string
    if (token.startsWith('--')) {
      flags.set(token.slice(2), rest[i + 1] ?? '')
      i += 1
    } else {
      files.push(token)
    }
  }

  return {
    command: command === 'run' || command === 'release' ? command : 'help',
    files,
    out: flags.get('out') ?? './audit-output',
    tenantId: flags.get('tenant-id') ?? '',
    tenantLabel: flags.get('tenant-label') ?? 'customer',
    source: flags.get('source') ?? 'unknown',
    periodStart: flags.get('period-start') ?? '',
    periodEnd: flags.get('period-end') ?? '',
    // Supplied rather than read from the clock, so a run reproduces exactly.
    runAt: flags.get('run-at') ?? '',
  }
}

const DEFAULT_POLICY: ReportingPolicyRecord = {
  cohort: 'default',
  intervals: { moving: 60, ignition_on: 120, parked: 300, sleep: 3600, exception: 30 },
  // Nothing was declared, so nothing is claimed. Episodes derived from this carry a weak basis and
  // cannot support an urgent classification.
  provenance: 'assumed',
  sleepAfterStationaryS: null,
  graceFactor: 1.5,
  version: '0.1.0-default',
}

export const HELP = `blackout-audit ${CONTAINER_VERSION}

  blackout-audit run <files...> --tenant-id <id> --period-start <iso> --period-end <iso> \\
                    --run-at <iso> [--source <name>] [--tenant-label <label>] [--out <dir>]

    Reads your telemetry, computes aggregates, and writes a CONTENTS LISTING describing exactly
    what a findings bundle would contain. Nothing leaves your environment in this phase.

  blackout-audit release --out <dir>

    Writes the findings bundle to disk, after you have read the listing.

This container makes no network connections. It reads the files you give it and writes only to the
output directory. The bundle contains aggregate measures only: no coordinates at any precision, no
row-level records, and no device, SIM or asset identifiers.
`

export async function main(argv: readonly string[], stdout: (s: string) => void): Promise<number> {
  const args = parseArgs(argv)

  if (args.command === 'help') {
    stdout(HELP)
    return 0
  }

  if (args.command === 'release') {
    stdout(
      'Release is a separate, deliberate step. Re-run with the bundle produced by `run`, after ' +
        'reading the contents listing.\n',
    )
    return 0
  }

  const missing = (['tenantId', 'periodStart', 'periodEnd', 'runAt'] as const).filter(
    (k) => args[k] === '',
  )
  if (missing.length > 0 || args.files.length === 0) {
    stdout(`Missing required arguments: ${[...missing, ...(args.files.length === 0 ? ['files'] : [])].join(', ')}\n\n${HELP}`)
    return 2
  }

  const result = await runAudit({
    files: args.files.map((f) => resolve(f)),
    tenantId: args.tenantId,
    tenantLabel: args.tenantLabel,
    source: args.source,
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    runAt: args.runAt,
    containerVersion: CONTAINER_VERSION,
    policy: DEFAULT_POLICY,
  })

  stdout(`Read ${result.observationCount} observation(s) from ${args.files.length} file(s).\n`)
  if (result.quarantinedCount > 0) {
    stdout(`${result.quarantinedCount} row(s) quarantined. See the diagnostic output.\n`)
  }

  stdout('\nCONTENTS LISTING — everything the bundle would contain:\n')
  for (const line of result.emit.contentsListing) stdout(`  ${line}\n`)

  if (!result.emit.ok) {
    stdout(`\nREFUSING TO PRODUCE A BUNDLE — ${result.emit.violations.length} redaction check(s) failed:\n`)
    for (const v of result.emit.violations.slice(0, 20)) {
      stdout(`  ${v.code} at ${v.path}: ${v.detail}\n`)
    }
    stdout('\nNo bundle was written. This is a defect in the container, not in your data.\n')
    return 1
  }

  mkdirSync(args.out, { recursive: true })
  const bundlePath = join(args.out, 'findings-bundle.json')
  const listingPath = join(args.out, 'CONTENTS.txt')

  mkdirSync(dirname(bundlePath), { recursive: true })
  writeFileSync(listingPath, `${result.emit.contentsListing.join('\n')}\n`)
  writeFileSync(bundlePath, serializeBundle(result.emit.bundle!))

  stdout(`\nContents listing written to ${listingPath}\n`)
  stdout(`Findings bundle written to ${bundlePath}\n`)
  stdout('\nRead the listing before sending the bundle. Nothing has been transmitted.\n')
  return 0
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  main(process.argv.slice(2), (s) => process.stdout.write(s))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      // Never echo the offending data: a crash message must be as safe as a rejection code.
      process.stderr.write(`audit failed: ${error instanceof Error ? error.name : 'unknown error'}\n`)
      process.exit(1)
    })
}

// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The v1 acceptance evidence pack — every PRD §17 item with linked, reproducible evidence.
 *
 *   npx tsx scripts/acceptance-pack.ts
 *
 * Each item names its evidence: a committed artifact (hashed here), a test file (the reproducer),
 * or both. Items that are genuinely not met say so with what remains — §1.3's "technically
 * complete" declaration is only worth making if the pack can also say "except these, and here is
 * why". The script fails if any referenced artifact or test file does not exist: an evidence
 * pack with dead links is worse than none.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface Item {
  readonly section: string
  readonly requirement: string
  readonly status: 'met' | 'not_met' | 'external'
  readonly evidence: readonly string[]
  readonly outstanding?: string
}

const ITEMS: readonly Item[] = [
  // ---- 17.1 Data and integration
  {
    section: '17.1', requirement: 'Two adapters are forensics-ready and one is recovery-ready',
    status: 'not_met',
    evidence: ['release/release-a-acceptance.json', 'packages/connectors/src/traccar'],
    outstanding:
      'One adapter (Traccar) is built and live-rig tested. The second forensics-ready adapter and the recovery-ready designation need a pilot vendor commitment — tracked for the pilot, not claimable now.',
  },
  {
    section: '17.1', requirement: 'Every canonical event has tenant, source, device reference, receipt time, event ID, raw hash and adapter version',
    status: 'met', evidence: ['packages/spec/src', 'packages/core/src/normalize/normalizer.ts', 'release/release-a-acceptance.json'],
  },
  {
    section: '17.1', requirement: 'Missing fields remain missing',
    status: 'met', evidence: ['packages/core/src/rules/facts.ts', 'packages/core/src/analysers/quality.ts'],
  },
  {
    section: '17.1', requirement: 'Duplicate, late and replay behaviour is measured and documented',
    status: 'met', evidence: ['packages/core/src/db/stores.int.test.ts', 'packages/core/src/replay/replay.test.ts', 'packages/generator/src/scenarios.ts'],
  },
  {
    section: '17.1', requirement: 'Effective assignment and policy changes reproduce past behaviour correctly',
    status: 'met', evidence: ['packages/core/src/assignments.ts', 'packages/core/src/reporting-policy.ts', 'packages/core/src/temporal.ts'],
  },
  {
    section: '17.1', requirement: 'Open data has source, licence, snapshot, checksum and attribution metadata',
    status: 'met', evidence: ['packages/core/src/geo/snapshot.ts', 'release/release-b-acceptance.json'],
  },
  // ---- 17.2 Detection and evidence (all six proven by the Release B suite)
  ...([
    'Every reference blackout opens, revises and closes at the expected boundaries',
    'Normal sleep and approved maintenance do not become actionable cases',
    'Source-wide failure suppresses inappropriate individual tamper escalation',
    'Every non-unknown hypothesis shows evidence, counterevidence, missing evidence and rule version',
    'Weak OpenCellID evidence cannot independently create an urgent case',
    'No output states borrower intent or a carrier-confirmed outage without qualifying evidence',
  ] as const).map((requirement) => ({
    section: '17.2', requirement, status: 'met' as const,
    evidence: ['release/release-b-acceptance.json', 'packages/core/src/acceptance/release-b.ts'],
  })),
  // ---- 17.3 Corridor and maps (all six proven by the Release B suite)
  ...([
    'Map snapshot and routing profile are versioned',
    'Ambiguous paths are withheld',
    'Corridor outputs use "possible corridor"',
    'Exposure denominators are present',
    'OSM and OpenCellID attribution appears wherever applicable',
    'Map results have a complete text and table alternative',
  ] as const).map((requirement) => ({
    section: '17.3', requirement, status: 'met' as const,
    evidence: ['release/release-b-acceptance.json', 'packages/core/src/geo/corridor.ts'],
  })),
  // ---- 17.4 Workflow and reports
  {
    section: '17.4', requirement: 'Analyst decisions, overrides and approvals are attributed and immutable',
    status: 'met', evidence: ['packages/core/src/episodes/lifecycle.ts', 'packages/core/src/db/episode-store.int.test.ts', 'release/release-c-e2e.json'],
  },
  {
    section: '17.4', requirement: 'Maker-checker cannot be bypassed through UI, API or replay',
    status: 'met', evidence: ['packages/core/src/queue/decisions.test.ts', 'packages/app/src/routes/decisions.test.ts'],
  },
  {
    section: '17.4', requirement: 'The product cannot immobilize, message, dispatch, repossess or change credit state',
    status: 'met', evidence: ['packages/core/src/queue/outcomes.test.ts', 'release/release-c-e2e.json'],
  },
  {
    section: '17.4', requirement: 'Outcomes use the controlled taxonomy and can remain unresolved',
    status: 'met', evidence: ['packages/core/src/queue/outcomes.ts', 'packages/core/src/queue/outcomes.test.ts'],
  },
  {
    section: '17.4', requirement: 'Counts reconcile to source snapshots and all denominators and exclusions are visible',
    status: 'met', evidence: ['packages/core/src/reporting/sla.ts', 'packages/core/src/analysers/distribution.ts'],
  },
  {
    section: '17.4', requirement: 'Report content and manifest hashes reproduce',
    status: 'met', evidence: ['packages/core/src/reporting/sla.test.ts', 'release/release-c-e2e.json'],
  },
  // ---- 17.5 Security, privacy and operations
  {
    section: '17.5', requirement: 'Cross-tenant read, write, export and background-job tests pass',
    status: 'met', evidence: ['packages/core/src/db/rls.int.test.ts', 'packages/core/src/security/asvs.int.test.ts'],
  },
  {
    section: '17.5', requirement: 'Production services do not use owner or RLS-bypass roles',
    status: 'met', evidence: ['packages/core/src/db/schema.sql', 'documentation/operator.md'],
  },
  {
    section: '17.5', requirement: 'Exact location and identifiers do not appear in logs, metrics or safe support bundles',
    status: 'met', evidence: ['packages/core/src/security/support-bundle.ts', 'release/security-verification.json'],
  },
  {
    section: '17.5', requirement: 'DPA, DPIA, retention, transfer and human-authority boundaries are approved before live use',
    status: 'external',
    evidence: ['documentation/dpo.md'],
    outstanding:
      'Legal approvals are the customer\'s and counsel\'s act, per deployment. The technical substrate (retention automation, holds, tombstones, human-authority controls) is built and tested; the approvals themselves cannot be produced by this repository.',
  },
  {
    section: '17.5', requirement: 'Backup restore and disaster-recovery exercises pass',
    status: 'met', evidence: ['release/dr-exercise.json', 'packages/core/src/dr/restore-exercise.int.test.ts'],
  },
  {
    section: '17.5', requirement: 'The approved application-security control profile passes',
    status: 'met', evidence: ['release/security-verification.json', 'packages/core/src/security/asvs.int.test.ts'],
  },
  {
    section: '17.5', requirement: 'Signed artifacts, SBOM and third-party notices are complete',
    status: 'met', evidence: ['release/RELEASE.json', 'release/RELEASE.json.sig', 'release/app-sbom.spdx.json', 'release/THIRD_PARTY_NOTICES.txt', 'scripts/release.ts'],
  },
  // ---- 17.6 Documentation and maintainability
  {
    section: '17.6', requirement: 'User, supervisor, administrator, integration and privacy guides are complete',
    status: 'met', evidence: ['documentation/README.md', 'documentation/administrator.md', 'documentation/dpo.md', 'documentation/operator.md'],
  },
  {
    section: '17.6', requirement: 'API, schemas, migrations and conformance fixtures are published',
    status: 'met', evidence: ['packages/spec', 'scripts/export-spec.ts', 'documentation/README.md'],
  },
  {
    section: '17.6', requirement: 'Architecture decisions and threat model are current',
    status: 'met', evidence: ['docs/adr', 'documentation/threat-model.md'],
  },
  {
    section: '17.6', requirement: 'Upgrade, rollback, restore, incident and data-deletion runbooks are tested',
    status: 'met', evidence: ['documentation/runbooks.md', 'packages/core/src/dr/restore-exercise.int.test.ts', 'packages/core/src/db/retention.int.test.ts'],
  },
  {
    section: '17.6', requirement: 'A new engineer can run the synthetic end-to-end demonstration from documented steps',
    status: 'met', evidence: ['documentation/developer.md', 'packages/app/src/release-c.e2e.test.ts'],
  },
]

// ---- verify every evidence link exists, hash artifacts
const root = process.cwd()
const dead: string[] = []
const hashes: Record<string, string> = {}
for (const item of ITEMS) {
  for (const ref of item.evidence) {
    const path = join(root, ref)
    if (!existsSync(path)) {
      dead.push(`${item.section} "${item.requirement}": ${ref}`)
    } else if (ref.startsWith('release/')) {
      hashes[ref] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
}
if (dead.length > 0) {
  console.error('dead evidence links:')
  for (const link of dead) console.error(' ', link)
  process.exit(1)
}

const met = ITEMS.filter((item) => item.status === 'met').length
const notMet = ITEMS.filter((item) => item.status === 'not_met')
const external = ITEMS.filter((item) => item.status === 'external')

const pack = {
  title: 'Blackout Forensics v1 acceptance evidence pack (PRD §17)',
  generatedAt: new Date().toISOString(),
  summary: {
    total: ITEMS.length,
    met,
    not_met: notMet.length,
    external: external.length,
  },
  declaration:
    notMet.length === 0
      ? 'Every §17 item is met or externally owned; v1 is technically complete per §1.3.'
      : `v1 is technically complete per §1.3 EXCEPT the ${notMet.length} item(s) listed under not_met, each with what remains stated. §15.5 gates on the named items, not on rounded-up claims.`,
  items: ITEMS,
  artifactHashes: hashes,
}

writeFileSync(join(root, 'release', 'v1-acceptance-pack.json'), `${JSON.stringify(pack, null, 2)}\n`)

const md = [
  `# ${pack.title}`,
  '',
  `${met}/${ITEMS.length} met, ${notMet.length} not met, ${external.length} externally owned.`,
  '',
  pack.declaration,
  '',
  ...['17.1', '17.2', '17.3', '17.4', '17.5', '17.6'].flatMap((section) => [
    `## §${section}`,
    '',
    ...ITEMS.filter((item) => item.section === section).map(
      (item) =>
        `- **[${item.status.toUpperCase()}]** ${item.requirement}\n  - evidence: ${item.evidence.join(', ')}${
          item.outstanding !== undefined ? `\n  - outstanding: ${item.outstanding}` : ''
        }`,
    ),
    '',
  ]),
]
writeFileSync(join(root, 'release', 'v1-acceptance-pack.md'), `${md.join('\n')}\n`)

console.log(`v1 acceptance pack: ${met}/${ITEMS.length} met, ${notMet.length} not met, ${external.length} external`)
for (const item of [...notMet, ...external]) {
  console.log(`  [${item.status}] §${item.section} ${item.requirement}`)
}

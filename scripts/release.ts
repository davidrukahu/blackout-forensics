// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The release pipeline — one command from working tree to signed, verifiable release.
 *
 *   npx tsx scripts/release.ts
 *
 * Order matters and every step can fail the release:
 *
 *   1. SBOM regeneration (npm sbom, production dependencies only).
 *   2. The licence gate (FR-ADM-004): an unapproved or undeclared licence exits non-zero —
 *      a release cannot ship with an unexplained dependency (§15.5).
 *   3. Manifest assembly: version, git commit, and the sha256 of every evidence artifact —
 *      SBOMs, notices, acceptance packs, security verification, DR exercise, benchmark, a11y
 *      review — plus the upgrade-package section for the self-hosted profile.
 *   4. SSH signature over the manifest, verified immediately against allowed_signers. An
 *      unverifiable release is a failed release, not a shipped one with a TODO.
 *
 * Reproducibility note, stated rather than implied: npm sbom and the manifest are deterministic
 * for a given lockfile and tree; the container image build is digest-pinned but not yet fully
 * reproducible byte-for-byte (base image timestamps). RELEASE.json says which is which.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const releaseDir = join(root, 'release')

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd: root, encoding: 'utf8' })
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

console.log('1/4 SBOM...')
const sbom = run('npm', ['sbom', '--sbom-format', 'spdx', '--omit', 'dev'])
writeFileSync(join(releaseDir, 'app-sbom.spdx.json'), sbom)

console.log('2/4 licence gate...')
run('npx', ['tsx', 'scripts/check-licences.ts'])

console.log('3/4 manifest...')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
const commit = run('git', ['rev-parse', 'HEAD']).trim()

const EVIDENCE = [
  'app-sbom.spdx.json',
  'audit-container-sbom.spdx.json',
  'THIRD_PARTY_NOTICES.txt',
  'release-a-acceptance.json',
  'release-b-acceptance.json',
  'release-c-e2e.json',
  'security-verification.json',
  'dr-exercise.json',
  'benchmark-smoke.json',
  'a11y-review.json',
  'v1-acceptance-pack.json',
  'pilot-dry-run.json',
] as const

const evidence: Record<string, string> = {}
const missing: string[] = []
for (const name of EVIDENCE) {
  const path = join(releaseDir, name)
  if (!existsSync(path)) missing.push(name)
  else evidence[name] = sha256File(path)
}
if (missing.length > 0) {
  console.error(`missing evidence artifact(s): ${missing.join(', ')}`)
  console.error('A release without its evidence pack is a build, not a release (§15.5).')
  process.exit(1)
}

// Preserve the audit-container section from the existing manifest: the image is rebuilt by its
// own script, and its identity must not be silently re-asserted here without a rebuild.
const previous = existsSync(join(releaseDir, 'RELEASE.json'))
  ? (JSON.parse(readFileSync(join(releaseDir, 'RELEASE.json'), 'utf8')) as Record<string, unknown>)
  : {}

const manifest = {
  artifact: 'blackout-forensics',
  version: pkg.version,
  commit,
  generatedAt: new Date().toISOString(),
  evidence,
  audit_container: ((): unknown => {
    // Both manifest generations: the original audit-only shape kept these at top level.
    const nested = (previous as { audit_container?: Record<string, unknown> }).audit_container
    const source = nested ?? previous
    return {
      image_id: (source as { image_id?: string }).image_id ?? null,
      base_image: (source as { base_image?: string }).base_image ?? null,
      verified: (source as { verified?: unknown }).verified ?? null,
    }
  })(),
  upgrade_package: {
    profile: 'self-hosted-container',
    contents: [
      'container image (digest-pinned base)',
      'packages/core/src/db/schema.sql — idempotent, re-runnable migration',
      'documentation/runbooks.md §1 (upgrade) and §2 (rollback)',
      'this manifest and its signature',
    ],
    apply: 'documentation/runbooks.md — verify signature before applying anything',
  },
  reproducibility: {
    sbom: 'deterministic for a given package-lock.json',
    manifest: 'deterministic for a given tree and evidence set',
    container_image: 'digest-pinned base; NOT byte-for-byte reproducible yet (base image timestamps)',
  },
  notes: [
    'Image signing with cosign is NOT done — this manifest is SSH-signed, binding the image id and every evidence hash to a verifiable key.',
    'Verify with: ssh-keygen -Y verify -f release/allowed_signers -I drukahu09@gmail.com -n file -s release/RELEASE.json.sig < release/RELEASE.json',
  ],
}
writeFileSync(join(releaseDir, 'RELEASE.json'), `${JSON.stringify(manifest, null, 2)}\n`)

console.log('4/4 sign and verify...')
try {
  // ssh-keygen prompts rather than overwriting an existing signature; a hung prompt in a
  // pipeline is a stale signature waiting to be verified. Remove first.
  rmSync(join(releaseDir, 'RELEASE.json.sig'), { force: true })
  run('ssh-keygen', [
    '-Y', 'sign', '-f', join(process.env['HOME'] ?? '', '.ssh/id_ed25519'),
    '-n', 'file', join(releaseDir, 'RELEASE.json'),
  ])
  // ssh-keygen writes RELEASE.json.sig alongside.
  execFileSync('sh', ['-c',
    `ssh-keygen -Y verify -f release/allowed_signers -I drukahu09@gmail.com -n file ` +
    `-s release/RELEASE.json.sig < release/RELEASE.json`,
  ], { cwd: root, encoding: 'utf8' })
  console.log('signed and verified against allowed_signers')
} catch (error) {
  console.error('signing or verification failed — an unverifiable release is a failed release:')
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}

console.log(`release ${pkg.version} @ ${commit.slice(0, 12)} complete`)

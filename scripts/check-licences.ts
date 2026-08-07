// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Release licence gate — FR-ADM-004.
 *
 * The release pipeline must fail when notice or approved licence metadata is missing. This is not
 * hygiene: the product's commercial tier depends on being able to state, accurately, what is inside
 * a shipped artefact. An unexplained dependency in the SBOM blocks a release (§15.5).
 *
 * A copyleft dependency reaching the shipped container would also be a licence event in its own
 * right, so the allow-list is permissive-only plus this project's own AGPL packages.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Licences a shipped dependency may carry. Anything else needs a human decision. */
const APPROVED = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'MIT-0',
  'Python-2.0',
  // This project's own packages.
  'AGPL-3.0-only',
])

interface SpdxPackage {
  name?: string
  versionInfo?: string
  licenseDeclared?: string
  licenseConcluded?: string
}

const sbomPath = process.argv[2] ?? join(process.cwd(), 'release', 'app-sbom.spdx.json')
const noticesPath = process.argv[3] ?? join(process.cwd(), 'release', 'THIRD_PARTY_NOTICES.txt')

const sbom = JSON.parse(readFileSync(sbomPath, 'utf8')) as { packages?: SpdxPackage[] }
const packages = sbom.packages ?? []

if (packages.length === 0) {
  console.error(`No packages found in ${sbomPath} — refusing to certify an empty SBOM.`)
  process.exit(1)
}

const unapproved: string[] = []
const unknown: string[] = []
const lines: string[] = [
  'THIRD-PARTY NOTICES',
  '',
  'This artefact includes the following third-party packages. Licence text for each is available',
  'from the package itself and from its published metadata.',
  '',
]

for (const pkg of [...packages].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))) {
  const licence = pkg.licenseDeclared ?? pkg.licenseConcluded ?? 'NOASSERTION'
  const name = `${pkg.name ?? 'unknown'}@${pkg.versionInfo ?? 'unknown'}`

  if (licence === 'NOASSERTION' || licence === '') unknown.push(name)
  else if (!APPROVED.has(licence)) unapproved.push(`${name} — ${licence}`)

  lines.push(`${name}  ${licence}`)
}

writeFileSync(noticesPath, `${lines.join('\n')}\n`)

if (unapproved.length > 0) {
  console.error(`Unapproved licence(s) in ${unapproved.length} shipped package(s):`)
  for (const u of unapproved) console.error('  ', u)
  console.error('\nEach needs an explicit decision before release (§15.5).')
  process.exit(1)
}

if (unknown.length > 0) {
  // The root workspace package legitimately declares no licence to npm; anything else is a gap.
  const external = unknown.filter((u) => !u.startsWith('blackout-forensics@'))
  if (external.length > 0) {
    console.error(`Undeclared licence in ${external.length} shipped package(s):`)
    for (const u of external) console.error('  ', u)
    console.error('\nAn unexplained dependency blocks a release (§15.5).')
    process.exit(1)
  }
}

console.log(`Licence gate passed: ${packages.length} package(s), notices written to ${noticesPath}`)

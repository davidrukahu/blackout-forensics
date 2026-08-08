// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only


/**
 * Export packages/spec to the public blackout-spec repository.
 *
 * The allowlist is a gate, not a convention: a published git history cannot be withdrawn, so
 * nothing may be exported that is not named here. See
 * .scratch/blackout-v1/issues/08-repo-layout-and-contributor-licensing.md
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Only paths matching these patterns may ever reach the public repository. */
export const EXPORT_ALLOWLIST: readonly RegExp[] = [
  /^package\.json$/,
  /^tsconfig\.json$/,
  /^LICENSE$/,
  /^README\.md$/,
  /^src\/[\w.-]+\.ts$/,
  /^fixtures\/[\w./-]+$/,
  /^schema\/[\w./-]+\.json$/,
  /^media\/[\w.-]+\.svg$/,
]

export function isExportable(relPath: string): boolean {
  const p = relPath.split(sep).join('/')
  return EXPORT_ALLOWLIST.some((rx) => rx.test(p))
}

export function collect(root: string): { allowed: string[]; rejected: string[] } {
  const allowed: string[] = []
  const rejected: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      // Build artefacts are not source and never reach the public repository.
      if (entry === 'node_modules' || entry === 'dist' || entry.endsWith('.tsbuildinfo')) continue
      const abs = join(dir, entry)
      if (statSync(abs).isDirectory()) walk(abs)
      else {
        const rel = relative(root, abs)
        ;(isExportable(rel) ? allowed : rejected).push(rel.split(sep).join('/'))
      }
    }
  }
  walk(root)
  return { allowed, rejected }
}

// NB: pathToFileURL, not string interpolation — the repository path contains a space, and an
// unencoded `file://` URL silently fails to match, which would make this gate a no-op.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  const root = join(process.cwd(), 'packages', 'spec')
  const { allowed, rejected } = collect(root)
  console.log(`allowed (${allowed.length}):`)
  for (const f of allowed) console.log('  ', f)
  if (rejected.length > 0) {
    console.error(`\nREFUSING TO EXPORT — ${rejected.length} file(s) not on the allowlist:`)
    for (const f of rejected) console.error('  ', f)
    process.exit(1)
  }
  console.log('\nAll files pass the allowlist. Export is safe.')
}

/**
 * Build a clean public tree containing only allowlisted files.
 *
 * The public repository gets generated history — it is never a filtered copy of the private one,
 * because a filtered history can still leak through reflogs, tags and merge parents.
 */
export function buildPublicTree(specRoot: string, dest: string): string[] {
  const { allowed, rejected } = collect(specRoot)
  if (rejected.length > 0) {
    throw new Error(`refusing to publish: ${rejected.length} file(s) off the allowlist`)
  }
  rmSync(dest, { recursive: true, force: true })
  for (const rel of allowed) {
    const target = join(dest, rel)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(specRoot, rel), target)
  }
  return allowed
}

// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fetch and verify an OSM extract.
 *
 * PRD §13.3 forbids bundling country data extracts into source releases and requires fetch,
 * checksum, attribution and build scripts instead. This is that script.
 *
 * It writes the extract and a snapshot manifest to a working directory that is gitignored. Nothing
 * it downloads is ever committed: an extract in the repository would be redistribution, which
 * carries obligations a source release should not silently take on.
 *
 *   npx tsx scripts/fetch-osm.ts https://download.geofabrik.de/africa/kenya-latest.osm.pbf ./map-data
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const OSM_ATTRIBUTION = '© OpenStreetMap contributors, licensed under ODbL 1.0'

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`fetch failed: ${response.status} ${response.statusText}`)
  return Buffer.from(await response.arrayBuffer())
}

async function publishedMd5(url: string): Promise<string | undefined> {
  // Geofabrik publishes a sibling .md5 for every extract. Absence is a finding, not a default to
  // shrug at: an extract nobody can verify against the publisher is an unverified extract.
  try {
    const response = await fetch(`${url}.md5`)
    if (!response.ok) return undefined
    return (await response.text()).trim().split(/\s+/)[0]
  } catch {
    return undefined
  }
}

async function main(): Promise<number> {
  const [url, outDir = './map-data'] = process.argv.slice(2)
  if (url === undefined) {
    console.error('usage: tsx scripts/fetch-osm.ts <extract-url> [output-dir]')
    return 2
  }

  mkdirSync(outDir, { recursive: true })
  console.log(`fetching ${url}`)

  const bytes = await download(url)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const md5 = createHash('md5').update(bytes).digest('hex')
  const expectedMd5 = await publishedMd5(url)

  if (expectedMd5 !== undefined && expectedMd5 !== md5) {
    console.error(`checksum mismatch: publisher says ${expectedMd5}, downloaded bytes are ${md5}`)
    console.error('refusing to write an extract that is not the one the publisher describes.')
    return 1
  }

  const filename = basename(new URL(url).pathname)
  writeFileSync(join(outDir, filename), bytes)

  const manifest = {
    source_url: url,
    licence: 'ODbL-1.0',
    // Extract date comes from the filename where Geofabrik encodes it, otherwise it must be
    // supplied by hand — guessing it would put a wrong version on every piece of evidence derived
    // from this snapshot.
    extract_date: /(\d{6})/.exec(filename)?.[1] ?? null,
    sha256,
    md5,
    publisher_md5: expectedMd5 ?? null,
    publisher_md5_verified: expectedMd5 !== undefined,
    attribution: OSM_ATTRIBUTION,
    byte_length: bytes.byteLength,
  }
  writeFileSync(join(outDir, `${filename}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(`wrote ${filename} (${(bytes.byteLength / 1e6).toFixed(1)} MB)`)
  console.log(`sha256 ${sha256}`)
  if (expectedMd5 === undefined) {
    console.warn('WARNING: no published checksum was available. Record this before activating the snapshot.')
  }
  if (manifest.extract_date === null) {
    console.warn('WARNING: extract date not derivable from the filename. Supply it before activating.')
  }
  return 0
}

main().then((code) => process.exit(code)).catch((error: unknown) => {
  console.error(`fetch failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  process.exit(1)
})

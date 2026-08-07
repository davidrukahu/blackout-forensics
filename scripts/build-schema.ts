// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/** Emit the published JSON Schema artefacts consumed by adapter authors. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ADAPTER_MANIFEST_SCHEMA, CANONICAL_EVENT_SCHEMA } from '../packages/spec/src/index.js'

const out = join(process.cwd(), 'packages', 'spec', 'schema')
mkdirSync(out, { recursive: true })

for (const [file, schema] of [
  ['canonical-event.json', CANONICAL_EVENT_SCHEMA],
  ['adapter-manifest.json', ADAPTER_MANIFEST_SCHEMA],
] as const) {
  writeFileSync(join(out, file), `${JSON.stringify(schema, null, 2)}\n`)
  console.log('wrote', join('packages', 'spec', 'schema', file))
}

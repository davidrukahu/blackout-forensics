// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    // Resolve workspace packages to SOURCE, not to dist. Without this, `npm run test` silently
    // runs against the last build: an edit could appear to fail, or worse, appear to pass.
    alias: {
      '@blackout/spec': pkg('spec'),
      '@blackout/core': pkg('core'),
      '@blackout/connectors': pkg('connectors'),
      '@blackout/generator': pkg('generator'),
      '@blackout/audit': pkg('audit'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
  },
})

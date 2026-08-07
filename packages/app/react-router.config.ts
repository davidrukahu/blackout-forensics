// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

import type { Config } from '@react-router/dev/config'

export default {
  // Server-rendered throughout (§13.1). Every screen works before JavaScript arrives.
  ssr: true,
  // Route modules live in src/ like every other package, not a framework-special app/ directory.
  appDirectory: 'src',
} satisfies Config

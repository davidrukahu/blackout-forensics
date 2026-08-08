// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

import { index, route, type RouteConfig } from '@react-router/dev/routes'

export default [
  // The dashboard is the homepage; /metrics stays as a redirect so old links keep working.
  index('routes/metrics.tsx'),
  route('metrics', 'routes/home.tsx'),
  route('queue', 'routes/queue.tsx'),
  route('cases/:id', 'routes/case.tsx'),
] satisfies RouteConfig

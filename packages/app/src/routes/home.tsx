// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/** Legacy path: the dashboard moved to the homepage; /metrics keeps working. */

import { redirect } from 'react-router'

export function loader() {
  return redirect('/')
}

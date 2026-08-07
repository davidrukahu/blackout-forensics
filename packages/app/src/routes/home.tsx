// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from 'react-router'

export function loader() {
  return redirect('/queue')
}

// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Application shell.
 *
 * Server-rendered (§13.1): every screen works before JavaScript arrives, and the shell carries
 * the accessibility groundwork the acceptance gate requires — a skip link, a landmark structure,
 * and an explicit statement of the timezone every timestamp is rendered in (§12.5).
 */

import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, useRouteError } from 'react-router'

import './styles.css'

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Blackout Forensics</title>
        <Meta />
        <Links />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <header className="app-header">
          <span className="app-name">Blackout Forensics</span>
          <span className="app-tz" aria-label="All times are shown in UTC">
            times in UTC
          </span>
        </header>
        <main id="main">{children}</main>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

export default function Root() {
  return <Outlet />
}

export function ErrorBoundary() {
  const error = useRouteError()
  if (isRouteErrorResponse(error)) {
    return (
      <section aria-labelledby="error-heading">
        <h1 id="error-heading">
          {error.status} {error.statusText}
        </h1>
        <p>{typeof error.data === 'string' ? error.data : 'The request could not be completed.'}</p>
      </section>
    )
  }
  return (
    <section aria-labelledby="error-heading">
      <h1 id="error-heading">Something went wrong</h1>
      <p>The error has been recorded. No partial result is shown, because a partial screen is indistinguishable from a complete one.</p>
    </section>
  )
}

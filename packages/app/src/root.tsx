// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Application shell — shadcn-admin composition: sticky header with brand, primary nav and the
 * theme toggle, content in a centred container. Server-rendered (§13.1): every screen works
 * before JavaScript arrives, and the accessibility groundwork lives here — skip link, landmark
 * structure, and the explicit statement that every timestamp renders in UTC (§12.5).
 */

import {
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
} from 'react-router'

import { ThemeToggle } from './components/theme-toggle.js'
import { cn } from './lib/utils.js'

import './tailwind.css'

/** Applies the stored or OS-preferred theme before first paint — no flash, no hydration drift. */
const THEME_SCRIPT = `try{var t=localStorage.getItem('bf-theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch(e){}`

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Blackout Forensics</title>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <Meta />
        <Links />
      </head>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <a className="skip-link" href="#main">
          Skip to the main content
        </a>
        <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-6">
            <span className="flex items-center gap-2 font-semibold tracking-tight">
              <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                <rect x="3" y="12" width="3" height="7" rx="1" className="fill-foreground" />
                <rect x="8" y="8" width="3" height="11" rx="1" className="fill-foreground" />
                <rect x="13" y="10" width="3" height="9" rx="1" className="fill-muted-foreground/40" />
                <rect x="18" y="5" width="3" height="14" rx="1" className="fill-foreground" />
              </svg>
              Blackout Forensics
            </span>
            <nav className="flex items-center gap-1 text-sm" aria-label="Primary">
              {[
                { to: '/', label: 'Dashboard' },
                { to: '/queue', label: 'Queue' },
              ].map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) =>
                    cn(
                      'rounded-md px-3 py-1.5 transition-colors hover:bg-accent hover:text-accent-foreground',
                      isActive ? 'bg-secondary font-medium text-secondary-foreground' : 'text-muted-foreground',
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-3">
              <span className="text-xs text-muted-foreground">All times are in UTC</span>
              <ThemeToggle />
            </div>
          </div>
        </header>
        <main id="main" className="mx-auto max-w-6xl px-6 py-6">
          {children}
        </main>
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
  const known = isRouteErrorResponse(error)
  return (
    <section aria-labelledby="error-heading" className="mx-auto max-w-md py-16 text-center">
      <h1 id="error-heading" className="text-2xl font-bold tracking-tight">
        {known ? `${error.status} ${error.statusText}` : 'An error occurred'}
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        {known && typeof error.data === 'string'
          ? error.data
          : 'The system recorded the error. The system does not show a partial result.'}
      </p>
    </section>
  )
}

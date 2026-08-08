// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Dark-mode toggle. Progressive enhancement: the inline script in root.tsx applies the stored
 * (or OS-preferred) theme before first paint, so there is no flash and no hydration mismatch;
 * this button is the JavaScript-era refinement on top.
 */

import { Moon, Sun } from 'lucide-react'

import { Button } from './ui/button.js'

export function ThemeToggle() {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Set dark mode on or off"
      onClick={() => {
        const dark = document.documentElement.classList.toggle('dark')
        try {
          localStorage.setItem('bf-theme', dark ? 'dark' : 'light')
        } catch {
          // Storage unavailable (private mode): the toggle still works for this page view.
        }
      }}
    >
      <Sun className="h-4 w-4 dark:hidden" />
      <Moon className="hidden h-4 w-4 dark:block" />
    </Button>
  )
}

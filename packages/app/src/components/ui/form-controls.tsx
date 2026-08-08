// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * shadcn-styled native form controls. Deliberately NOT the Radix-based shadcn Select/Checkbox:
 * every mutation in this app is a plain form POST that works before JavaScript arrives, so the
 * controls must be real <input>/<select> elements — styled to the same token set.
 */

import { cn } from '../../lib/utils.js'

export function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors',
        'placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
        className,
      )}
      {...props}
    />
  )
}

export function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors',
        'focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
        className,
      )}
      {...props}
    />
  )
}

export function Checkbox({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type="checkbox"
      className={cn('size-4 shrink-0 rounded-sm border-input accent-primary', className)}
      {...props}
    />
  )
}

export function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return <label className={cn('flex flex-col gap-1.5 text-sm font-medium', className)} {...props} />
}

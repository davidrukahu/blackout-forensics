// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Route-level authorization, deny by default (§11.1).
 *
 * Until the OIDC task lands this resolves a development identity, but the *structure* is the
 * production one: every loader and action calls `requireUser` with the scopes it needs, and a
 * missing scope is a 403 — not a hidden button. Data-layer functions re-check on their own
 * (authorization is enforced twice), so an added route cannot widen access by omission.
 */

export interface AppUser {
  readonly actor: string
  readonly role: 'analyst' | 'supervisor' | 'administrator'
  readonly scopes: readonly string[]
}

const ROLE_SCOPES: Readonly<Record<AppUser['role'], readonly string[]>> = {
  analyst: ['queue:read', 'queue:assign', 'case:read', 'case:propose'],
  supervisor: ['queue:read', 'queue:assign', 'case:read', 'case:propose', 'case:approve'],
  administrator: ['queue:read', 'case:read', 'admin:manage'],
}

/** Development identity. The OIDC session replaces this function body, not its callers. */
function resolveUser(request: Request): AppUser | null {
  const cookie = request.headers.get('cookie') ?? ''
  const match = /bf-role=(analyst|supervisor|administrator)/.exec(cookie)
  const role = (match?.[1] as AppUser['role'] | undefined) ?? 'analyst'
  return { actor: `dev:${role}`, role, scopes: ROLE_SCOPES[role] }
}

export function requireUser(request: Request, neededScopes: readonly string[]): AppUser {
  const user = resolveUser(request)
  if (user === null) {
    throw new Response('Sign in required', { status: 401 })
  }
  const missing = neededScopes.filter((scope) => !user.scopes.includes(scope))
  if (missing.length > 0) {
    // The refusal names what was missing: a silent 404 here would make authorization failures
    // indistinguishable from broken links, and §11.1 asks for deny — not disguise.
    throw new Response(`Missing scope: ${missing.join(', ')}`, { status: 403 })
  }
  return user
}

// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Route-level authorization, deny by default (§11.1).
 *
 * Sessions flow through the identity domain: the OIDC provider authenticates, and the domain
 * enforces what a provider will happily get wrong for us — registered individual accounts, MFA
 * present at sign-in, service accounts never opening sessions, and the exact-location scope
 * absent from every standing role (§3.3: it arrives only through a two-person elevation grant).
 *
 * The development identity below is a stand-in OIDC token, not a bypass: it passes through the
 * same accountFromClaims policy the production callback uses.
 */

import {
  MemoryAccountRegistry,
  accountFromClaims,
  issueSession,
  sessionActive,
} from '@blackout/core'

export interface AppUser {
  readonly actor: string
  readonly role: 'analyst' | 'supervisor' | 'administrator'
  readonly scopes: readonly string[]
}

const ROLE_SCOPES: Readonly<Record<AppUser['role'], readonly string[]>> = {
  analyst: ['queue:read', 'queue:assign', 'case:read', 'case:propose'],
  supervisor: ['queue:read', 'queue:assign', 'case:read', 'case:propose', 'case:approve'],
  // Deliberately absent from every role: the exact-location scope. §3.3 — it exists only as a
  // two-person elevation grant, and no standing role carries it.
  administrator: ['queue:read', 'case:read', 'admin:manage'],
}

const REGISTRY = new MemoryAccountRegistry()
for (const [role, person] of [
  ['analyst', 'Achieng Odhiambo'],
  ['supervisor', 'Baraka Mwangi'],
  ['administrator', 'Chao Kilonzo'],
] as const) {
  REGISTRY.register({
    subject: `dev-sub-${role}`,
    kind: 'human',
    displayName: person,
    roles: [role],
  })
}

/** Development identity: a stand-in verified OIDC token. Production replaces the claims source. */
function resolveUser(request: Request): AppUser | null {
  const cookie = request.headers.get('cookie') ?? ''
  const match = /bf-role=(analyst|supervisor|administrator)/.exec(cookie)
  const role = (match?.[1] as AppUser['role'] | undefined) ?? 'analyst'

  const account = accountFromClaims(
    { sub: `dev-sub-${role}`, amr: ['pwd', 'otp'] },
    REGISTRY,
  )
  const now = new Date().toISOString()
  const session = issueSession({ account, scopes: ROLE_SCOPES[role], now })
  if (!sessionActive(session, now)) return null
  return { actor: `dev:${role}`, role, scopes: session.scopes }
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

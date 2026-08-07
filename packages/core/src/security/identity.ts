// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Identity, sessions, elevation and key operations — PRD §11.1 and §3.3.
 *
 * The customer runs this container against their own OIDC provider; what lives here is the
 * policy the provider cannot enforce for us:
 *
 *   * **No shared human accounts.** A human account is one subject, one person, MFA-verified at
 *     sign-in. Service accounts are named, non-interactive, and cannot open browser sessions.
 *   * **Privileged sessions are short.** Elevation is just-in-time, scoped, expiring in minutes,
 *     and never outlives its justification.
 *   * **Location access cannot be self-granted** (§3.3). The elevation for exact-location scopes
 *     requires a different approver, and the grant itself is an audited role change — a platform
 *     administrator holds the keys to the room, not to the filing cabinets inside it.
 *   * **Break-glass exists and is loud.** Emergency access works with one person at 03:00 — and
 *     produces a mandatory review record, expires fast, and cannot be made quiet.
 */

import { LOCATION_SCOPE } from '../api/episodes.js'

export interface OidcClaims {
  readonly sub: string
  readonly email?: string
  /** Authentication methods references — must contain an MFA factor for humans. */
  readonly amr?: readonly string[]
  readonly groups?: readonly string[]
}

export type AccountKind = 'human' | 'service'

export interface Account {
  readonly subject: string
  readonly kind: AccountKind
  readonly displayName: string
  readonly roles: readonly string[]
}

export class SharedAccountError extends Error {
  constructor(detail: string) {
    super(`shared accounts are prohibited (§11.1): ${detail}`)
    this.name = 'SharedAccountError'
  }
}

export class MfaRequiredError extends Error {
  constructor(readonly subject: string) {
    super(`human sign-in for ${subject} carries no MFA factor (amr): refused`)
    this.name = 'MfaRequiredError'
  }
}

const MFA_FACTORS = ['mfa', 'otp', 'hwk', 'swk', 'fido', 'webauthn']
const SHARED_NAME_PATTERN = /shared|team|admin@|ops@|group|generic|common/i

/**
 * Map verified OIDC claims to an account. The token signature is the provider's job; the parts
 * a provider will happily get wrong for us — MFA presence, shared-looking identities — are ours.
 */
export function accountFromClaims(claims: OidcClaims, registry: AccountRegistry): Account {
  const known = registry.bySubject(claims.sub)
  if (known === undefined) {
    throw new SharedAccountError(`subject ${claims.sub} is not a registered individual account`)
  }
  if (known.kind === 'human') {
    const amr = claims.amr ?? []
    if (!amr.some((factor) => MFA_FACTORS.includes(factor.toLowerCase()))) {
      throw new MfaRequiredError(claims.sub)
    }
  }
  return known
}

export interface AccountRegistry {
  bySubject(subject: string): Account | undefined
}

export class MemoryAccountRegistry implements AccountRegistry {
  private readonly accounts = new Map<string, Account>()

  register(account: Account): void {
    if (SHARED_NAME_PATTERN.test(account.displayName) && account.kind === 'human') {
      throw new SharedAccountError(
        `"${account.displayName}" names a group, not a person. Human accounts are individuals.`,
      )
    }
    if (this.accounts.has(account.subject)) {
      throw new SharedAccountError(`subject ${account.subject} is already registered`)
    }
    this.accounts.set(account.subject, account)
  }

  bySubject(subject: string): Account | undefined {
    return this.accounts.get(subject)
  }
}

// ------------------------------------------------------------------ sessions

export const STANDARD_SESSION_S = 8 * 3600
/** Privileged sessions are short (§11.1). Fifteen minutes, then re-elevate. */
export const PRIVILEGED_SESSION_S = 15 * 60
export const BREAK_GLASS_SESSION_S = 30 * 60

export interface Session {
  readonly subject: string
  readonly scopes: readonly string[]
  readonly issuedAt: string
  readonly expiresAt: string
  readonly privileged: boolean
  readonly elevationId: string | null
}

export function issueSession(params: {
  readonly account: Account
  readonly scopes: readonly string[]
  readonly now: string
  readonly elevation?: ElevationGrant
}): Session {
  if (params.account.kind === 'service') {
    throw new SharedAccountError('service accounts are non-interactive: no browser session')
  }
  const privileged = params.elevation !== undefined
  const ttl = privileged ? PRIVILEGED_SESSION_S : STANDARD_SESSION_S
  return {
    subject: params.account.subject,
    scopes: privileged
      ? [...params.scopes, ...(params.elevation as ElevationGrant).scopes]
      : params.scopes,
    issuedAt: params.now,
    expiresAt: new Date(Date.parse(params.now) + ttl * 1000).toISOString(),
    privileged,
    elevationId: params.elevation?.id ?? null,
  }
}

export function sessionActive(session: Session, now: string): boolean {
  return Date.parse(now) < Date.parse(session.expiresAt)
}

// ------------------------------------------------------------------ elevation (§3.3)

/** Scopes that always demand a second person to grant. */
export const TWO_PERSON_SCOPES: readonly string[] = [LOCATION_SCOPE, 'admin:roles', 'export:raw']

export interface ElevationGrant {
  readonly id: string
  readonly subject: string
  readonly scopes: readonly string[]
  readonly justification: string
  readonly approvedBy: string | null
  readonly grantedAt: string
  readonly expiresAt: string
  /** Audit record reference — the grant IS a role change, and role changes are audited. */
  readonly auditRef: string
}

export class SelfGrantError extends Error {
  constructor(readonly scope: string) {
    super(
      `${scope} cannot be self-granted (§3.3): a platform administrator holds the keys to the ` +
        'room, not to the filing cabinets inside it. A different approver must sign the grant.',
    )
    this.name = 'SelfGrantError'
  }
}

export class JustificationRequiredError extends Error {
  constructor() {
    super('elevation without a justification is a standing privilege wearing a costume')
    this.name = 'JustificationRequiredError'
  }
}

export function grantElevation(params: {
  readonly id: string
  readonly subject: string
  readonly scopes: readonly string[]
  readonly justification: string
  readonly approvedBy?: string
  readonly now: string
  readonly audit: (entry: { action: string; detail: Record<string, unknown> }) => string
}): ElevationGrant {
  if (params.justification.trim().length < 10) {
    throw new JustificationRequiredError()
  }
  for (const scope of params.scopes) {
    if (TWO_PERSON_SCOPES.includes(scope)) {
      if (params.approvedBy === undefined || params.approvedBy === params.subject) {
        throw new SelfGrantError(scope)
      }
    }
  }
  const auditRef = params.audit({
    action: 'security.elevation_granted',
    detail: {
      subject: params.subject,
      scopes: [...params.scopes],
      justification: params.justification,
      approved_by: params.approvedBy ?? null,
    },
  })
  return {
    id: params.id,
    subject: params.subject,
    scopes: params.scopes,
    justification: params.justification,
    approvedBy: params.approvedBy ?? null,
    grantedAt: params.now,
    expiresAt: new Date(Date.parse(params.now) + PRIVILEGED_SESSION_S * 1000).toISOString(),
    auditRef,
  }
}

// ------------------------------------------------------------------ break-glass

export interface BreakGlassRecord {
  readonly id: string
  readonly subject: string
  readonly reason: string
  readonly at: string
  readonly expiresAt: string
  readonly auditRef: string
  /** Filled by the mandatory post-incident review; open until then. */
  readonly reviewedBy: string | null
  readonly reviewedAt: string | null
}

/**
 * Emergency access: one person, full scopes, thirty minutes — and a record that cannot be made
 * quiet. The review is mandatory: `unreviewedBreakGlass` is a monitoring surface, not a report.
 */
export function breakGlass(params: {
  readonly id: string
  readonly subject: string
  readonly reason: string
  readonly now: string
  readonly audit: (entry: { action: string; detail: Record<string, unknown> }) => string
}): BreakGlassRecord {
  if (params.reason.trim().length < 10) {
    throw new JustificationRequiredError()
  }
  const auditRef = params.audit({
    action: 'security.break_glass',
    detail: { subject: params.subject, reason: params.reason },
  })
  return {
    id: params.id,
    subject: params.subject,
    reason: params.reason,
    at: params.now,
    expiresAt: new Date(Date.parse(params.now) + BREAK_GLASS_SESSION_S * 1000).toISOString(),
    auditRef,
    reviewedBy: null,
    reviewedAt: null,
  }
}

export function reviewBreakGlass(
  record: BreakGlassRecord,
  params: { readonly reviewedBy: string; readonly at: string },
): BreakGlassRecord {
  if (params.reviewedBy === record.subject) {
    throw new SelfGrantError('break-glass review')
  }
  return { ...record, reviewedBy: params.reviewedBy, reviewedAt: params.at }
}

export function unreviewedBreakGlass(records: readonly BreakGlassRecord[]): readonly BreakGlassRecord[] {
  return records.filter((record) => record.reviewedBy === null)
}

// ------------------------------------------------------------------ secrets and keys

export interface SecretRef {
  readonly name: string
  /** Where the value lives — env var or mounted file. The value itself never enters this type. */
  readonly source: `env:${string}` | `file:${string}`
  readonly rotatedAt: string
  readonly rotateEveryDays: number
}

export function secretsDueForRotation(
  secrets: readonly SecretRef[],
  now: string,
): readonly SecretRef[] {
  return secrets.filter(
    (secret) =>
      Date.parse(now) - Date.parse(secret.rotatedAt) > secret.rotateEveryDays * 86_400_000,
  )
}

export interface SigningKey {
  readonly keyId: string
  readonly createdAt: string
  readonly status: 'active' | 'verify_only' | 'retired'
}

export class KeyRotationError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'KeyRotationError'
  }
}

/**
 * Rotate the signing key: the old key keeps verifying what it signed (evidence outlives keys),
 * but signs nothing new. Exactly one key is ever active.
 */
export function rotateSigningKey(
  keys: readonly SigningKey[],
  next: { readonly keyId: string; readonly createdAt: string },
): readonly SigningKey[] {
  if (keys.some((key) => key.keyId === next.keyId)) {
    throw new KeyRotationError(`key id ${next.keyId} was already used; key ids never recycle`)
  }
  return [
    ...keys.map((key) =>
      key.status === 'active' ? { ...key, status: 'verify_only' as const } : key,
    ),
    { keyId: next.keyId, createdAt: next.createdAt, status: 'active' as const },
  ]
}

export function activeKey(keys: readonly SigningKey[]): SigningKey {
  const active = keys.filter((key) => key.status === 'active')
  if (active.length !== 1) {
    throw new KeyRotationError(`expected exactly one active key, found ${active.length}`)
  }
  return active[0]!
}

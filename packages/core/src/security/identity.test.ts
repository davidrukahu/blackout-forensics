// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * §11.1 and §3.3: no shared human accounts, short privileged sessions, no self-granted location
 * access, loud break-glass, rotating secrets and keys.
 */

import { describe, expect, it } from 'vitest'

import {
  BREAK_GLASS_SESSION_S,
  JustificationRequiredError,
  KeyRotationError,
  MemoryAccountRegistry,
  MfaRequiredError,
  PRIVILEGED_SESSION_S,
  STANDARD_SESSION_S,
  SelfGrantError,
  SharedAccountError,
  TWO_PERSON_SCOPES,
  accountFromClaims,
  activeKey,
  breakGlass,
  grantElevation,
  issueSession,
  reviewBreakGlass,
  rotateSigningKey,
  secretsDueForRotation,
  sessionActive,
  unreviewedBreakGlass,
  type Account,
} from './identity.js'
import { LOCATION_SCOPE } from '../api/episodes.js'

const NOW = '2026-08-08T03:00:00.000Z'

const alice: Account = {
  subject: 'sub-alice', kind: 'human', displayName: 'Alice Wanjiku', roles: ['analyst'],
}

function registry(): MemoryAccountRegistry {
  const accounts = new MemoryAccountRegistry()
  accounts.register(alice)
  accounts.register({
    subject: 'sub-svc-ingest', kind: 'service', displayName: 'svc-ingest', roles: ['ingest'],
  })
  return accounts
}

const auditLog: { action: string; detail: Record<string, unknown> }[] = []
const audit = (entry: { action: string; detail: Record<string, unknown> }): string => {
  auditLog.push(entry)
  return `audit-${auditLog.length}`
}

describe('no shared human accounts', () => {
  it('refuses group-shaped human accounts at registration', () => {
    const accounts = new MemoryAccountRegistry()
    expect(() =>
      accounts.register({
        subject: 'sub-ops', kind: 'human', displayName: 'Ops Team Shared', roles: ['analyst'],
      }),
    ).toThrow(SharedAccountError)
  })

  it('refuses duplicate subjects — one subject, one person', () => {
    const accounts = registry()
    expect(() => accounts.register(alice)).toThrow(SharedAccountError)
  })

  it('unregistered subjects do not sign in at all', () => {
    expect(() =>
      accountFromClaims({ sub: 'sub-stranger', amr: ['mfa'] }, registry()),
    ).toThrow(SharedAccountError)
  })
})

describe('MFA at sign-in', () => {
  it('a human without an MFA factor is refused; with one, admitted', () => {
    expect(() => accountFromClaims({ sub: 'sub-alice', amr: ['pwd'] }, registry())).toThrow(
      MfaRequiredError,
    )
    expect(accountFromClaims({ sub: 'sub-alice', amr: ['pwd', 'otp'] }, registry())).toEqual(alice)
  })

  it('service accounts authenticate without amr but can never open a session', () => {
    const service = accountFromClaims({ sub: 'sub-svc-ingest' }, registry())
    expect(service.kind).toBe('service')
    expect(() =>
      issueSession({ account: service, scopes: ['ingest'], now: NOW }),
    ).toThrow(SharedAccountError)
  })
})

describe('privileged sessions are short', () => {
  it('a standard session runs hours; an elevated one runs minutes', () => {
    const standard = issueSession({ account: alice, scopes: ['queue:read'], now: NOW })
    expect(Date.parse(standard.expiresAt) - Date.parse(NOW)).toBe(STANDARD_SESSION_S * 1000)

    const elevation = grantElevation({
      id: 'elev-1', subject: 'sub-alice', scopes: [LOCATION_SCOPE],
      justification: 'urgent case requires exact-location review',
      approvedBy: 'sub-bob', now: NOW, audit,
    })
    const elevated = issueSession({
      account: alice, scopes: ['queue:read'], now: NOW, elevation,
    })
    expect(Date.parse(elevated.expiresAt) - Date.parse(NOW)).toBe(PRIVILEGED_SESSION_S * 1000)
    expect(elevated.scopes).toContain(LOCATION_SCOPE)
    expect(elevated.privileged).toBe(true)
    expect(sessionActive(elevated, '2026-08-08T03:16:00.000Z')).toBe(false)
  })
})

describe('§3.3: location access is never self-granted', () => {
  it('the location scope is in the two-person list', () => {
    expect(TWO_PERSON_SCOPES).toContain(LOCATION_SCOPE)
  })

  it('self-approval and missing approval both refuse; a different approver grants, audited', () => {
    expect(() =>
      grantElevation({
        id: 'e', subject: 'sub-alice', scopes: [LOCATION_SCOPE],
        justification: 'I would like to see locations', now: NOW, audit,
      }),
    ).toThrow(SelfGrantError)
    expect(() =>
      grantElevation({
        id: 'e', subject: 'sub-alice', scopes: [LOCATION_SCOPE],
        justification: 'I would like to see locations', approvedBy: 'sub-alice', now: NOW, audit,
      }),
    ).toThrow(SelfGrantError)

    const before = auditLog.length
    const grant = grantElevation({
      id: 'e-ok', subject: 'sub-alice', scopes: [LOCATION_SCOPE],
      justification: 'case ep-9 requires exact location', approvedBy: 'sub-bob', now: NOW, audit,
    })
    expect(grant.auditRef).toBeDefined()
    expect(auditLog.length).toBe(before + 1)
    expect(auditLog.at(-1)!.action).toBe('security.elevation_granted')
  })

  it('elevation without a real justification is refused', () => {
    expect(() =>
      grantElevation({
        id: 'e', subject: 'sub-alice', scopes: ['queue:read'], justification: 'need', now: NOW, audit,
      }),
    ).toThrow(JustificationRequiredError)
  })
})

describe('break-glass is loud', () => {
  it('works with one person, expires in minutes, and stays open until a second person reviews', () => {
    const record = breakGlass({
      id: 'bg-1', subject: 'sub-alice',
      reason: 'primary approver unreachable during active incident', now: NOW, audit,
    })
    expect(Date.parse(record.expiresAt) - Date.parse(NOW)).toBe(BREAK_GLASS_SESSION_S * 1000)
    expect(auditLog.some((entry) => entry.action === 'security.break_glass')).toBe(true)
    expect(unreviewedBreakGlass([record])).toHaveLength(1)

    expect(() => reviewBreakGlass(record, { reviewedBy: 'sub-alice', at: NOW })).toThrow(
      SelfGrantError,
    )
    const reviewed = reviewBreakGlass(record, { reviewedBy: 'sub-bob', at: NOW })
    expect(unreviewedBreakGlass([reviewed])).toHaveLength(0)
  })
})

describe('secrets and keys rotate', () => {
  it('flags secrets past their rotation window', () => {
    const secrets = [
      { name: 'db-password', source: 'env:BF_DB_PASSWORD' as const, rotatedAt: '2026-05-01T00:00:00.000Z', rotateEveryDays: 90 },
      { name: 'oidc-client', source: 'file:/secrets/oidc' as const, rotatedAt: '2026-07-20T00:00:00.000Z', rotateEveryDays: 90 },
    ]
    expect(secretsDueForRotation(secrets, NOW).map((secret) => secret.name)).toEqual(['db-password'])
  })

  it('rotation keeps the old key verify-only, exactly one key active, ids never recycled', () => {
    let keys = rotateSigningKey([], { keyId: 'k1', createdAt: '2026-06-01T00:00:00.000Z' })
    keys = rotateSigningKey(keys, { keyId: 'k2', createdAt: NOW })
    expect(keys.find((key) => key.keyId === 'k1')?.status).toBe('verify_only')
    expect(activeKey(keys).keyId).toBe('k2')
    expect(() => rotateSigningKey(keys, { keyId: 'k1', createdAt: NOW })).toThrow(KeyRotationError)
  })
})

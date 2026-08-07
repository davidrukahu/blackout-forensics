<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: AGPL-3.0-only
-->

# Incident response

## First moves

1. Declare the incident and appoint a scribe; timestamps in UTC.
2. If access beyond your standing role is needed and no approver is reachable: break-glass
   (`breakGlass()` — one person, thirty minutes, audited before the session exists). The record
   stays open until a *different* person reviews it afterwards; that review is mandatory.
3. Preserve evidence before remediating: the object store is content-addressed and append-only;
   `audit.event` cannot be updated or deleted even by the app role. Do not "clean up" — nothing
   in the core tables can be silently rewritten, and that is the property that makes findings
   defensible later.

## Sharing diagnostics

Only `buildSupportBundle()` output leaves the boundary. It is allowlist-constructed and scanned
for coordinates, phone numbers, IMEIs and emails on the way out; if it throws, something tried
to smuggle a position into a safe field — that is itself a finding. Raw logs go through
`safeLogLine()` (visible `[REDACTED]` markers) before any ticket or email.

## Database compromise suspicion

- Cross-tenant reads return nothing without a `withTenant` context; verify with the probes in
  `packages/core/src/security/asvs.int.test.ts` against the live schema.
- RLS is FORCE — but a PostgreSQL **superuser bypasses it entirely**. First question in any
  compromise: did anything run as a superuser?
- Receipt payloads verify against their stored sha256 on read (`traceToReceipt`); a mismatch is
  tampering, not corruption to be shrugged at.

## Restore under pressure

Follow `RECOVERY_RUNBOOK` ([runbooks.md](runbooks.md) §3) exactly — it ends in a filed exercise
record even during a real incident, because the realized RPO/RPO numbers are the facts the
post-mortem will need.

## After

- Review any break-glass record (different person than the user).
- File the incident narrative with the §22 outcome vocabulary where it touched cases.
- If retention or holds were touched, reconcile tombstones against the plan.

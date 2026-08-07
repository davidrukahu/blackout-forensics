<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: AGPL-3.0-only
-->

# Administrator guide

## Identity and roles

Your OIDC provider authenticates; the application enforces what a provider will happily get
wrong (§11.1):

- Every human account is one registered subject, one person. Group-shaped display names and
  duplicate subjects are refused at registration; unregistered subjects cannot sign in.
- MFA is required in the `amr` claim at every human sign-in.
- Service accounts are named and non-interactive — they can never open a browser session.
- Roles carry scopes: analysts read/claim/propose, supervisors additionally approve,
  administrators manage the platform. **No standing role carries the exact-location scope** —
  including administrator.

## Elevation and §3.3

Exact-location access (`episodes:exact-location`), role administration and raw export are
two-person scopes: an elevation grant requires a justification and a *different* approver, the
grant itself is the audited role change, and the resulting session expires in fifteen minutes.
A platform administrator holds the keys to the room, not to the filing cabinets inside it.

Break-glass exists for the 03:00 incident: one person, full scopes, thirty minutes, and a
mandatory audit record written before the session exists. The record stays on the unreviewed
list until a second person reviews it — monitor `unreviewedBreakGlass()`.

## Decisions and maker-checker

High-impact decisions (suspicious classifications, field verification, recovery authorization)
require a proposer and a different approver; the proposer cannot approve their own proposal and
there is no override parameter. Machine output is advice only and can never carry a
world-affecting decision (FR-QUE-006). Reasons are canonical per decision; free text explains
but never substitutes.

## Legal holds and retention

A hold records scope (tenant, episodes, or devices), authority, start, review date and release.
While active it blocks deletion item-by-item and visibly — the retention plan lists every held
item with the hold id. Release is a one-way audited act. Retention defaults are configurable
within ceilings that are not: 35-day backup window, 180-day maximum for normalized telemetry.

## Outcomes

The §22 taxonomy is closed. OUT-RECOVERY cannot be recorded without an external authorization
reference — the product records that a separately authorized recovery happened; it never holds
the authority, and it has no verb for immobilizing, messaging, dispatching, repossessing or
changing credit state.

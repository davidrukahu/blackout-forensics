<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: LicenseRef-Proprietary
-->

# 0011. The audit is delivered as a customer-run container

- **Status:** Accepted
- **Date:** 2026-08-06
- **Source:** `.scratch/blackout-v1/map.md`

## Context

The company is starting cold: no customer, no data, no introductions. The first commercial ask is a
$3,000–$5,000 two-week Telemetry Control Audit. Asking an asset financier to export precise movement
histories of financed vehicles to an unknown vendor is close to the hardest possible opening request,
and PRD §19 lists "customer lacks export rights" among the risks that kill the engagement outright.

## Decision

Ship a signed container the customer runs inside their own environment. It reads their data locally
and emits only a redacted aggregate bundle, which they inspect and approve before release. The vendor
never receives raw telemetry, exact coordinates or identifiers.

## Consequences

Converts a legal project into an IT ticket, and is worth *more* in jurisdictions with strict
localisation (Rwanda) rather than less. It also aligns with PRD §11.2's location and identity
separation and §13.4's community single-tenant profile.

**Costs accepted:** you learn less from aggregates than from raw data; debugging a container running
in someone else's environment is harder; and the container must be small and auditable enough that a
customer's security team will actually run it — which is in tension with shipping Postgres inside it
(ADR 0003).

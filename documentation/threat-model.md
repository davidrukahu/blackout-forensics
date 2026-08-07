<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: AGPL-3.0-only
-->

# Threat model

## What an attacker would want

1. **Exact positions of financed motorcycles** — theft targeting. The system's most sensitive
   data class.
2. **Borrower identification** — coercion, harassment, data resale.
3. **Evidence tampering** — making a blackout look benign (or vice versa) to defeat a recovery
   dispute.
4. **Cross-tenant access** — one lender reading another's fleet.

## Trust boundaries

- **Vendor platforms → connectors**: untrusted input. Everything is receipted (content-addressed,
  append-only), quarantined on parse failure, and normalized with declared identity basis.
  Byte-identical resends and identity synthesis are modelled, not assumed away.
- **Application → database**: `withTenant()` is the only path; RLS with FORCE on every table
  including partitions; roles are non-superuser (`bf_app` cannot delete anything;
  `bf_retention` can delete and nothing else). Known residual: a Postgres **superuser bypasses
  RLS** — deployment must never run as one, and the schema says so where an operator will read it.
- **Analyst → world**: no path exists. The product has no verb for immobilize/message/dispatch/
  repossess/credit; world-affecting decisions need two humans; machine output is advice.
- **Operator → support channel**: bundles are allowlist-plus-scan; logs are redacted visibly.
- **This repo → public**: the export allowlist gate controls what reaches the Apache-2.0 spec;
  `check:synthetic` blocks any non-synthetic tenant id from ever being committed.

## §15.1 layers mapped to their verification

| Layer | Where proven |
| --- | --- |
| Authorization (deny by default, twice) | `packages/app/src/routes/*.test.ts`, data-layer scope checks |
| Tenant isolation | `db/rls.int.test.ts`, `security/asvs.int.test.ts` |
| Signed replay / bounded scope | `replay/replay.test.ts`, ASVS suite |
| Archive traversal | ASVS suite (object keys must be 64-hex before filesystem access) |
| Injection | ASVS suite (hostile tenant ids, refs, cursors as parameters) |
| Export/log leakage (§17.5) | `security/support-bundle.ts` + ASVS suite |
| Evidence integrity | object-store verify-on-read/write, append-only triggers, report integrity hashes |
| Maker-checker bypass (§17.4) | `queue/decisions.test.ts` + route tests |

## Assumptions

- The customer's OIDC provider is trusted for authentication; this system enforces MFA presence,
  individual accounts and scope policy on top.
- Host and container runtime integrity are the operator's boundary; the signed release and SBOM
  (`release/RELEASE.json.sig`, `release/*-sbom.spdx.json`) let them verify what they run.
- OpenCellID and OSM data are context, never decision inputs (provably: closed fact vocabulary).

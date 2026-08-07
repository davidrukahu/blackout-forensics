<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: AGPL-3.0-only
-->

# Data-protection officer guide

## What the system holds, and for how long

PRD §11.4's defaults — configurable product defaults, never represented as statutory periods:

| Data class | Default | Notes |
| --- | --- | --- |
| Rejected/quarantined payload | 14 days | shorter once diagnosis completes |
| Raw source receipt | 30 days | longer only for an approved evidence need |
| Normalized exact telemetry | 90 days | tenant-approvable to 180, never beyond |
| Minimal episode evidence subset | 24 months | only points needed to explain the episode |
| Recovery decision and outcome | 24 months | subject to customer records policy |
| SLA aggregates | 36 months | re-identification risk suppressed |
| Security/business audit metadata | 24 months | protected separately |
| Rolling backups | 35 days maximum | expire automatically |
| Map/cell snapshots | while needed for report reproduction | licence + checksum kept |

Deletion is idempotent, observable and evidenced: every deletion leaves a tombstone naming the
item, class, policy version, run id and the date after which no backup generation may contain it.
Legal holds record scope, authority, start, review and release, and block deletion visibly.

## What the system structurally cannot hold

- **Borrower identity in the analyst surface.** The queue item type has no field a borrower
  name, phone or account could occupy; a structural test scans the keys.
- **Exact location in logs, metrics or support bundles** (§17.5, FR-ADM-005). Support bundles
  are allowlist-constructed and pattern-scanned (coordinates, MSISDN, IMEI, email) — one that
  might leak throws instead of existing. Log lines route through visible redaction.
- **Cell-derived facts in classification.** The rule vocabulary contains no cell fact, so
  removing the OpenCellID layer cannot change any decision (FR-CLS-005 by construction), and
  cell evidence is inadmissible for urgent-action eligibility.
- **Customer attributes keyed on OSM feature ids.** The tenant schema bans raw geometry;
  cross-tenant learning ships as the anonymous-by-construction bundle (ADR 0009): field
  allowlist, H3 coarsening floor, small-cohort suppression, checked at emit time.

## Subject-rights support

- Data deletion runbook: [runbooks.md](runbooks.md) §5 — scoped legal-hold check, retention run
  with tombstone evidence, backup expiry date stated on the tombstone.
- Audit trail: append-only by trigger and by grant; sensitive views (case reads, exact-location
  queries) are recorded before data is returned.

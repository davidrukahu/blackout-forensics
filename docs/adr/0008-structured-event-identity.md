<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: LicenseRef-Proprietary
-->

# 0008. Event identity is a structured object, not a scalar

- **Status:** Accepted
- **Date:** 2026-08-06
- **Source:** `.scratch/blackout-v1/issues/09-canonical-schema-v0.md`, `.../01-platform-export-reality.md`

## Context

Research across eight tracking platforms found event identity to be the weakest requirement
everywhere. Teltonika Codec 8 and 8E — the dominant professional device family in the target market —
carry no record identifier or sequence number at all, and Teltonika documents byte-identical resends.
Only Queclink publishes a per-record sequence.

Identity must therefore often be synthesised by the adapter.

## Decision

The canonical event carries `event_identity: { basis, value, algorithm? }` where basis is one of
`vendor_event_id`, `vendor_sequence` or `synthesised`. When the basis is `synthesised`, the algorithm
is required. Adapters declare their identity provenance in their capability manifest.

## Consequences

Every downstream duplicate-detection, ordering and idempotency claim depends on how identity was
established. A scalar identifier would have erased that distinction silently, letting the system
assert exactly-once semantics it cannot support — which PRD FR-EPI-005 explicitly forbids.

**Cost:** every consumer of an event must handle three identity bases rather than one.

<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: LicenseRef-Proprietary
-->

# 0009. The findings bundle is anonymous by construction

- **Status:** Accepted
- **Date:** 2026-08-06
- **Source:** `.scratch/blackout-v1/issues/12-redacted-findings-bundle-format.md`, `.../03-kenya-dpa-audit-posture.md`

## Context

The audit is delivered as a customer-run container that emits a findings bundle. Research into
Kenya's Data Protection Act established that the entire legal posture turns on one property of that
bundle: if it is genuinely anonymous, the vendor is probably outside the Act; if it is merely
pseudonymised, the vendor receives personal data for its own purposes and becomes a **controller** —
strictly worse than being a processor, with no instruction defence.

Kenya publishes no k-anonymity threshold, no minimum cohort size and no spatial resolution. The
standard is outcome-based, and reg 35(d) imposes a positive duty to *test* that re-identification is
impossible.

## Decision

The bundle contains aggregate distributions, cohort comparisons and episode statistics only. **No
row-level records, no coordinates at any precision, and no device, SIM or asset identifiers — not
even pseudonymous ones.** Spatial coarsening to H3 resolution 6 as the finest permitted; temporal
coarsening to hourly minimum, daily default; cohort floor of k ≥ 25 with suppression below it.

The container runs the re-identification test itself before writing: schema allow-list validation,
cohort-floor assertion on every row, and a scanner rejecting coordinate-, IMEI-, ICCID- and
MSISDN-shaped values. It **fails closed**.

The bundle schema is a versioned first-class artefact; changing it changes the legal posture.

## Consequences

This is what makes cold-start delivery possible: it converts the hardest possible first ask — export
precise movement histories to an unknown vendor — into an IT ticket.

The thresholds are **Modeled**, not derived from published guidance, so the reasoning ships inside the
bundle manifest and must be defensible to a customer's Data Protection Officer rather than merely
implemented.

Decided once for the strictest jurisdiction (Rwanda's default localisation), so the same posture
travels to Kenya, Uganda and Tanzania unchanged.

<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: LicenseRef-Proprietary
-->

# 0003. Postgres/PostGIS as the single query engine, including inside the audit container

- **Status:** Accepted
- **Date:** 2026-08-06
- **Source:** `.scratch/blackout-v1/issues/07-language-and-framework.md`, `.../12-redacted-findings-bundle-format.md`

## Context

The Telemetry Control Audit ships as a container the customer runs in their own environment. Its
analysers compute field completeness, clock skew, delivery lag, duplicate and backfill rates over
potentially tens of millions of rows — work a columnar engine like DuckDB does far better, and which
reads Parquet natively, one of the required import formats.

But an earlier decision established that the audit tool *is* the first hard-scoped slice of
`blackout-core`, not a throwaway kit.

## Decision

Postgres with PostGIS is the only query engine. The audit container ships Postgres inside the image
and runs the identical analyser code the product runs.

A columnar engine may be introduced later as a **read-only accelerator**, and only when a measured
query fails its §12.2 target — never as a second source of truth.

## Consequences

Using a different engine in the container would have recreated the throwaway-kit split at the query
layer: analyser logic written twice, two SQL dialects, and divergence between what the audit measures
and what the product measures. That divergence is precisely what the audit exists to avoid, since the
audit's numbers become the pilot's baseline.

This also mirrors PRD §13.4's community profile, which is Docker Compose with Postgres anyway, and
follows §12.3's discipline of introducing analytical infrastructure on measured need rather than in
anticipation.

**Cost accepted:** a substantially larger container image and slower analytical scans. Image size,
startup time and security-review surface become explicit acceptance concerns for the container task.

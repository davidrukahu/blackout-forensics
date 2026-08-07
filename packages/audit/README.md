<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: AGPL-3.0-only
-->

# @blackout/audit

The Telemetry Control Audit container payload — the pipeline a customer runs inside their own
environment.

It reads their batch files, computes aggregates, and emits a findings bundle containing no
coordinates at any precision, no row-level records, and no device, SIM or asset identifiers. The
vendor never receives raw telemetry.

## Two phases, separated by a human

    blackout-audit run <files...> --tenant-id <id> --period-start <iso> --period-end <iso> --run-at <iso>

Writes a **contents listing** describing exactly what a bundle would contain, and the bundle itself,
to the output directory. Nothing is transmitted. The customer reads the listing before sending
anything — approval is an explicit act, not a default.

The container makes no network connections. It reads the files it is given and writes only to the
output directory.

## What happens on a small fleet

A fleet below the cohort floor produces an audit made of **findings rather than tables**: every
aggregate section is suppressed, and the report carries the platform-configuration and data-rights
findings instead. That is a real outcome, not a failure — and it is why the engagement is worth its
fee even when the platform cannot proceed to a pilot.

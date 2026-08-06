<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: LicenseRef-Proprietary
-->

# 0010. No map data ships inside the audit container

- **Status:** Accepted
- **Date:** 2026-08-06
- **Source:** `.scratch/blackout-v1/issues/32-osm-snapshot-and-map-data-strategy.md`, `.../04-open-data-licence-obligations.md`

## Context

Research into ODbL and CC BY-SA obligations found that they trigger when data leaves your
organisation — and handing a container image to a customer is exactly that. Anything baked into the
image is distributed, which defeats ODbL §4.5's internal-use exemption and brings mandatory notices
and a possible §4.6 offer.

Separately, enriching OSM features with customer-derived attributes — a "risk score per OSM way"
table — is the shape the Horizontal Map Layers guideline treats as a Derivative Database, which would
oblige publishing it.

## Decision

The audit container ships no map data. It performs no corridor work, so it needs none. Product
deployments fetch map extracts at install time via scripts rather than receiving them in an image.

Tenant tables store **only** an internal surrogate segment key and an H3 cell — never an OSM
identifier, never OSM geometry. The mapping from surrogate key to OSM way lives in an isolated
`osm_snapshot` schema. OSM and OpenCellID never share a derived database, since ODbL and CC BY-SA 4.0
are incompatible copylefts.

## Consequences

The distribution exposure is dissolved rather than managed, and the prohibition on OSM-keyed customer
attributes is enforced by the absence of a column rather than by a coding rule someone must remember.

Four questions remain for specialist IP counsel before corridor projection is built, including
whether the container counts as public distribution at all and whether raw OSM way identifiers become
substantial at fleet scale.

<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: LicenseRef-Proprietary
-->

# 0007. CLA on the AGPL core, DCO on the Apache packages

- **Status:** Accepted
- **Date:** 2026-08-06
- **Source:** `.scratch/blackout-v1/issues/08-repo-layout-and-contributor-licensing.md`

## Context

The business plan prices an AGPL-free commercial licence for private deployment at a $75,000 annual
minimum. PRD §13.2 states that dual licensing requires the project steward to own or hold relicensing
rights over every core contribution.

## Decision

An individual and corporate Contributor Licence Agreement, with express sublicensing and patent
grant, for contributions to `packages/core` and `packages/app` (AGPL-3.0-only). DCO sign-off for
`packages/spec`, `packages/connectors` and `packages/sdk` (Apache-2.0).

The CLA texts in `cla/` are drafts pending legal review and are **not yet in force**; until that
review completes, external contributions to the core cannot be accepted.

## Consequences

Without relicensing rights the commercial tier cannot be granted, and retrofitting a CLA means
chasing every past contributor — which in practice fails. Keeping the Apache packages on DCO means
the repository that exists to be adopted stays low-friction.

**Cost accepted:** a CLA visibly deters casual contributors, which is a real tax on a project whose
acquisition channel is open-source credibility.

**Prerequisite outside this repository:** the steward's own employment agreement must leave them
owning this work, or none of the above holds.

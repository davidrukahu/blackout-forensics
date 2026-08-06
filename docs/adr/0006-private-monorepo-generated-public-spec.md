<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: LicenseRef-Proprietary
-->

# 0006. Private monorepo with a generated public spec repository

- **Status:** Accepted
- **Date:** 2026-08-06
- **Source:** `.scratch/blackout-v1/issues/08-repo-layout-and-contributor-licensing.md`

## Context

PRD §20.1 names five repositories with different licences. But only `blackout-spec` is public
initially — the analyser stays private until after the first paid audit — and the canonical schema
will churn hardest during Release A, exactly when cross-repository friction costs most.

## Decision

One private monorepo holding core, connectors, SDK, app and docs, with licence boundaries expressed
as per-directory LICENSE files and per-file SPDX headers rather than as repository boundaries.
`reuse lint` is a hard CI gate.

`blackout-spec` is published to a separate public repository by an automated export with clean
generated history, gated by an explicit allowlist test.

## Consequences

Five repositories means five CI pipelines and five release processes for one person, and every schema
change during Release A would need coordinated pull requests across two of them. Expressing the
licence boundary in SPDX headers is stricter than expressing it in repository structure, because it
is machine-checked and survives files moving between directories.

**Cost accepted:** the export tooling is a leak risk and must be correct the first time — a published
git history cannot be withdrawn. Hence the allowlist as a gate that fails closed, not a convention.

An early bug proved the point: the gate silently passed without running, because the repository path
contains a space and an unencoded `file://` URL never matched. A gate that no-ops is worse than no
gate, so the CLI invocation is now itself under test.

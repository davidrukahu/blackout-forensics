<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: AGPL-3.0-only
-->

# Contributing

## Which agreement applies to you

The licence boundary is not cosmetic — it is what makes the project's commercial tier possible, and
it is enforced in CI.

| Package | Licence | What you sign |
|---|---|---|
| `packages/spec` | Apache-2.0 | DCO sign-off (`git commit -s`) |
| `packages/connectors` | Apache-2.0 | DCO sign-off |
| `packages/sdk` | Apache-2.0 | DCO sign-off |
| `packages/core` | AGPL-3.0-only | Contributor Licence Agreement |
| `packages/app` | AGPL-3.0-only | Contributor Licence Agreement |

The CLA texts in `cla/` are **drafts pending legal review** and are not yet in force. Until that
review completes, external contributions to `core` and `app` cannot be accepted.

## Every file carries an SPDX header

`npm run lint:licences` runs `reuse lint` and fails the build if a file lacks a header or carries the
wrong licence. A header-less file's licence cannot be established retroactively, which is why this
is a gate rather than a guideline.

## Never commit customer data

No customer telemetry, borrower data, exact tracks, credentials or private vendor fixtures enter this
repository — including in tests, issues and support bundles (PRD §15.4). Use the synthetic generator.
Every synthetic tenant id is prefixed `synthetic_` and CI asserts it.

## Commits are signed

    git config gpg.format ssh
    git config user.signingkey ~/.ssh/id_ed25519.pub
    git config commit.gpgsign true

## Before you push

    npm run check          # typecheck + tests
    npm run lint:licences  # SPDX headers
    npm run export:spec    # public-export allowlist

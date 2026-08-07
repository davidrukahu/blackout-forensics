<!--
SPDX-FileCopyrightText: 2026 David Rukahu
SPDX-License-Identifier: AGPL-3.0-only
-->

# Blackout Forensics documentation

Vendor-neutral telemetry-evidence and recovery-control system for financed motorcycles. This set
covers PRD §16.4 and §17.6.

| Audience | Document |
| --- | --- |
| Operators (run the container) | [operator.md](operator.md) |
| Administrators (roles, holds, retention) | [administrator.md](administrator.md) |
| Developers (build, test, extend) | [developer.md](developer.md) |
| Data-protection officers | [dpo.md](dpo.md) |
| Incident responders | [incident-response.md](incident-response.md) |
| Everyone touching production | [runbooks.md](runbooks.md) |
| Security reviewers | [threat-model.md](threat-model.md) |

Architecture decisions live in [`docs/adr/`](../docs/adr/) — eleven records, from TypeScript on
Node 24 through customer-run container delivery. The public interoperability spec (Apache-2.0,
JSON Schemas and conformance fixtures) is generated from this repository by `npm run export:spec`
and published at <https://github.com/davidrukahu/blackout-spec>.

Every claim in these documents is backed by a test or a committed artifact in [`release/`](../release/).
Where something is *not* done — a human screen-reader review, the reference-tier benchmark — the
artifact says so rather than rounding up.

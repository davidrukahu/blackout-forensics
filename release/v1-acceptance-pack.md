# Blackout Forensics v1 acceptance evidence pack (PRD §17)

34/36 met, 1 not met, 1 externally owned.

v1 is technically complete per §1.3 EXCEPT the 1 item(s) listed under not_met, each with what remains stated. §15.5 gates on the named items, not on rounded-up claims.

## §17.1

- **[NOT_MET]** Two adapters are forensics-ready and one is recovery-ready
  - evidence: release/release-a-acceptance.json, packages/connectors/src/traccar
  - outstanding: One adapter (Traccar) is built and live-rig tested. The second forensics-ready adapter and the recovery-ready designation need a pilot vendor commitment — tracked for the pilot, not claimable now.
- **[MET]** Every canonical event has tenant, source, device reference, receipt time, event ID, raw hash and adapter version
  - evidence: packages/spec/src, packages/core/src/normalize/normalizer.ts, release/release-a-acceptance.json
- **[MET]** Missing fields remain missing
  - evidence: packages/core/src/rules/facts.ts, packages/core/src/analysers/quality.ts
- **[MET]** Duplicate, late and replay behaviour is measured and documented
  - evidence: packages/core/src/db/stores.int.test.ts, packages/core/src/replay/replay.test.ts, packages/generator/src/scenarios.ts
- **[MET]** Effective assignment and policy changes reproduce past behaviour correctly
  - evidence: packages/core/src/assignments.ts, packages/core/src/reporting-policy.ts, packages/core/src/temporal.ts
- **[MET]** Open data has source, licence, snapshot, checksum and attribution metadata
  - evidence: packages/core/src/geo/snapshot.ts, release/release-b-acceptance.json

## §17.2

- **[MET]** Every reference blackout opens, revises and closes at the expected boundaries
  - evidence: release/release-b-acceptance.json, packages/core/src/acceptance/release-b.ts
- **[MET]** Normal sleep and approved maintenance do not become actionable cases
  - evidence: release/release-b-acceptance.json, packages/core/src/acceptance/release-b.ts
- **[MET]** Source-wide failure suppresses inappropriate individual tamper escalation
  - evidence: release/release-b-acceptance.json, packages/core/src/acceptance/release-b.ts
- **[MET]** Every non-unknown hypothesis shows evidence, counterevidence, missing evidence and rule version
  - evidence: release/release-b-acceptance.json, packages/core/src/acceptance/release-b.ts
- **[MET]** Weak OpenCellID evidence cannot independently create an urgent case
  - evidence: release/release-b-acceptance.json, packages/core/src/acceptance/release-b.ts
- **[MET]** No output states borrower intent or a carrier-confirmed outage without qualifying evidence
  - evidence: release/release-b-acceptance.json, packages/core/src/acceptance/release-b.ts

## §17.3

- **[MET]** Map snapshot and routing profile are versioned
  - evidence: release/release-b-acceptance.json, packages/core/src/geo/corridor.ts
- **[MET]** Ambiguous paths are withheld
  - evidence: release/release-b-acceptance.json, packages/core/src/geo/corridor.ts
- **[MET]** Corridor outputs use "possible corridor"
  - evidence: release/release-b-acceptance.json, packages/core/src/geo/corridor.ts
- **[MET]** Exposure denominators are present
  - evidence: release/release-b-acceptance.json, packages/core/src/geo/corridor.ts
- **[MET]** OSM and OpenCellID attribution appears wherever applicable
  - evidence: release/release-b-acceptance.json, packages/core/src/geo/corridor.ts
- **[MET]** Map results have a complete text and table alternative
  - evidence: release/release-b-acceptance.json, packages/core/src/geo/corridor.ts

## §17.4

- **[MET]** Analyst decisions, overrides and approvals are attributed and immutable
  - evidence: packages/core/src/episodes/lifecycle.ts, packages/core/src/db/episode-store.int.test.ts, release/release-c-e2e.json
- **[MET]** Maker-checker cannot be bypassed through UI, API or replay
  - evidence: packages/core/src/queue/decisions.test.ts, packages/app/src/routes/decisions.test.ts
- **[MET]** The product cannot immobilize, message, dispatch, repossess or change credit state
  - evidence: packages/core/src/queue/outcomes.test.ts, release/release-c-e2e.json
- **[MET]** Outcomes use the controlled taxonomy and can remain unresolved
  - evidence: packages/core/src/queue/outcomes.ts, packages/core/src/queue/outcomes.test.ts
- **[MET]** Counts reconcile to source snapshots and all denominators and exclusions are visible
  - evidence: packages/core/src/reporting/sla.ts, packages/core/src/analysers/distribution.ts
- **[MET]** Report content and manifest hashes reproduce
  - evidence: packages/core/src/reporting/sla.test.ts, release/release-c-e2e.json

## §17.5

- **[MET]** Cross-tenant read, write, export and background-job tests pass
  - evidence: packages/core/src/db/rls.int.test.ts, packages/core/src/security/asvs.int.test.ts
- **[MET]** Production services do not use owner or RLS-bypass roles
  - evidence: packages/core/src/db/schema.sql, documentation/operator.md
- **[MET]** Exact location and identifiers do not appear in logs, metrics or safe support bundles
  - evidence: packages/core/src/security/support-bundle.ts, release/security-verification.json
- **[EXTERNAL]** DPA, DPIA, retention, transfer and human-authority boundaries are approved before live use
  - evidence: documentation/dpo.md
  - outstanding: Legal approvals are the customer's and counsel's act, per deployment. The technical substrate (retention automation, holds, tombstones, human-authority controls) is built and tested; the approvals themselves cannot be produced by this repository.
- **[MET]** Backup restore and disaster-recovery exercises pass
  - evidence: release/dr-exercise.json, packages/core/src/dr/restore-exercise.int.test.ts
- **[MET]** The approved application-security control profile passes
  - evidence: release/security-verification.json, packages/core/src/security/asvs.int.test.ts
- **[MET]** Signed artifacts, SBOM and third-party notices are complete
  - evidence: release/RELEASE.json, release/RELEASE.json.sig, release/app-sbom.spdx.json, release/THIRD_PARTY_NOTICES.txt, scripts/release.ts

## §17.6

- **[MET]** User, supervisor, administrator, integration and privacy guides are complete
  - evidence: documentation/README.md, documentation/administrator.md, documentation/dpo.md, documentation/operator.md
- **[MET]** API, schemas, migrations and conformance fixtures are published
  - evidence: packages/spec, scripts/export-spec.ts, documentation/README.md
- **[MET]** Architecture decisions and threat model are current
  - evidence: docs/adr, documentation/threat-model.md
- **[MET]** Upgrade, rollback, restore, incident and data-deletion runbooks are tested
  - evidence: documentation/runbooks.md, packages/core/src/dr/restore-exercise.int.test.ts, packages/core/src/db/retention.int.test.ts
- **[MET]** A new engineer can run the synthetic end-to-end demonstration from documented steps
  - evidence: documentation/developer.md, packages/app/src/release-c.e2e.test.ts


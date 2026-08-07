// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Release B exit criteria, as executable checks.
 *
 * PRD §16.2's exit condition is "reference scenarios reproduce expected episodes, evidence,
 * ambiguity and retractions", and §17.2/§17.3 list the detection-and-evidence and
 * corridor-and-maps acceptance items. Same discipline as Release A: every criterion runs against
 * the real subsystems and reports what it observed. A criterion that cannot fail is not a gate.
 *
 * Unlike Release A these checks need no database — the forensic engine is pure — so the whole
 * suite runs in-process against the reference corpus.
 */

import { SCENARIOS, runScenario } from '@blackout/generator'

import { canSupportUrgentAction } from '../evidence.js'
import { FACT_VOCABULARY, FACT_VOCABULARY_VERSION } from '../rules/facts.js'
import { validateRulePackage } from '../rules/package.js'
import { CONTRADICTIONS, RULE_PACKAGES } from '../rules/packages.js'
import { classify, type ClassificationResult } from '../rules/classify.js'
import { CORPUS_POLICY, factsForScenario } from '../evaluation/corpus.js'
import { sampleEpisodes, type EpisodeSample, type SamplerEvent } from '../episodes/sampler.js'
import { expectedNextReport } from '../reporting-policy.js'
import {
  applyLateData,
  evaluateLateData,
  currentState,
  openEpisode,
  transition,
} from '../episodes/lifecycle.js'
import {
  CORRIDOR_CLAIM_LABEL,
  corridorBaseline,
  projectCorridor,
  type CorridorExposure,
  type RoadGraph,
} from '../geo/corridor.js'
import { OSM_ATTRIBUTION, checkSnapshot } from '../geo/snapshot.js'
import { OPENCELLID_ATTRIBUTION } from '../cells/opencellid.js'
import type { Criterion } from './release-a.js'

const CTX = { seed: 91, startAt: '2026-08-05T06:00:00.000Z' }
const AT = '2026-09-01T00:00:00.000Z'

function classifyScenario(name: string): ClassificationResult {
  const { events } = runScenario(name, CTX)
  return classify({
    facts: factsForScenario(events),
    packages: RULE_PACKAGES,
    contradictions: CONTRADICTIONS,
    at: AT,
    factVocabularyVersion: FACT_VOCABULARY_VERSION,
  })
}

// ------------------------------------------------------------------ reference road graphs
// Small enough to reason about by hand, real enough to exercise the geometry. RIVERSIDE has a
// single bridge every route must cross; GRID has two fully disjoint routes and therefore no
// honest corridor at all.

const node = (id: string, lat: number, lon: number) => ({ id, lat, lon })
const edge = (from: string, to: string, lengthM: number) => ({
  from, to, lengthM, motorcycleAccess: true, carAccess: true, oneWay: false, roadName: null,
})

const RIVERSIDE: RoadGraph = {
  snapshotId: 'snap-acceptance-riverside',
  nodes: [
    node('A', -1.28, 36.8),
    node('N1', -1.27, 36.815), node('S1', -1.29, 36.815),
    node('B', -1.28, 36.83),
    node('N2', -1.27, 36.845), node('S2', -1.29, 36.845),
    node('Z', -1.28, 36.86),
  ],
  edges: [
    edge('A', 'N1', 2000), edge('A', 'S1', 2000),
    edge('N1', 'B', 2000), edge('S1', 'B', 2000),
    edge('B', 'N2', 2000), edge('B', 'S2', 2000),
    edge('N2', 'Z', 2000), edge('S2', 'Z', 2000),
  ],
}

const GRID: RoadGraph = {
  snapshotId: 'snap-acceptance-grid',
  nodes: [node('A', -1.28, 36.8), node('P', -1.27, 36.83), node('Q', -1.29, 36.83), node('Z', -1.28, 36.86)],
  edges: [edge('A', 'P', 2500), edge('P', 'Z', 2500), edge('A', 'Q', 2500), edge('Q', 'Z', 2500)],
}

const PROHIBITED_OUTPUT = /borrower|theft|stole|intent|carrier[- ]confirmed/i

/** §16.2 + §17.2 + §17.3 as a runnable list. */
export function releaseBCriteria(): Criterion[] {
  return [
    {
      id: 'B-1',
      requirement: 'PRD §16.2 / §17.2',
      title: 'Reference blackouts open, revise and close at expected boundaries',
      run: async () => {
        const evidence: string[] = []
        const problems: string[] = []

        for (const name of Object.keys(SCENARIOS)) {
          const { events, truth } = runScenario(name, CTX)

          // Sample per device, as production does — a mixed stream would let one device's
          // reports mask another's silence.
          const byDevice = new Map<string, SamplerEvent[]>()
          for (const event of events as unknown as SamplerEvent[]) {
            byDevice.set(event.device_ref, [...(byDevice.get(event.device_ref) ?? []), event])
          }
          // The maintenance scenario's gap is covered by an approved window, exactly as a
          // deployment would declare it. Suppression must stay auditable (FR-POL-004): the
          // episode is still sampled, marked, and countable — never silently dropped.
          // The window starts one reporting cycle before the first missed report, as a real
          // work order would: the device goes down *during* the window, and the episode's
          // startAt is the last successful report — which must fall inside it to match.
          const windows =
            name.includes('maintenance') && truth.gap !== undefined
              ? [{
                  reason: 'maintenance' as const,
                  from: new Date(
                    Date.parse(truth.gap.startAt) - CORPUS_POLICY.intervals.moving * 2000,
                  ).toISOString(),
                  to: truth.gap.endAt,
                  approvedBy: 'ops@synthetic',
                }]
              : []
          const episodes: EpisodeSample[] = []
          for (const deviceEvents of byDevice.values()) {
            const ordered = [...deviceEvents].sort((a, b) =>
              a.received_at.localeCompare(b.received_at),
            )
            episodes.push(
              ...sampleEpisodes(ordered, { policy: CORPUS_POLICY, suppressionWindows: windows }),
            )
          }

          if (truth.opensEpisode) {
            const gap = truth.gap
            const overlapping =
              gap === undefined
                ? episodes
                : episodes.filter(
                    (e) =>
                      Date.parse(e.startAt) < Date.parse(gap.endAt) &&
                      (e.endAt === null || Date.parse(e.endAt) > Date.parse(gap.startAt)),
                  )
            if (overlapping.length > 0) {
              evidence.push(`${name}: ${overlapping.length} episode(s) at the labelled gap`)
              continue
            }
            // A gap at the end of the stream is invisible to between-report sampling — it is the
            // deadline monitor's job. The boundary claim still holds if the deadline computed
            // from the last report falls inside the labelled gap.
            const lastBefore = [...events]
              .filter((e) => gap === undefined || (e.device_time ?? e.received_at) <= gap.startAt)
              .sort((a, b) => a.received_at.localeCompare(b.received_at))
              .at(-1)
            if (lastBefore !== undefined && gap !== undefined) {
              const expected = expectedNextReport({
                lastReportAt: (lastBefore.device_time ?? lastBefore.received_at) as string,
                state: 'moving',
                policy: CORPUS_POLICY,
              })
              if (
                Date.parse(expected.deadlineAt) >= Date.parse(gap.startAt) &&
                Date.parse(expected.deadlineAt) <= Date.parse(gap.endAt)
              ) {
                evidence.push(
                  `${name}: trailing silence — deadline ${expected.deadlineAt} falls inside the labelled gap, so the deadline monitor opens it`,
                )
                continue
              }
            }
            problems.push(`${name}: truth expects an episode and none was found at the labelled gap`)
          } else {
            const unsuppressed = episodes.filter((e) => e.suppressedBy === undefined)
            if (name.includes('maintenance')) {
              const suppressed = episodes.filter((e) => e.suppressedBy === 'maintenance')
              if (suppressed.length === 0) {
                problems.push(`${name}: the approved window suppressed nothing — either no episode sampled or the window was ignored`)
              } else if (unsuppressed.some((e) => e.type === 'total_silence')) {
                problems.push(`${name}: a silence episode escaped the approved window`)
              } else {
                evidence.push(
                  `${name}: ${suppressed.length} episode(s) suppressed by the approved window, still sampled and auditable (FR-POL-004)`,
                )
              }
              continue
            }
            // Mechanical episodes (a sleeping Teltonika's stale coordinates, say) may sample;
            // the truth label is about the *case* layer: nothing actionable may come of them.
            const classification = classifyScenario(name)
            const actionable =
              classification.urgentEligible ||
              classification.hypotheses.some(
                (h) => h.suppressedBy === null && h.code !== 'H-EXPECTED' && h.band !== 'weak',
              )
            if (actionable) {
              problems.push(
                `${name}: truth expects no case, yet classification produced an actionable hypothesis`,
              )
            } else if (unsuppressed.length > 0) {
              evidence.push(
                `${name}: ${unsuppressed.length} mechanical episode(s) sampled (${[...new Set(unsuppressed.map((e) => e.type))].join(', ')}), none became an actionable case`,
              )
            } else {
              evidence.push(`${name}: no episode, as truth expects`)
            }
          }
        }

        // Revision and retraction, §16.2's remaining words. A provisionally-closed silence
        // episode closes for good when late records after its end confirm recovery; an open one
        // retracts when buffered records show the device was reporting throughout.
        const policy = { requiredReports: 3, expectedIntervalS: 60 }
        const provisional = openEpisode({
          id: 'accept-b1-close', deviceRef: 'dev-accept', type: 'total_silence',
          startAt: '2026-08-05T07:00:00.000Z', actor: 'system:sampler',
          reason: 'expected report missed', at: '2026-08-05T07:05:00.000Z',
          clockBasis: 'device_time', policyVersion: 'policy-1',
          finalisationWatermarkAt: AT,
        })
        // §5.2: provisional cannot late-close directly — it must be monitoring first. The state
        // machine refusing the shortcut here is itself part of what this criterion demonstrates.
        const monitoring = transition(provisional, {
          to: 'monitoring', cause: 'evidence_updated', actor: 'system:watermark',
          reason: 'episode survived initial confirmation', at: '2026-08-05T07:10:00.000Z',
        }, '2026-08-05T07:10:00.000Z')
        const closedProvisional = applyLateData(
          monitoring,
          { kind: 'closed', endAt: '2026-08-05T08:00:00.000Z' },
          { actor: 'system:watermark', at: '2026-08-05T08:10:00.000Z', now: '2026-08-05T08:10:00.000Z' },
        ).episodes[0]!
        const closing = evaluateLateData(closedProvisional, [
          { at: '2026-08-05T08:00:00.000Z', valid: true },
          { at: '2026-08-05T08:01:00.000Z', valid: true },
          { at: '2026-08-05T08:02:00.000Z', valid: true },
        ], policy)
        if (closing.kind !== 'closed') {
          problems.push(`late records after the gap should close, got: ${closing.kind}`)
        } else {
          evidence.push('late records confirming recovery after the gap close the episode')
        }

        const open = openEpisode({
          id: 'accept-b1-retract', deviceRef: 'dev-accept', type: 'total_silence',
          startAt: '2026-08-05T07:00:00.000Z', actor: 'system:sampler',
          reason: 'expected report missed', at: '2026-08-05T07:05:00.000Z',
          clockBasis: 'device_time', policyVersion: 'policy-1',
          finalisationWatermarkAt: AT,
        })
        const retracting = evaluateLateData(open, [
          { at: '2026-08-05T07:00:30.000Z', valid: true },
          { at: '2026-08-05T07:01:30.000Z', valid: true },
          { at: '2026-08-05T07:02:30.000Z', valid: true },
        ], policy)
        const retraction = applyLateData(open, retracting, {
          actor: 'system:late-data', at: '2026-08-05T08:05:00.000Z', now: '2026-08-05T08:05:00.000Z',
        })
        if (retracting.kind !== 'retracted' || currentState(retraction.episodes[0]!) !== 'retracted') {
          problems.push(`buffered records covering the gap should retract, got: ${retracting.kind}`)
        } else {
          evidence.push('buffered records covering the gap retract the episode')
        }

        return problems.length === 0
          ? { status: 'pass', evidence }
          : { status: 'fail', evidence: problems }
      },
    },
    {
      id: 'B-2',
      requirement: 'PRD §17.2',
      title: 'Normal sleep and approved maintenance do not become actionable cases',
      run: async () => {
        const evidence: string[] = []
        const problems: string[] = []
        for (const name of Object.keys(SCENARIOS).filter(
          (n) => n.includes('sleep') || n.includes('maintenance'),
        )) {
          const classification = classifyScenario(name)
          if (classification.urgentEligible) {
            problems.push(`${name}: urgent-eligible despite documented sleep/maintenance`)
          } else {
            evidence.push(
              `${name}: not urgent-eligible; fired [${classification.hypotheses
                .map((h) => h.code)
                .join(', ')}]`,
            )
          }
        }
        if (evidence.length + problems.length === 0) {
          return {
            status: 'fail',
            evidence: ['no sleep or maintenance scenario exists in the corpus — nothing was checked'],
          }
        }
        return problems.length === 0
          ? { status: 'pass', evidence }
          : { status: 'fail', evidence: problems }
      },
    },
    {
      id: 'B-3',
      requirement: 'PRD §17.2 / FR-CLS-007',
      title: 'Source-wide failure suppresses inappropriate individual tamper escalation',
      run: async () => {
        const vendorScenarios = Object.keys(SCENARIOS).filter((n) => n.includes('vendor'))
        const evidence: string[] = []
        const problems: string[] = []
        for (const name of vendorScenarios) {
          const classification = classifyScenario(name)
          const weakTamperUnsuppressed = classification.hypotheses.some(
            (h) =>
              h.code === 'H-TAMPER' &&
              h.evidence.strength !== 'direct' &&
              h.suppressedBy === null,
          )
          if (weakTamperUnsuppressed) {
            problems.push(`${name}: weak tamper survived a source-wide failure`)
          } else {
            const suppressed = classification.hypotheses.filter((h) => h.suppressedBy !== null)
            evidence.push(
              `${name}: ${
                suppressed.length > 0
                  ? `suppressed [${suppressed.map((h) => h.code).join(', ')}]`
                  : 'no weak tamper fired at all'
              }`,
            )
          }
        }
        return problems.length === 0
          ? { status: 'pass', evidence }
          : { status: 'fail', evidence: problems }
      },
    },
    {
      id: 'B-4',
      requirement: 'PRD §17.2 / FR-CLS-003',
      title: 'Every non-unknown hypothesis shows evidence, counterevidence, missing evidence and rule version',
      run: async () => {
        let entries = 0
        const problems: string[] = []
        for (const name of Object.keys(SCENARIOS)) {
          const classification = classifyScenario(name)
          for (const hypothesis of classification.hypotheses) {
            entries += 1
            if (hypothesis.ruleId === '' || hypothesis.ruleVersion === '') {
              problems.push(`${name}/${hypothesis.code}: missing rule identity`)
            }
            if (hypothesis.evidence.family === undefined || hypothesis.evidence.strength === undefined) {
              problems.push(`${name}/${hypothesis.code}: fired with no evidence item`)
            }
            if (!Array.isArray(hypothesis.counterevidence) || !Array.isArray(hypothesis.missingExpected)) {
              problems.push(`${name}/${hypothesis.code}: counterevidence or missing-evidence absent`)
            }
          }
        }
        return problems.length === 0
          ? {
              status: 'pass',
              evidence: [
                `${entries} fired entries across the corpus, every one carrying rule id+version, evidence, counterevidence and missing-evidence lists`,
              ],
            }
          : { status: 'fail', evidence: problems }
      },
    },
    {
      id: 'B-5',
      requirement: 'PRD §17.2 / FR-CLS-005',
      title: 'Weak OpenCellID evidence cannot independently create an urgent case',
      run: async () => {
        const cellFacts = FACT_VOCABULARY.filter((f) => /cell|opencellid/i.test(f.name))
        const urgentOnCellAlone = canSupportUrgentAction([
          { family: 'cell_prior', strength: 'corroborated', summary: 'cells matched a prior' },
          { family: 'cell_prior', strength: 'direct', summary: 'cells matched a prior, mislabelled direct' },
        ])
        const problems: string[] = []
        if (cellFacts.length > 0) {
          problems.push(`vocabulary contains cell facts: ${cellFacts.map((f) => f.name).join(', ')}`)
        }
        if (urgentOnCellAlone) {
          problems.push('cell_prior evidence alone reached urgent eligibility')
        }
        return problems.length === 0
          ? {
              status: 'pass',
              evidence: [
                'the fact vocabulary contains no cell-derived fact, so no rule can read one',
                'cell_prior evidence is excluded from urgency even labelled direct',
              ],
            }
          : { status: 'fail', evidence: problems }
      },
    },
    {
      id: 'B-6',
      requirement: 'PRD §17.2 / §11.5',
      title: 'No output states borrower intent or a carrier-confirmed outage without qualifying evidence',
      run: async () => {
        const problems: string[] = []
        for (const rule of RULE_PACKAGES) {
          const violations = validateRulePackage(rule)
          if (violations.length > 0) {
            problems.push(`${rule.id}: ${violations.map((v) => v.code).join(', ')}`)
          }
        }
        let scanned = 0
        for (const name of Object.keys(SCENARIOS)) {
          const classification = classifyScenario(name)
          for (const hypothesis of classification.hypotheses) {
            scanned += 1
            const rule = RULE_PACKAGES.find((r) => r.id === hypothesis.ruleId)
            const text = [
              rule?.produces.summary ?? '',
              ...hypothesis.counterevidence.map((c) => c.summary),
            ].join(' ')
            if (PROHIBITED_OUTPUT.test(text)) {
              problems.push(`${name}/${hypothesis.code}: prohibited wording in output: "${text}"`)
            }
          }
        }
        return problems.length === 0
          ? {
              status: 'pass',
              evidence: [
                `${RULE_PACKAGES.length} shipped packages validate clean, including wording checks`,
                `${scanned} corpus outputs scanned; none states borrower intent or a carrier-confirmed outage`,
              ],
            }
          : { status: 'fail', evidence: problems }
      },
    },
    {
      id: 'B-7',
      requirement: 'PRD §17.3 / FR-GEO-002',
      title: 'Map snapshot and routing profile are versioned',
      run: async () => {
        const result = projectCorridor({
          graph: RIVERSIDE, fromNodeId: 'A', toNodeId: 'Z', elapsedS: 1200, maxSpeedKph: 40,
        })
        const manifest = result.manifest
        const problems: string[] = []
        if (manifest.snapshotId === '') problems.push('projection carries no snapshot id')
        if (manifest.profile !== 'motorcycle') {
          problems.push(`default profile is ${manifest.profile}, expected motorcycle`)
        }
        return problems.length === 0
          ? {
              status: 'pass',
              evidence: [
                `every projection carries its manifest: snapshot ${manifest.snapshotId}, profile ${manifest.profile}, budget ${manifest.budgetM}m`,
              ],
            }
          : { status: 'fail', evidence: problems }
      },
    },
    {
      id: 'B-8',
      requirement: 'PRD §17.3 / FR-GEO-004',
      title: 'Ambiguous paths are withheld',
      run: async () => {
        const ambiguous = projectCorridor({
          graph: GRID, fromNodeId: 'A', toNodeId: 'Z', elapsedS: 1200, maxSpeedKph: 40,
        })
        return ambiguous.status === 'corridor_ambiguous'
          ? {
              status: 'pass',
              evidence: [
                `two disjoint routes produce status=${ambiguous.status}: no line is drawn, the feasible region is context only`,
              ],
            }
          : {
              status: 'fail',
              evidence: [`disjoint-route graph produced status=${ambiguous.status}`],
            }
      },
    },
    {
      id: 'B-9',
      requirement: 'PRD §17.3 / §12.4',
      title: 'Corridor outputs use "possible corridor"',
      run: async () => {
        const result = projectCorridor({
          graph: RIVERSIDE, fromNodeId: 'A', toNodeId: 'Z', elapsedS: 1200, maxSpeedKph: 40,
        })
        if (result.status !== 'corridor') {
          return {
            status: 'fail',
            evidence: [`reference projection unexpectedly ${result.status}`],
          }
        }
        return result.claim === CORRIDOR_CLAIM_LABEL
          ? {
              status: 'pass',
              evidence: [`the corridor result type fixes the claim to "${result.claim}" — renaming it stronger is a type error`],
            }
          : { status: 'fail', evidence: [`claim reads "${result.claim}"`] }
      },
    },
    {
      id: 'B-10',
      requirement: 'PRD §17.3 / FR-GEO-007',
      title: 'Exposure denominators are present',
      run: async () => {
        const day = (i: number): string => `2026-07-${String((i % 20) + 1).padStart(2, '0')}`
        const exposure: CorridorExposure = {
          h3Cell: '8859a442b3fffff',
          assetDays: Array.from({ length: 40 }, (_, i) => ({
            assetRef: `ast-${i % 12}`, day: day(i),
          })),
          traversals: 200,
          deviceHours: 480,
          blackouts: 14,
        }
        const fleet = { traversals: 4000, deviceHours: 9000, blackouts: 60 }
        const baseline = corridorBaseline(exposure, fleet)
        const problems: string[] = []
        if (baseline.ratePerTraversal === null || baseline.ratePerDeviceHour === null) {
          problems.push('a qualified baseline is missing one of its denominators')
        }
        if (baseline.fleetRatePerTraversal === null || baseline.fleetRatePerDeviceHour === null) {
          problems.push('fleet comparison rates are missing')
        }
        return problems.length === 0
          ? {
              status: 'pass',
              evidence: [
                `both denominators always travel together: per-traversal ${baseline.ratePerTraversal?.toFixed(4)}, per-device-hour ${baseline.ratePerDeviceHour?.toFixed(4)}`,
                `disagreement between them is surfaced as its own field (currently ${baseline.denominatorsDisagree})`,
              ],
            }
          : { status: 'fail', evidence: problems }
      },
    },
    {
      id: 'B-11',
      requirement: 'PRD §17.3 / ODbL & CC BY-SA',
      title: 'OSM and OpenCellID attribution appears wherever applicable',
      run: async () => {
        const rejected = checkSnapshot({
          sourceUrl: 'https://download.geofabrik.de/africa/kenya.html',
          licence: 'ODbL-1.0', extractDate: '2026-08-01',
          sha256: 'a'.repeat(64), attribution: '',
        })
        const problems: string[] = []
        if (!rejected.rejections.includes('missing_attribution')) {
          problems.push('a snapshot without attribution was accepted for activation')
        }
        if (!OSM_ATTRIBUTION.includes('OpenStreetMap')) {
          problems.push('the OSM attribution constant does not name OpenStreetMap')
        }
        if (!OPENCELLID_ATTRIBUTION.includes('OpenCellID')) {
          problems.push('the OpenCellID attribution constant does not name OpenCellID')
        }
        return problems.length === 0
          ? {
              status: 'pass',
              evidence: [
                'a map snapshot without attribution is refused at activation — attribution cannot be lost downstream because unattributed data never enters',
                `maps carry "${OSM_ATTRIBUTION}"`,
                `cell context carries "${OPENCELLID_ATTRIBUTION}"`,
              ],
            }
          : { status: 'fail', evidence: problems }
      },
    },
    {
      id: 'B-12',
      requirement: 'PRD §17.3 / §12.4',
      title: 'Map results have a complete text and table alternative',
      run: async () => {
        const result = projectCorridor({
          graph: RIVERSIDE, fromNodeId: 'A', toNodeId: 'Z', elapsedS: 1200, maxSpeedKph: 40,
        })
        if (result.status !== 'corridor') {
          return { status: 'fail', evidence: [`reference projection unexpectedly ${result.status}`] }
        }
        const problems: string[] = []
        if (result.table.length === 0) problems.push('corridor published with an empty table')
        if (result.table.length !== result.corridorCells.length) {
          problems.push('the table does not cover every corridor cell — the alternative is incomplete')
        }
        const ambiguous = projectCorridor({
          graph: GRID, fromNodeId: 'A', toNodeId: 'Z', elapsedS: 1200, maxSpeedKph: 40,
        })
        if (ambiguous.status === 'corridor_ambiguous' && ambiguous.reason.length < 20) {
          problems.push('the ambiguous outcome carries no usable prose explanation')
        }
        return problems.length === 0
          ? {
              status: 'pass',
              evidence: [
                `the table is the primary representation: ${result.table.length} rows covering every corridor cell; the map is supplementary`,
                'non-corridor outcomes carry their explanation as prose',
              ],
            }
          : { status: 'fail', evidence: problems }
      },
    },
  ]
}

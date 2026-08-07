// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The version-1 rule packages — one per canonical hypothesis in PRD §8.1, minus H-UNKNOWN, which is
 * not a rule: it is what the classifier emits when nothing else can be responsibly said, and making
 * it a rule would invite tuning it away.
 *
 * Every summary is written against §8.1's prohibited-conclusion column. H-POWER says the tracker
 * lost external power and nothing about who caused it; H-TAMPER uses §11.5's exact phrase;
 * H-VENDOR names the platform, never the mobile operator. The wording is validated, not trusted.
 *
 * Version 1.1.0 across the set: the adversarial verification pass demonstrated that several rules
 * fired on episode shapes their own summaries contradicted, that benign-explanation rules ignored
 * direct alerts arguing otherwise, and that obvious counterevidence went undeclared. Each fix is
 * annotated at the condition it changed.
 */

import { available, unavailable, type FactSet } from './facts.js'
import type { HypothesisCode, Predicate, RulePackage } from './package.js'
import { TAMPER_REQUIRED_PHRASE } from './package.js'

const GOVERNANCE = {
  // Placeholder role slugs, not identifiable people — a real publication replaces these, and the
  // validator's two-distinct-approvers check is a floor, not proof of accountability.
  owner: 'rules-steward',
  technicalReviewer: 'eng-reviewer',
  riskApprover: 'ops-approver',
  approvedOn: '2026-08-08',
  effectiveFrom: '2026-08-07T00:00:00.000Z',
  effectiveTo: null,
  rollbackTo: '1.0.0',
} as const

const ALL_COHORTS = ['all'] as const

/** Shorthand for fixture fact sets: strings/numbers/booleans become available facts. */
function facts(entries: Record<string, string | number | boolean | { missing: string }>): FactSet {
  const out: Record<string, ReturnType<typeof available>> = {}
  for (const [name, value] of Object.entries(entries)) {
    out[name] =
      typeof value === 'object' ? unavailable(value.missing) : available(value)
  }
  return out
}

export const RULE_PACKAGES: readonly RulePackage[] = [
  {
    id: 'rule.h-expected.policy-match',
    version: '1.1.0',
    purpose:
      'Recognise a gap that the effective reporting policy predicts: total silence in a parked or ' +
      'sleeping state whose interval was declared, with no direct alert arguing otherwise.',
    hypothesis: 'H-EXPECTED',
    cohorts: ALL_COHORTS,
    requiredFacts: [
      'episode.type', 'policy.state_at_gap', 'policy.weak_basis', 'policy.sleep_provenance',
    ],
    optionalFacts: [
      'power.cut_alert_present', 'tamper.alert_present', 'maintenance.window_active',
      'episode.missed_reports', 'gnss.jamming_alert', 'network.jamming_alert',
      'movement.moving_before_gap',
    ],
    positive: [
      // Finding C2: episode.type was required but never read, so this rule certified "the policy
      // predicts silence" on episodes where reporting demonstrably continued.
      { fact: 'episode.type', op: 'eq', value: 'total_silence' },
      { fact: 'policy.state_at_gap', op: 'in', values: ['sleep', 'parked'] },
      { fact: 'policy.weak_basis', op: 'eq', value: false },
      // Finding H9: weak_basis is computed only for sleep states, so a parked gap under an assumed
      // policy fired with a summary claiming a declared interval. The provenance gate makes the
      // summary true whenever the rule speaks.
      { fact: 'policy.sleep_provenance', op: 'eq', value: 'declared' },
    ],
    negative: [
      { fact: 'power.cut_alert_present', op: 'eq', value: true },
      { fact: 'tamper.alert_present', op: 'eq', value: true },
      // Finding H8: the purpose said "no direct alert arguing otherwise" but jamming indications
      // were never consulted. An affirmative interference reading blocks the benign certification.
      { fact: 'gnss.jamming_alert', op: 'eq', value: true },
      { fact: 'network.jamming_alert', op: 'eq', value: true },
    ],
    counterevidence: [
      {
        when: { fact: 'episode.missed_reports', op: 'gte', value: 10 },
        summary: 'the gap has outlasted many expected sleep cycles',
      },
      {
        // Finding M9: a device observed moving immediately before a "parked" gap contradicts the
        // reading and must appear beside it, not vanish.
        when: { fact: 'movement.moving_before_gap', op: 'eq', value: true },
        summary: 'the asset was moving in its last valid observations, at odds with a parked or sleeping state',
      },
    ],
    produces: {
      family: 'policy_match',
      strength: 'corroborated',
      summary: 'the effective reporting policy predicts silence in this state, from a declared interval',
    },
    priorityEffect: { factor: 'expected-state-match', effect: 'lower' },
    humanReview: false,
    fixtures: [
      {
        name: 'declared parked silence fires',
        facts: facts({
          'episode.type': 'total_silence', 'policy.state_at_gap': 'parked',
          'policy.weak_basis': false, 'policy.sleep_provenance': 'declared',
          'episode.missed_reports': 2,
        }),
        expected: 'fired',
      },
      {
        name: 'a gnss-only loss is not silence and cannot be certified as expected',
        facts: facts({
          'episode.type': 'gnss_only_loss', 'policy.state_at_gap': 'parked',
          'policy.weak_basis': false, 'policy.sleep_provenance': 'declared',
        }),
        expected: 'did_not_fire',
      },
      {
        name: 'an assumed policy cannot claim a declared interval',
        facts: facts({
          'episode.type': 'total_silence', 'policy.state_at_gap': 'parked',
          'policy.weak_basis': false, 'policy.sleep_provenance': 'assumed',
        }),
        expected: 'did_not_fire',
      },
      {
        name: 'a network jamming indication blocks the benign reading',
        facts: facts({
          'episode.type': 'total_silence', 'policy.state_at_gap': 'parked',
          'policy.weak_basis': false, 'policy.sleep_provenance': 'declared',
          'network.jamming_alert': true,
        }),
        expected: 'did_not_fire',
      },
      {
        name: 'no policy state means no claim',
        facts: facts({ 'episode.type': 'total_silence' }),
        expected: 'not_applicable',
      },
    ],
    governance: GOVERNANCE,
  },

  {
    id: 'rule.h-gnss.position-quality-loss',
    version: '1.1.0',
    purpose:
      'Recognise GNSS-only loss: reporting continued on schedule while position quality failed or ' +
      'froze. This is a statement about the positioning subsystem, and about nothing else.',
    hypothesis: 'H-GNSS',
    cohorts: ALL_COHORTS,
    requiredFacts: ['episode.type', 'gnss.reports_continued'],
    optionalFacts: [
      'maintenance.window_active', 'movement.moving_before_gap', 'device.sleep_state_before_gap',
    ],
    positive: [
      // Finding H4: §8.1's minimum support is "reports continue; position quality fails", and a
      // frozen-but-valid position is that failure too. stale_position was orphaned — no rule
      // anywhere handled it.
      { fact: 'episode.type', op: 'in', values: ['gnss_only_loss', 'stale_position'] },
      { fact: 'gnss.reports_continued', op: 'eq', value: true },
    ],
    negative: [
      { fact: 'maintenance.window_active', op: 'eq', value: true },
      // Deep Sleep emits stale, invalid coordinates by design. Reading documented sleep behaviour
      // as GNSS loss blames the fleet for following its own configuration — the corpus baseline
      // caught this rule doing exactly that on the deep-sleep scenario.
      { fact: 'device.sleep_state_before_gap', op: 'eq', value: 'deep_sleep' },
    ],
    counterevidence: [
      {
        // Finding M7: a device that affirmatively reported an undetermined sleep state produced a
        // cleaner record than one that reported nothing. The undetermined reading is context an
        // analyst needs beside the claim.
        when: { fact: 'device.sleep_state_before_gap', op: 'eq', value: 'unknown' },
        summary: 'the device reported its sleep state as undetermined when the gap opened',
      },
    ],
    produces: {
      family: 'device_signal',
      strength: 'corroborated',
      summary: 'reports continued on schedule while position quality failed',
    },
    priorityEffect: { factor: 'gnss-loss-while-reporting', effect: 'raise' },
    humanReview: false,
    fixtures: [
      {
        name: 'gnss-only loss fires',
        facts: facts({ 'episode.type': 'gnss_only_loss', 'gnss.reports_continued': true }),
        expected: 'fired',
      },
      {
        name: 'a frozen valid position is the same failure',
        facts: facts({ 'episode.type': 'stale_position', 'gnss.reports_continued': true }),
        expected: 'fired',
      },
      {
        name: 'total silence is not a gnss claim',
        facts: facts({ 'episode.type': 'total_silence', 'gnss.reports_continued': false }),
        expected: 'did_not_fire',
      },
      {
        name: 'deep-sleep stale positions are documented behaviour, not gnss loss',
        facts: facts({
          'episode.type': 'gnss_only_loss', 'gnss.reports_continued': true,
          'device.sleep_state_before_gap': 'deep_sleep',
        }),
        expected: 'did_not_fire',
      },
    ],
    governance: GOVERNANCE,
  },

  {
    id: 'rule.h-gnss.jamming-flag',
    version: '1.1.0',
    purpose:
      'Carry a device-reported GNSS jamming indication as direct evidence. Applicable only when ' +
      'the detector could actually run — deep sleep disables it, and the fact goes unavailable ' +
      'rather than false.',
    hypothesis: 'H-GNSS',
    cohorts: ALL_COHORTS,
    requiredFacts: ['gnss.jamming_alert'],
    optionalFacts: ['source.health_incident_active'],
    positive: [{ fact: 'gnss.jamming_alert', op: 'eq', value: true }],
    negative: [],
    counterevidence: [
      {
        when: { fact: 'source.health_incident_active', op: 'eq', value: true },
        summary: 'a source-wide incident is concurrently active on this platform',
      },
    ],
    produces: {
      family: 'device_signal',
      strength: 'direct',
      summary: 'the device reported a GNSS jamming indication',
    },
    priorityEffect: { factor: 'direct-jamming-indication', effect: 'raise' },
    humanReview: true,
    fixtures: [
      {
        name: 'jamming flag fires',
        facts: facts({ 'gnss.jamming_alert': true }),
        expected: 'fired',
      },
      {
        name: 'deep sleep makes the rule inapplicable, never false',
        facts: facts({ 'gnss.jamming_alert': { missing: 'jamming detectors are disabled in deep sleep' } }),
        expected: 'not_applicable',
      },
      {
        name: 'no flag, no claim',
        facts: facts({ 'gnss.jamming_alert': false }),
        expected: 'did_not_fire',
      },
    ],
    governance: GOVERNANCE,
  },

  {
    id: 'rule.h-vendor.source-cluster',
    version: '1.1.0',
    purpose:
      'Recognise a platform ingestion incident: independent devices on the same source showing ' +
      'correlated receipt failure. Says the platform stopped delivering — nothing about networks.',
    hypothesis: 'H-VENDOR',
    cohorts: ALL_COHORTS,
    requiredFacts: ['source.independent_devices'],
    optionalFacts: ['source.health_incident_active', 'episode.type'],
    // FR-COR-002: minimum independent devices before a provider incident may be shown, default 3,
    // with devices sharing an asset or data path already excluded from the count (FR-COR-003).
    positive: [{ fact: 'source.independent_devices', op: 'gte', value: 3 }],
    negative: [
      // Finding H2: a platform ingestion incident cannot explain an episode during which reports
      // demonstrably kept arriving. The negative declines only when the shape disproves the claim;
      // an unknown shape fires with the gap recorded, since incident correlation should not go
      // silent merely because episode context was not supplied.
      { fact: 'episode.type', op: 'in', values: ['gnss_only_loss', 'stale_position'] },
    ],
    counterevidence: [
      {
        // Finding M6: platform monitoring affirmatively reporting NO incident is material
        // counterevidence against a platform-incident reading, and §8.2 then degrades the band.
        when: { fact: 'source.health_incident_active', op: 'eq', value: false },
        summary: 'platform health monitoring reports no active incident over this window',
      },
    ],
    produces: {
      family: 'platform_health',
      strength: 'corroborated',
      summary: 'independent devices on the same platform show correlated receipt failure',
    },
    priorityEffect: { factor: 'peer-incident-explains-gap', effect: 'lower' },
    humanReview: false,
    fixtures: [
      {
        name: 'three independent devices fire',
        facts: facts({ 'source.independent_devices': 3 }),
        expected: 'fired',
      },
      {
        name: 'two devices are below the floor',
        facts: facts({ 'source.independent_devices': 2 }),
        expected: 'did_not_fire',
      },
      {
        name: 'a cluster cannot explain an episode whose reports kept arriving',
        facts: facts({ 'source.independent_devices': 5, 'episode.type': 'gnss_only_loss' }),
        expected: 'did_not_fire',
      },
      {
        name: 'no peer run, no claim',
        facts: facts({ 'source.independent_devices': { missing: 'peer correlation has not run' } }),
        expected: 'not_applicable',
      },
    ],
    governance: GOVERNANCE,
  },

  {
    id: 'rule.h-network.operator-cluster',
    version: '1.1.0',
    purpose:
      'Recognise a correlated SIM or network incident: independent devices sharing a network ' +
      'identity going silent together, where that identity was actually observed.',
    hypothesis: 'H-NETWORK',
    cohorts: ALL_COHORTS,
    requiredFacts: ['network.independent_devices', 'network.identity_known'],
    optionalFacts: ['source.health_incident_active', 'episode.type'],
    positive: [
      { fact: 'network.independent_devices', op: 'gte', value: 3 },
      { fact: 'network.identity_known', op: 'eq', value: true },
    ],
    negative: [
      // Finding H5: the same shape guard as the vendor rule — a network incident cannot explain an
      // episode during which the device kept reporting over that network.
      { fact: 'episode.type', op: 'in', values: ['gnss_only_loss', 'stale_position'] },
    ],
    counterevidence: [
      {
        // Findings H6/M12: a platform-wide ingestion outage manufactures exactly this correlated
        // signature, and the rule could not previously say so.
        when: { fact: 'source.health_incident_active', op: 'eq', value: true },
        summary:
          'a platform-wide incident is active and would produce the same correlated silence ' +
          'without any network involvement',
      },
    ],
    produces: {
      family: 'peer_devices',
      strength: 'corroborated',
      summary: 'independent devices on the same network identity show correlated silence',
    },
    priorityEffect: { factor: 'network-incident-explains-gap', effect: 'lower' },
    humanReview: false,
    fixtures: [
      {
        name: 'network cluster fires',
        facts: facts({ 'network.independent_devices': 4, 'network.identity_known': true }),
        expected: 'fired',
      },
      {
        name: 'two devices are below the floor',
        facts: facts({ 'network.independent_devices': 2, 'network.identity_known': true }),
        expected: 'did_not_fire',
      },
      {
        name: 'unknown identity cannot support the claim',
        facts: facts({
          'network.independent_devices': { missing: 'identity not observed' },
          'network.identity_known': false,
        }),
        expected: 'not_applicable',
      },
    ],
    governance: GOVERNANCE,
  },

  {
    id: 'rule.h-corridor.recurrence',
    version: '1.1.0',
    purpose:
      'Carry a qualified corridor baseline as weak context: this stretch of road produces gaps ' +
      'above the fleet base rate. A reason to look — nothing more.',
    hypothesis: 'H-CORRIDOR',
    cohorts: ALL_COHORTS,
    requiredFacts: ['corridor.recurrence_qualified'],
    optionalFacts: [],
    positive: [{ fact: 'corridor.recurrence_qualified', op: 'eq', value: true }],
    negative: [],
    counterevidence: [],
    produces: {
      family: 'route_history',
      strength: 'weak',
      summary: 'this corridor recurs above the fleet base rate, on exposure-adjusted counts',
    },
    priorityEffect: { factor: 'corridor-recurrence', effect: 'raise' },
    humanReview: false,
    fixtures: [
      {
        name: 'qualified recurrence fires',
        facts: facts({ 'corridor.recurrence_qualified': true }),
        expected: 'fired',
      },
      {
        // Finding M4: the disqualified case was unpinned — the one inversion that matters for a
        // rule whose entire content is a boolean gate.
        name: 'a disqualified corridor does not fire',
        facts: facts({ 'corridor.recurrence_qualified': false }),
        expected: 'did_not_fire',
      },
      {
        name: 'unevaluated corridor is inapplicable',
        facts: facts({ 'corridor.recurrence_qualified': { missing: 'baseline not evaluated' } }),
        expected: 'not_applicable',
      },
    ],
    governance: GOVERNANCE,
  },

  {
    id: 'rule.h-power.external-cut',
    version: '1.1.0',
    purpose:
      'Carry a device-reported loss of external power as direct evidence. H-POWER means the ' +
      'tracker lost external power, and this rule says nothing more than that.',
    hypothesis: 'H-POWER',
    cohorts: ALL_COHORTS,
    requiredFacts: ['power.cut_alert_present'],
    optionalFacts: [
      'source.health_incident_active', 'movement.moving_before_gap', 'maintenance.window_active',
    ],
    positive: [{ fact: 'power.cut_alert_present', op: 'eq', value: true }],
    negative: [],
    counterevidence: [
      {
        when: { fact: 'source.health_incident_active', op: 'eq', value: true },
        summary: 'a source-wide incident is concurrently active on this platform',
      },
      {
        // Finding H1: a power cut during an approved window — an installer unplugging the tracker —
        // fired with a spotless record. The direct signal stands (direct is never suppressed), but
        // the window belongs beside it where the reviewer decides.
        when: { fact: 'maintenance.window_active', op: 'eq', value: true },
        summary: 'an approved maintenance or installation window covers this gap',
      },
    ],
    produces: {
      family: 'device_signal',
      strength: 'direct',
      summary: 'the device reported loss of external power before the gap',
    },
    priorityEffect: { factor: 'direct-power-evidence', effect: 'raise' },
    humanReview: true,
    fixtures: [
      {
        name: 'power-cut alert fires',
        facts: facts({ 'power.cut_alert_present': true }),
        expected: 'fired',
      },
      {
        name: 'a cut during maintenance fires with the window in counterevidence',
        facts: facts({ 'power.cut_alert_present': true, 'maintenance.window_active': true }),
        expected: 'fired',
      },
      {
        name: 'unsupported capability is inapplicable',
        facts: facts({
          'power.cut_alert_present': { missing: 'capability manifest marks power-cut alerts unsupported' },
        }),
        expected: 'not_applicable',
      },
      {
        name: 'no alert, no claim',
        facts: facts({ 'power.cut_alert_present': false }),
        expected: 'did_not_fire',
      },
    ],
    governance: GOVERNANCE,
  },

  {
    id: 'rule.h-device.fault-pattern',
    version: '1.1.0',
    purpose:
      'Recognise device or firmware fault indicators: a reboot on resumption, a sequence reset, ' +
      'or a reviewed fault pattern for this model. Weak on any single indicator.',
    hypothesis: 'H-DEVICE',
    cohorts: ALL_COHORTS,
    // Finding H0: requiring the resumption facts silenced the model-pattern disjunct on every OPEN
    // episode — unknown blocked harder than a known-clean resumption. All three indicators are now
    // optional, and the three-valued evaluator returns not_applicable only when none can be read.
    requiredFacts: [],
    optionalFacts: [
      'device.reboot_after_gap', 'device.sequence_reset', 'device.model_fault_pattern',
      'maintenance.window_active', 'power.cut_alert_present', 'tamper.alert_present',
      'source.health_incident_active',
    ],
    positive: [
      {
        anyOf: [
          { fact: 'device.reboot_after_gap', op: 'eq', value: true },
          { fact: 'device.sequence_reset', op: 'eq', value: true },
          { fact: 'device.model_fault_pattern', op: 'eq', value: true },
        ],
      },
    ],
    negative: [
      // Finding M0: a reboot during approved maintenance is an artifact of the work, not a fault.
      { fact: 'maintenance.window_active', op: 'eq', value: true },
    ],
    counterevidence: [
      {
        // Finding M13: a reboot on resumption is exactly the signature of power being cut and
        // restored; a concurrent direct power signal argues the cause is external, not the device.
        when: { fact: 'power.cut_alert_present', op: 'eq', value: true },
        summary: 'a power-cut indication accompanies the reboot; the cause may be external power, not the device',
      },
      {
        when: { fact: 'tamper.alert_present', op: 'eq', value: true },
        summary: 'a tamper indication accompanies the fault pattern',
      },
      {
        // Finding M1: a vendor-side ingestion incident manufactures sequence artefacts.
        when: { fact: 'source.health_incident_active', op: 'eq', value: true },
        summary: 'a source-wide incident is concurrently active and can produce sequence artefacts',
      },
    ],
    produces: {
      family: 'device_signal',
      strength: 'weak',
      summary: 'device fault indicators are present: reboot, sequence reset or a reviewed model pattern',
    },
    priorityEffect: { factor: 'device-fault-indicators', effect: 'lower' },
    humanReview: false,
    fixtures: [
      {
        name: 'reboot on resumption fires',
        facts: facts({ 'device.reboot_after_gap': true, 'device.sequence_reset': false }),
        expected: 'fired',
      },
      {
        name: 'a reviewed model pattern fires even while the episode is still open',
        facts: facts({
          'device.reboot_after_gap': { missing: 'reporting has not resumed' },
          'device.sequence_reset': { missing: 'reporting has not resumed' },
          'device.model_fault_pattern': true,
        }),
        expected: 'fired',
      },
      {
        name: 'a maintenance-window reboot is work, not a fault',
        facts: facts({
          'device.reboot_after_gap': true, 'device.sequence_reset': false,
          'maintenance.window_active': true,
        }),
        expected: 'did_not_fire',
      },
      {
        name: 'clean resumption does not fire',
        facts: facts({ 'device.reboot_after_gap': false, 'device.sequence_reset': false }),
        expected: 'did_not_fire',
      },
      {
        name: 'nothing readable at all: inapplicable, not clean',
        facts: facts({
          'device.reboot_after_gap': { missing: 'reporting has not resumed' },
          'device.sequence_reset': { missing: 'reporting has not resumed' },
          'device.model_fault_pattern': { missing: 'no reviewed analysis for this model' },
        }),
        expected: 'not_applicable',
      },
    ],
    governance: GOVERNANCE,
  },

  {
    id: 'rule.h-tamper.direct-signal',
    version: '1.1.0',
    purpose:
      'Carry a device-reported tamper or unplug indication. The summary is the exact phrase ' +
      '§11.5 mandates, and nothing stronger can be said by any rule in this system.',
    hypothesis: 'H-TAMPER',
    cohorts: ALL_COHORTS,
    requiredFacts: ['tamper.alert_present'],
    optionalFacts: [
      'source.health_incident_active', 'movement.moving_before_gap', 'maintenance.window_active',
    ],
    positive: [{ fact: 'tamper.alert_present', op: 'eq', value: true }],
    negative: [],
    counterevidence: [
      {
        when: { fact: 'source.health_incident_active', op: 'eq', value: true },
        summary: 'a source-wide incident is concurrently active on this platform',
      },
      {
        when: { fact: 'maintenance.window_active', op: 'eq', value: true },
        summary: 'an approved maintenance or installation window covers this gap',
      },
    ],
    produces: {
      family: 'device_signal',
      strength: 'direct',
      summary: TAMPER_REQUIRED_PHRASE,
    },
    priorityEffect: { factor: 'direct-tamper-indication', effect: 'raise' },
    humanReview: true,
    fixtures: [
      {
        name: 'tamper alert fires',
        facts: facts({ 'tamper.alert_present': true }),
        expected: 'fired',
      },
      {
        name: 'unsupported tamper capability is inapplicable',
        facts: facts({
          'tamper.alert_present': { missing: 'capability manifest marks tamper alerts unsupported' },
        }),
        expected: 'not_applicable',
      },
      {
        name: 'no alert, no claim',
        facts: facts({ 'tamper.alert_present': false }),
        expected: 'did_not_fire',
      },
    ],
    governance: GOVERNANCE,
  },

  {
    id: 'rule.h-tamper.network-jamming',
    version: '1.1.0',
    purpose:
      'Carry a device-reported network jamming indication as direct interference evidence. The ' +
      'vocabulary and derivation supported this signal from the start; no rule read it, so a ' +
      'direct indication had no effect on any classification (finding M15).',
    hypothesis: 'H-TAMPER',
    cohorts: ALL_COHORTS,
    requiredFacts: ['network.jamming_alert'],
    optionalFacts: ['source.health_incident_active'],
    positive: [{ fact: 'network.jamming_alert', op: 'eq', value: true }],
    negative: [],
    counterevidence: [
      {
        when: { fact: 'source.health_incident_active', op: 'eq', value: true },
        summary: 'a source-wide incident is concurrently active on this platform',
      },
    ],
    produces: {
      family: 'device_signal',
      strength: 'direct',
      summary: TAMPER_REQUIRED_PHRASE,
    },
    priorityEffect: { factor: 'direct-network-jamming-indication', effect: 'raise' },
    humanReview: true,
    fixtures: [
      {
        name: 'network jamming flag fires',
        facts: facts({ 'network.jamming_alert': true }),
        expected: 'fired',
      },
      {
        name: 'deep sleep makes the rule inapplicable, never false',
        facts: facts({
          'network.jamming_alert': { missing: 'jamming detectors are disabled in deep sleep' },
        }),
        expected: 'not_applicable',
      },
      {
        name: 'no flag, no claim',
        facts: facts({ 'network.jamming_alert': false }),
        expected: 'did_not_fire',
      },
    ],
    governance: GOVERNANCE,
  },
]

// ---------------------------------------------------------------- contradictions

/**
 * The explicit contradicts relation from ticket 37: cross-hypothesis suppression stated once,
 * rather than copy-pasted into every rule and left to drift.
 *
 * Suppression semantics live in the classifier, and two rules there are absolute: **direct evidence
 * is never suppressed** (§17.2 — a source-wide failure must not mask a direct individual signal),
 * and suppression is decided **per fired entry**, so a direct alert is untouched by the suppression
 * of a weak inference that happens to share its hypothesis. A suppressed non-direct entry keeps its
 * record, gains counterevidence naming the suppressor, is capped at weak, and loses urgent
 * eligibility. An `unless` clause that cannot be evaluated withholds suppression — an unread
 * exception is not a checked one.
 */
export interface Contradiction {
  readonly suppressor: HypothesisCode
  readonly suppressed: HypothesisCode
  /** When any of these hold, no suppression occurs at all. */
  readonly unless: readonly Predicate[]
  readonly rationale: string
}

export const CONTRADICTIONS: readonly Contradiction[] = [
  {
    suppressor: 'H-VENDOR',
    suppressed: 'H-TAMPER',
    unless: [],
    rationale:
      'a platform-wide receipt failure explains individual silence without interference; ' +
      'escalating every affected device as suspected interference would flood the queue with ' +
      'cases the incident already explains',
  },
  {
    suppressor: 'H-NETWORK',
    suppressed: 'H-TAMPER',
    unless: [],
    rationale:
      'a correlated network incident explains individual silence without interference',
  },
]

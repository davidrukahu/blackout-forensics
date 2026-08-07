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
 */

import { available, unavailable, type FactSet } from './facts.js'
import type { HypothesisCode, Predicate, RulePackage } from './package.js'
import { TAMPER_REQUIRED_PHRASE } from './package.js'

const GOVERNANCE = {
  owner: 'rules-steward',
  technicalReviewer: 'eng-reviewer',
  riskApprover: 'ops-approver',
  approvedOn: '2026-08-07',
  effectiveFrom: '2026-08-07T00:00:00.000Z',
  effectiveTo: null,
  rollbackTo: null,
} as const

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
    version: '1.0.0',
    purpose:
      'Recognise a gap that the effective reporting policy predicts: a parked or sleeping state ' +
      'whose interval was declared, with no direct alert arguing otherwise.',
    hypothesis: 'H-EXPECTED',
    requiredFacts: ['episode.type', 'policy.state_at_gap', 'policy.weak_basis'],
    optionalFacts: [
      'power.cut_alert_present', 'tamper.alert_present', 'maintenance.window_active',
      'episode.missed_reports',
    ],
    positive: [
      { fact: 'policy.state_at_gap', op: 'in', values: ['sleep', 'parked'] },
      // A sleep interval that was measured or assumed cannot certify an expected gap: sleep
      // provenance is the dominant false-positive source, and weak basis is its marker.
      { fact: 'policy.weak_basis', op: 'eq', value: false },
    ],
    negative: [
      { fact: 'power.cut_alert_present', op: 'eq', value: true },
      { fact: 'tamper.alert_present', op: 'eq', value: true },
    ],
    counterevidence: [
      {
        when: { fact: 'episode.missed_reports', op: 'gte', value: 10 },
        summary: 'the gap has outlasted many expected sleep cycles',
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
        name: 'declared parked gap fires',
        facts: facts({
          'episode.type': 'total_silence', 'policy.state_at_gap': 'parked',
          'policy.weak_basis': false, 'episode.missed_reports': 2,
        }),
        expected: 'fired',
      },
      {
        name: 'weak sleep basis does not certify',
        facts: facts({
          'episode.type': 'total_silence', 'policy.state_at_gap': 'sleep', 'policy.weak_basis': true,
        }),
        expected: 'did_not_fire',
      },
      {
        name: 'a power-cut alert blocks the expected reading',
        facts: facts({
          'episode.type': 'total_silence', 'policy.state_at_gap': 'parked',
          'policy.weak_basis': false, 'power.cut_alert_present': true,
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
    version: '1.0.0',
    purpose:
      'Recognise GNSS-only loss: reporting continued on schedule while position quality failed. ' +
      'This is a statement about the positioning subsystem, and about nothing else.',
    hypothesis: 'H-GNSS',
    requiredFacts: ['episode.type', 'gnss.reports_continued'],
    optionalFacts: [
      'maintenance.window_active', 'movement.moving_before_gap', 'device.sleep_state_before_gap',
    ],
    positive: [
      { fact: 'episode.type', op: 'eq', value: 'gnss_only_loss' },
      { fact: 'gnss.reports_continued', op: 'eq', value: true },
    ],
    negative: [
      { fact: 'maintenance.window_active', op: 'eq', value: true },
      // Deep Sleep emits stale, invalid coordinates by design. Reading documented sleep behaviour
      // as GNSS loss blames the fleet for following its own configuration — the corpus baseline
      // caught this rule doing exactly that on the deep-sleep scenario.
      { fact: 'device.sleep_state_before_gap', op: 'eq', value: 'deep_sleep' },
    ],
    counterevidence: [],
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
    version: '1.0.0',
    purpose:
      'Carry a device-reported GNSS jamming indication as direct evidence. Applicable only when ' +
      'the detector could actually run — deep sleep disables it, and the fact goes unavailable ' +
      'rather than false.',
    hypothesis: 'H-GNSS',
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
    version: '1.0.0',
    purpose:
      'Recognise a platform ingestion incident: independent devices on the same source showing ' +
      'correlated receipt failure. Says the platform stopped delivering — nothing about networks.',
    hypothesis: 'H-VENDOR',
    requiredFacts: ['source.independent_devices'],
    optionalFacts: ['source.health_incident_active'],
    // FR-COR-002: minimum independent devices before a provider incident may be shown, default 3,
    // with devices sharing an asset or data path already excluded from the count (FR-COR-003).
    positive: [{ fact: 'source.independent_devices', op: 'gte', value: 3 }],
    negative: [],
    counterevidence: [],
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
        name: 'no peer run, no claim',
        facts: facts({ 'source.independent_devices': { missing: 'peer correlation has not run' } }),
        expected: 'not_applicable',
      },
    ],
    governance: GOVERNANCE,
  },

  {
    id: 'rule.h-network.operator-cluster',
    version: '1.0.0',
    purpose:
      'Recognise a correlated SIM or network incident: independent devices sharing a network ' +
      'identity going silent together, where that identity was actually observed.',
    hypothesis: 'H-NETWORK',
    requiredFacts: ['network.independent_devices', 'network.identity_known'],
    optionalFacts: [],
    positive: [
      { fact: 'network.independent_devices', op: 'gte', value: 3 },
      { fact: 'network.identity_known', op: 'eq', value: true },
    ],
    negative: [],
    counterevidence: [],
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
    version: '1.0.0',
    purpose:
      'Carry a qualified corridor baseline as weak context: this stretch of road produces gaps ' +
      'above the fleet base rate. A reason to look — never a route, and never a coverage claim.',
    hypothesis: 'H-CORRIDOR',
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
        name: 'unevaluated corridor is inapplicable',
        facts: facts({ 'corridor.recurrence_qualified': { missing: 'baseline not evaluated' } }),
        expected: 'not_applicable',
      },
    ],
    governance: GOVERNANCE,
  },

  {
    id: 'rule.h-power.external-cut',
    version: '1.0.0',
    purpose:
      'Carry a device-reported loss of external power as direct evidence. H-POWER means the ' +
      'tracker lost external power — §11.5 is explicit that it does not identify who or what ' +
      'caused it, and this rule says nothing more.',
    hypothesis: 'H-POWER',
    requiredFacts: ['power.cut_alert_present'],
    optionalFacts: ['source.health_incident_active', 'movement.moving_before_gap'],
    positive: [{ fact: 'power.cut_alert_present', op: 'eq', value: true }],
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
    version: '1.0.0',
    purpose:
      'Recognise device or firmware fault indicators: a reboot on resumption, a sequence reset, ' +
      'or a reviewed fault pattern for this model. Weak on any single indicator.',
    hypothesis: 'H-DEVICE',
    requiredFacts: ['device.reboot_after_gap', 'device.sequence_reset'],
    optionalFacts: ['device.model_fault_pattern'],
    positive: [
      {
        anyOf: [
          { fact: 'device.reboot_after_gap', op: 'eq', value: true },
          { fact: 'device.sequence_reset', op: 'eq', value: true },
          { fact: 'device.model_fault_pattern', op: 'eq', value: true },
        ],
      },
    ],
    negative: [],
    counterevidence: [],
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
        name: 'model pattern alone fires even when unrequired',
        facts: facts({
          'device.reboot_after_gap': false, 'device.sequence_reset': false,
          'device.model_fault_pattern': true,
        }),
        expected: 'fired',
      },
      {
        name: 'nothing resumed yet: inapplicable, not clean',
        facts: facts({
          'device.reboot_after_gap': { missing: 'reporting has not resumed' },
          'device.sequence_reset': { missing: 'reporting has not resumed' },
        }),
        expected: 'not_applicable',
      },
      {
        name: 'clean resumption does not fire',
        facts: facts({ 'device.reboot_after_gap': false, 'device.sequence_reset': false }),
        expected: 'did_not_fire',
      },
    ],
    governance: GOVERNANCE,
  },

  {
    id: 'rule.h-tamper.direct-signal',
    version: '1.0.0',
    purpose:
      'Carry a device-reported tamper or unplug indication. The summary is the exact phrase ' +
      '§11.5 mandates, and nothing stronger can be said by any rule in this system.',
    hypothesis: 'H-TAMPER',
    requiredFacts: ['tamper.alert_present'],
    optionalFacts: ['source.health_incident_active', 'movement.moving_before_gap'],
    positive: [{ fact: 'tamper.alert_present', op: 'eq', value: true }],
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
]

// ---------------------------------------------------------------- contradictions

/**
 * The explicit contradicts relation from ticket 37: cross-hypothesis suppression stated once,
 * rather than copy-pasted into every rule and left to drift.
 *
 * Suppression semantics live in the classifier, and one rule there is absolute: **direct evidence
 * is never suppressed** (§17.2 — a source-wide failure must not mask a direct individual signal).
 * A suppressed non-direct hypothesis keeps its record, gains counterevidence naming the suppressor,
 * is capped at weak, and loses urgent eligibility. A direct one gains the note and loses nothing.
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

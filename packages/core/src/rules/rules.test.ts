// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { FACT_VOCABULARY, available, deriveFacts, unavailable, type FactSet } from './facts.js'
import {
  TAMPER_REQUIRED_PHRASE,
  evaluateRule,
  validateRulePackage,
  type RulePackage,
} from './package.js'
import { CONTRADICTIONS, RULE_PACKAGES } from './packages.js'

const tamperRule = RULE_PACKAGES.find((r) => r.id === 'rule.h-tamper.direct-signal') as RulePackage
const deviceRule = RULE_PACKAGES.find((r) => r.id === 'rule.h-device.fault-pattern') as RulePackage
const expectedRule = RULE_PACKAGES.find((r) => r.id === 'rule.h-expected.policy-match') as RulePackage

describe('every shipped package validates clean', () => {
  it.each(RULE_PACKAGES.map((r) => [r.id, r] as const))('%s', (_, rule) => {
    expect(validateRulePackage(rule)).toEqual([])
  })

  it('ships a rule for every hypothesis except H-UNKNOWN', () => {
    const covered = new Set(RULE_PACKAGES.map((r) => r.hypothesis))
    expect([...covered].sort()).toEqual([
      'H-CORRIDOR', 'H-DEVICE', 'H-EXPECTED', 'H-GNSS', 'H-NETWORK', 'H-POWER', 'H-TAMPER', 'H-VENDOR',
    ])
  })

  it('the fixtures are executed by validation, not merely counted', () => {
    // A drifted fixture is a violation: a package cannot silently diverge from its stated behaviour.
    const drifted: RulePackage = {
      ...tamperRule,
      fixtures: [
        { name: 'wrong expectation', facts: { 'tamper.alert_present': available(true) }, expected: 'did_not_fire' },
        { name: 'fine', facts: { 'tamper.alert_present': available(false) }, expected: 'did_not_fire' },
      ],
    }
    expect(validateRulePackage(drifted).map((v) => v.code)).toContain('fixture-drift')
  })
})

describe('the vocabulary is closed', () => {
  it('rejects a rule referencing a fact outside the vocabulary', () => {
    const rogue: RulePackage = {
      ...tamperRule,
      requiredFacts: ['borrower.risk_score'],
      fixtures: tamperRule.fixtures,
    }
    const codes = validateRulePackage(rogue).map((v) => v.code)
    expect(codes).toContain('vocabulary')
  })

  it('rejects a condition on an undeclared fact', () => {
    const sneaky: RulePackage = {
      ...tamperRule,
      positive: [{ fact: 'corridor.recurrence_qualified', op: 'eq', value: false }],
    }
    expect(validateRulePackage(sneaky).map((v) => v.code)).toContain('undeclared-fact')
  })

  it('contains no cell-derived fact at all — FR-CLS-005 by construction', () => {
    // The cheapest proof that removing the cell layer cannot change a classification: no rule can
    // reference it, because the vocabulary has nothing to reference.
    for (const fact of FACT_VOCABULARY) {
      expect(fact.name).not.toMatch(/cell|opencellid/i)
    }
  })
})

describe('prohibited wording is enforced, not trusted', () => {
  it('rejects a summary claiming what the evidence cannot say', () => {
    const overclaiming: RulePackage = {
      ...tamperRule,
      produces: { ...tamperRule.produces, summary: 'probable theft in progress' },
    }
    const codes = validateRulePackage(overclaiming).map((v) => v.code)
    expect(codes).toContain('prohibited-wording')
    // And breaking the exact §11.5 phrase is its own violation.
    expect(codes).toContain('tamper-phrase')
  })

  it('rejects borrower language anywhere in a package', () => {
    const blaming: RulePackage = {
      ...expectedRule,
      purpose: 'Detect when the borrower has parked the asset overnight.',
    }
    expect(validateRulePackage(blaming).map((v) => v.code)).toContain('prohibited-wording')
  })

  it('H-TAMPER carries the exact mandated phrase', () => {
    expect(tamperRule.produces.summary).toBe(TAMPER_REQUIRED_PHRASE)
  })

  it('a direct-evidence rule must require human review', () => {
    const unreviewed: RulePackage = { ...tamperRule, humanReview: false }
    expect(validateRulePackage(unreviewed).map((v) => v.code)).toContain('review')
  })

  it('§3.3 requires two different approvers', () => {
    const selfApproved: RulePackage = {
      ...tamperRule,
      governance: { ...tamperRule.governance, riskApprover: tamperRule.governance.technicalReviewer },
    }
    expect(validateRulePackage(selfApproved).map((v) => v.code)).toContain('governance')
  })
})

describe('three-valued evaluation', () => {
  it('an unavailable required fact is not-applicable, never false', () => {
    const outcome = evaluateRule(tamperRule, {
      'tamper.alert_present': unavailable('capability manifest marks tamper alerts unsupported'),
    })
    expect(outcome.kind).toBe('not_applicable')
    if (outcome.kind === 'not_applicable') {
      expect(outcome.missingFacts).toEqual(['tamper.alert_present'])
    }
  })

  it('an unavailable optional fact in anyOf is skipped, not treated as false', () => {
    // The model-pattern branch is unknown; the reboot branch carries the decision.
    const outcome = evaluateRule(deviceRule, {
      'device.reboot_after_gap': available(true),
      'device.sequence_reset': available(false),
      'device.model_fault_pattern': unavailable('no reviewed analysis'),
    })
    expect(outcome.kind).toBe('fired')
    if (outcome.kind === 'fired') {
      expect(outcome.missingExpected).toContain('device.model_fault_pattern')
    }
  })

  it('an unknown negative condition does not block — you cannot prove a negative you could not read', () => {
    const outcome = evaluateRule(expectedRule, {
      'episode.type': available('total_silence'),
      'policy.state_at_gap': available('parked'),
      'policy.weak_basis': available(false),
      'policy.sleep_provenance': available('declared'),
      'power.cut_alert_present': unavailable('unsupported'),
      'tamper.alert_present': unavailable('unsupported'),
    })
    expect(outcome.kind).toBe('fired')
    if (outcome.kind === 'fired') {
      // But what could not be checked is recorded, so the analyst sees the hole.
      expect(outcome.missingExpected).toEqual(
        expect.arrayContaining(['power.cut_alert_present', 'tamper.alert_present']),
      )
    }
  })

  it('counterevidence is evaluated even when the rule fires', () => {
    const outcome = evaluateRule(tamperRule, {
      'tamper.alert_present': available(true),
      'source.health_incident_active': available(true),
    })
    expect(outcome.kind).toBe('fired')
    if (outcome.kind === 'fired') {
      expect(outcome.counterevidence).toHaveLength(1)
    }
  })

  it('never throws, whatever fact set it is given', () => {
    const arbitraryFact = fc.oneof(
      fc.record({ status: fc.constant('available' as const), value: fc.oneof(fc.string(), fc.integer(), fc.boolean()) }),
      fc.record({ status: fc.constant('unavailable' as const), reason: fc.string() }),
    )
    fc.assert(
      fc.property(
        fc.dictionary(fc.constantFrom(...FACT_VOCABULARY.map((f) => f.name)), arbitraryFact),
        (factSet) => {
          for (const rule of RULE_PACKAGES) {
            const outcome = evaluateRule(rule, factSet as FactSet)
            if (!['fired', 'did_not_fire', 'not_applicable'].includes(outcome.kind)) return false
          }
          return true
        },
      ),
      { numRuns: 250 },
    )
  })
})

describe('fact derivation carries the traps', () => {
  it('deep sleep disables the jamming facts regardless of capability', () => {
    const facts = deriveFacts({
      lastObservations: { moving: false, externalPowerState: 'present', sleepState: 'deep_sleep' },
      alerts: { powerCut: false, tamper: false, gnssJamming: false, networkJamming: false },
      capabilities: ['alerts.gnss_jamming', 'alerts.network_jamming', 'alerts.power_cut', 'alerts.tamper'],
    })
    expect(facts['gnss.jamming_alert']?.status).toBe('unavailable')
    expect(facts['network.jamming_alert']?.status).toBe('unavailable')
    // Power and tamper detectors are not GNSS detectors; they survive sleep.
    expect(facts['power.cut_alert_present']?.status).toBe('available')
  })

  it('an unsupported capability is unavailable, never false', () => {
    const facts = deriveFacts({
      alerts: { powerCut: false, tamper: false, gnssJamming: null, networkJamming: null },
      capabilities: ['alerts.power_cut'],
    })
    expect(facts['tamper.alert_present']?.status).toBe('unavailable')
    expect(facts['power.cut_alert_present']).toEqual(available(false))
  })

  it('absent input sections become unavailable facts with a reason, not defaults', () => {
    const facts = deriveFacts({})
    for (const fact of Object.values(facts)) {
      expect(fact.status).toBe('unavailable')
    }
  })
})

describe('the contradicts table', () => {
  it('names only real hypotheses and carries a rationale', () => {
    const codes = new Set(RULE_PACKAGES.map((r) => r.hypothesis as string))
    for (const contradiction of CONTRADICTIONS) {
      expect(codes.has(contradiction.suppressor)).toBe(true)
      expect(codes.has(contradiction.suppressed)).toBe(true)
      expect(contradiction.rationale.length).toBeGreaterThan(20)
    }
  })
})

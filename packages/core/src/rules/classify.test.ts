// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest'

import { FACT_VOCABULARY_VERSION, available, unavailable, type FactSet } from './facts.js'
import { classify } from './classify.js'
import { CONTRADICTIONS, RULE_PACKAGES } from './packages.js'
import type { RulePackage } from './package.js'

const AT = '2026-09-01T00:00:00.000Z'

const run = (facts: FactSet, packages: readonly RulePackage[] = RULE_PACKAGES) =>
  classify({
    facts,
    packages,
    contradictions: CONTRADICTIONS,
    at: AT,
    factVocabularyVersion: FACT_VOCABULARY_VERSION,
  })

describe('FR-CLS-003: every non-unknown result carries the full record', () => {
  it('evidence, counterevidence, missing expected, band and rule version are all present', () => {
    const result = run({
      'power.cut_alert_present': available(true),
      'source.health_incident_active': available(true),
    })
    const power = result.hypotheses.find((h) => h.code === 'H-POWER')
    expect(power).toBeDefined()
    expect(power?.evidence.summary).toContain('external power')
    expect(power?.counterevidence).toHaveLength(1)
    expect(power?.missingExpected).toContain('movement.moving_before_gap')
    expect(power?.band).toBe('direct')
    expect(power?.ruleId).toBe('rule.h-power.external-cut')
    expect(power?.ruleVersion).toBe('1.0.0')
  })
})

describe('FR-CLS-004: hypotheses coexist', () => {
  it('a platform incident and a weak corridor prior stand together without a forced single label', () => {
    const result = run({
      'source.independent_devices': available(5),
      'corridor.recurrence_qualified': available(true),
    })
    const codes = result.hypotheses.map((h) => h.code).sort()
    expect(codes).toEqual(['H-CORRIDOR', 'H-VENDOR'])
    expect(result.unknown).toBeNull()
  })
})

describe('the Deep Sleep trap, end to end', () => {
  it('a sleeping device makes the jamming rule inapplicable and lists the missing fact', () => {
    const result = run({
      'gnss.jamming_alert': unavailable('jamming detectors are disabled in deep sleep'),
    })
    const jamming = result.notApplicable.find((r) => r.ruleId === 'rule.h-gnss.jamming-flag')
    expect(jamming).toBeDefined()
    expect(jamming?.missingFacts).toEqual(['gnss.jamming_alert'])
    // And nothing fired from it — the absence produced no evidence in either direction.
    expect(result.hypotheses.find((h) => h.ruleId === 'rule.h-gnss.jamming-flag')).toBeUndefined()
  })
})

describe('the vendor-outage traps, both halves', () => {
  it('§17.2: a source-wide incident suppresses a non-direct interference reading', () => {
    // Constructed weak-tamper package: the shipped rule is direct-only, so the suppression path
    // needs a non-direct variant to exercise — precisely the shape a future inference rule takes.
    const weakTamper: RulePackage = {
      ...(RULE_PACKAGES.find((r) => r.id === 'rule.h-tamper.direct-signal') as RulePackage),
      id: 'rule.h-tamper.silence-inference',
      produces: {
        family: 'device_signal',
        strength: 'corroborated',
        summary: 'device telemetry supports possible tracker interference',
      },
    }
    const result = run(
      {
        'tamper.alert_present': available(true),
        'source.independent_devices': available(6),
      },
      [...RULE_PACKAGES.filter((r) => r.hypothesis !== 'H-TAMPER'), weakTamper],
    )

    const tamper = result.hypotheses.find((h) => h.code === 'H-TAMPER')
    expect(tamper?.suppressedBy).toBe('H-VENDOR')
    expect(tamper?.band).toBe('weak')
    expect(tamper?.counterevidence.some((c) => c.summary.startsWith('suppressed:'))).toBe(true)
    // A suppressed hypothesis cannot carry urgency.
    expect(result.urgentEligible).toBe(false)
    // Its priority factor stays visible with no effect — considered and set aside, not hidden.
    const factor = result.priorityFactors.find((f) => f.fromRule === weakTamper.id)
    expect(factor?.effect).toBe('none')
  })

  it('§15.2: the same incident cannot mask a direct signal', () => {
    const result = run({
      'tamper.alert_present': available(true),
      'power.cut_alert_present': available(true),
      'source.independent_devices': available(6),
      'source.health_incident_active': available(true),
    })

    const tamper = result.hypotheses.find((h) => h.code === 'H-TAMPER')
    const power = result.hypotheses.find((h) => h.code === 'H-POWER')

    // Direct evidence survives suppression entirely: band intact, urgency intact, note attached.
    expect(tamper?.suppressedBy).toBeNull()
    expect(tamper?.band).toBe('direct')
    expect(tamper?.counterevidence.some((c) => c.summary.includes('preserved'))).toBe(true)
    expect(power?.band).toBe('direct')
    expect(result.urgentEligible).toBe(true)
  })
})

describe('FR-CLS-007: weak evidence never reaches urgency', () => {
  it('a corridor prior alone is not urgent-eligible', () => {
    const result = run({ 'corridor.recurrence_qualified': available(true) })
    expect(result.hypotheses.map((h) => h.code)).toEqual(['H-CORRIDOR'])
    expect(result.urgentEligible).toBe(false)
  })

  it('two corroborated families are', () => {
    const result = run({
      'source.independent_devices': available(4),
      'network.independent_devices': available(4),
      'network.identity_known': available(true),
    })
    expect(result.urgentEligible).toBe(true)
  })

  it('corroborated with material counterevidence degrades to weak and loses urgency', () => {
    const result = run({
      'episode.type': available('total_silence'),
      'episode.missed_reports': available(50),
      'policy.state_at_gap': available('parked'),
      'policy.weak_basis': available(false),
    })
    const expected = result.hypotheses.find((h) => h.code === 'H-EXPECTED')
    // The gap outlasted many sleep cycles: counterevidence fired, so corroborated cannot stand.
    expect(expected?.counterevidence).toHaveLength(1)
    expect(expected?.band).toBe('weak')
    expect(result.urgentEligible).toBe(false)
  })
})

describe('H-UNKNOWN is the classifier speaking, not a rule', () => {
  it('emits unknown with the union of missing evidence when nothing fires', () => {
    const result = run({})
    expect(result.hypotheses).toEqual([])
    expect(result.unknown).not.toBeNull()
    expect(result.unknown?.reason).toBe('evidence is missing, conflicting or below threshold')
    expect(result.unknown?.missingExpected.length).toBeGreaterThan(5)
    expect(result.urgentEligible).toBe(false)
  })

  it('does not emit unknown when anything fired', () => {
    const result = run({ 'corridor.recurrence_qualified': available(true) })
    expect(result.unknown).toBeNull()
  })
})

describe('rules are filtered by effective date, so replay uses the rules of the day', () => {
  it('a rule not yet effective does not run', () => {
    const future: RulePackage = {
      ...(RULE_PACKAGES.find((r) => r.id === 'rule.h-corridor.recurrence') as RulePackage),
      governance: {
        ...(RULE_PACKAGES.find((r) => r.id === 'rule.h-corridor.recurrence') as RulePackage).governance,
        effectiveFrom: '2027-01-01T00:00:00.000Z',
      },
    }
    const result = run(
      { 'corridor.recurrence_qualified': available(true) },
      [future],
    )
    expect(result.hypotheses).toEqual([])
    expect(result.unknown).not.toBeNull()
  })

  it('a retired rule does not run either', () => {
    const retired: RulePackage = {
      ...(RULE_PACKAGES.find((r) => r.id === 'rule.h-corridor.recurrence') as RulePackage),
      governance: {
        ...(RULE_PACKAGES.find((r) => r.id === 'rule.h-corridor.recurrence') as RulePackage).governance,
        effectiveTo: '2026-01-01T00:00:00.000Z',
      },
    }
    expect(run({ 'corridor.recurrence_qualified': available(true) }, [retired]).hypotheses).toEqual([])
  })
})

describe('§5.3: priority is named factors, never a hidden score', () => {
  it('every fired hypothesis surfaces its factor by name', () => {
    const result = run({
      'power.cut_alert_present': available(true),
      'source.independent_devices': available(4),
    })
    const factors = Object.fromEntries(result.priorityFactors.map((f) => [f.factor, f.effect]))
    expect(factors['direct-power-evidence']).toBe('raise')
    expect(factors['peer-incident-explains-gap']).toBe('lower')
  })
})

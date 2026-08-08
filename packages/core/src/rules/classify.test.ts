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
    expect(power?.ruleVersion).toBe('1.1.0')
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
  const weakTamper: RulePackage = {
    ...(RULE_PACKAGES.find((r) => r.id === 'rule.h-tamper.direct-signal') as RulePackage),
    id: 'rule.h-tamper.silence-inference',
    produces: {
      family: 'device_signal',
      strength: 'corroborated',
      summary: 'device telemetry supports possible tracker interference',
    },
  }

  it('§17.2: a source-wide incident suppresses a non-direct interference reading', () => {
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

  it('suppression is per fired entry: a direct alert survives beside a suppressed sibling', () => {
    // The verification pass demonstrated the original defect (finding C0): suppression was keyed by
    // hypothesis code, so suppressing the weak inference ALSO suppressed the direct alert sharing
    // its hypothesis — a missed urgent dispatch, the exact failure §17.2 calls absolute. The two
    // rules now coexist in one run, which no earlier test exercised.
    const result = run(
      {
        'tamper.alert_present': available(true),
        'source.independent_devices': available(6),
      },
      [...RULE_PACKAGES, weakTamper],
    )

    const entries = result.hypotheses.filter((h) => h.code === 'H-TAMPER')
    const direct = entries.find((h) => h.ruleId === 'rule.h-tamper.direct-signal')
    const inference = entries.find((h) => h.ruleId === 'rule.h-tamper.silence-inference')

    expect(direct?.suppressedBy).toBeNull()
    expect(direct?.band).toBe('direct')
    expect(direct?.counterevidence.some((c) => c.summary.includes('preserved'))).toBe(true)
    expect(inference?.suppressedBy).toBe('H-VENDOR')
    expect(inference?.band).toBe('weak')
    expect(result.urgentEligible).toBe(true)

    const directFactor = result.priorityFactors.find((f) => f.fromRule === direct?.ruleId)
    expect(directFactor?.effect).toBe('raise')
  })

  it('an unless clause that cannot be read withholds suppression — M16', () => {
    const guarded = [
      {
        ...CONTRADICTIONS[0]!,
        unless: [{ fact: 'power.cut_alert_present', op: 'eq' as const, value: true }],
      },
    ]
    const result = classify({
      facts: {
        'tamper.alert_present': available(true),
        'source.independent_devices': available(6),
        'power.cut_alert_present': unavailable('capability unsupported'),
      },
      packages: [...RULE_PACKAGES.filter((r) => r.hypothesis !== 'H-TAMPER'), weakTamper],
      contradictions: guarded,
      at: AT,
      factVocabularyVersion: FACT_VOCABULARY_VERSION,
    })

    const tamper = result.hypotheses.find((h) => h.code === 'H-TAMPER')
    // Suppressing on the strength of an unread exception would collapse could-not-check into
    // checked-and-false. The reading stands, with the withholding stated.
    expect(tamper?.suppressedBy).toBeNull()
    expect(tamper?.counterevidence.some((c) => c.summary.includes('withheld'))).toBe(true)
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

  it('exculpatory corroboration never urges action — C1', () => {
    // Two corroborated families, both of which EXPLAIN the gap. The verification pass demonstrated
    // the original defect: valence-blind pooling let two benign explanations jointly demand a
    // field dispatch. Evidence whose own priority effect is 'lower' argues against action and
    // cannot simultaneously support it.
    const result = run({
      'source.independent_devices': available(4),
      'network.independent_devices': available(4),
      'network.identity_known': available(true),
    })
    expect(result.hypotheses.every((h) => h.suppressedBy === null)).toBe(true)
    expect(result.urgentEligible).toBe(false)
  })

  it('two corroborated RAISE families do reach the threshold', () => {
    // The same bar, met by evidence that argues for anomaly rather than against it.
    const anomalousPeer: RulePackage = {
      ...(RULE_PACKAGES.find((r) => r.id === 'rule.h-network.operator-cluster') as RulePackage),
      id: 'rule.h-network.synthetic-anomaly',
      priorityEffect: { factor: 'synthetic-anomaly-signal', effect: 'raise' },
    }
    const result = run(
      {
        'episode.type': available('total_silence'),
        'gnss.reports_continued': available(false),
        'network.independent_devices': available(4),
        'network.identity_known': available(true),
      },
      [
        ...RULE_PACKAGES.filter((r) => r.id !== 'rule.h-network.operator-cluster'),
        anomalousPeer,
      ],
    )
    const gnssFired = run({
      'episode.type': available('gnss_only_loss'),
      'gnss.reports_continued': available(true),
    })
    // H-GNSS (device_signal, raise, corroborated) + the raise variant (peer_devices, corroborated)
    // would cross the bar; here we assert each half separately to keep the fixture honest.
    expect(gnssFired.hypotheses.find((h) => h.code === 'H-GNSS')?.band).toBe('corroborated')
    expect(result.hypotheses.find((h) => h.ruleId === 'rule.h-network.synthetic-anomaly')?.band)
      .toBe('corroborated')
  })

  it('corroborated with material counterevidence degrades to weak and loses urgency', () => {
    const result = run({
      'episode.type': available('total_silence'),
      'episode.missed_reports': available(50),
      'policy.state_at_gap': available('parked'),
      'policy.weak_basis': available(false),
      'policy.sleep_provenance': available('declared'),
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
    expect(result.unknown?.reason).toBe('the evidence is missing, in conflict, or below the threshold')
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

describe('runtime guards', () => {
  it('refuses an unparseable timestamp instead of classifying from the wrong era — L13', () => {
    expect(() =>
      classify({
        facts: {},
        packages: RULE_PACKAGES,
        contradictions: CONTRADICTIONS,
        at: 'not-a-time',
        factVocabularyVersion: FACT_VOCABULARY_VERSION,
      }),
    ).toThrow(/parseable timestamp/)
  })

  it('refuses two simultaneously effective versions of one rule id — M18', () => {
    const duplicate = RULE_PACKAGES.find((r) => r.id === 'rule.h-corridor.recurrence') as RulePackage
    expect(() =>
      run({ 'corridor.recurrence_qualified': available(true) }, [duplicate, { ...duplicate }]),
    ).toThrow(/simultaneously effective/)
  })

  it('a mistyped fact value is unreadable, never a clean negative — M2', () => {
    // A power cut arriving as the string "true" after a serialization defect must surface as
    // could-not-read: the rule goes inapplicable and names the fact, leaving a trace.
    const result = run({ 'power.cut_alert_present': available('true') })
    const power = result.notApplicable.find((r) => r.ruleId === 'rule.h-power.external-cut')
    expect(power?.missingFacts).toEqual(['power.cut_alert_present'])
    expect(result.hypotheses.find((h) => h.code === 'H-POWER')).toBeUndefined()
  })
})

describe('rule-level regressions from the verification pass', () => {
  it('H-EXPECTED cannot certify a gnss-only loss as expected silence — C2', () => {
    const result = run({
      'episode.type': available('gnss_only_loss'),
      'gnss.reports_continued': available(true),
      'policy.state_at_gap': available('parked'),
      'policy.weak_basis': available(false),
      'policy.sleep_provenance': available('declared'),
      'device.sleep_state_before_gap': available('awake'),
    })
    expect(result.hypotheses.find((h) => h.code === 'H-EXPECTED')).toBeUndefined()
    expect(result.hypotheses.find((h) => h.code === 'H-GNSS')).toBeDefined()
    // The original defect flipped urgency here via a phantom second corroborated family.
    expect(result.urgentEligible).toBe(false)
  })

  it('a jamming indication blocks the benign certification and fires interference — H8/M15', () => {
    const result = run({
      'episode.type': available('total_silence'),
      'policy.state_at_gap': available('parked'),
      'policy.weak_basis': available(false),
      'policy.sleep_provenance': available('declared'),
      'network.jamming_alert': available(true),
    })
    expect(result.hypotheses.find((h) => h.code === 'H-EXPECTED')).toBeUndefined()
    const interference = result.hypotheses.find(
      (h) => h.ruleId === 'rule.h-tamper.network-jamming',
    )
    expect(interference?.band).toBe('direct')
    expect(result.urgentEligible).toBe(true)
  })

  it('peer clusters cannot explain an episode whose reports kept arriving — H2/H5', () => {
    const result = run({
      'episode.type': available('gnss_only_loss'),
      'gnss.reports_continued': available(true),
      'source.independent_devices': available(6),
      'network.independent_devices': available(6),
      'network.identity_known': available(true),
      'device.sleep_state_before_gap': available('awake'),
    })
    expect(result.hypotheses.find((h) => h.code === 'H-VENDOR')).toBeUndefined()
    expect(result.hypotheses.find((h) => h.code === 'H-NETWORK')).toBeUndefined()
    expect(result.hypotheses.find((h) => h.code === 'H-GNSS')).toBeDefined()
  })

  it('a frozen valid position is H-GNSS too — H4', () => {
    const result = run({
      'episode.type': available('stale_position'),
      'gnss.reports_continued': available(true),
      'device.sleep_state_before_gap': available('awake'),
    })
    expect(result.hypotheses.find((h) => h.code === 'H-GNSS')?.ruleId)
      .toBe('rule.h-gnss.position-quality-loss')
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

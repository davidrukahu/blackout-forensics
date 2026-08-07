// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The corpus-wide classification baseline — §15.5's regression gate in executable form.
 *
 * Every reference scenario is classified and the result compared against a committed snapshot. A
 * rule change that alters any scenario's classification fails this test until the snapshot is
 * deliberately regenerated (`vitest -u`) — and that regeneration is the diff an approver signs off
 * on, in the same commit, with the explanation §15.5 demands. An unexplained change cannot slip
 * through, because there is no path around the failing test that does not touch the snapshot.
 */

import { describe, expect, it } from 'vitest'
import { SCENARIO_NAMES, runScenario } from '@blackout/generator'

import { FACT_VOCABULARY_VERSION } from './facts.js'
import { classify } from './classify.js'
import { CONTRADICTIONS, RULE_PACKAGES } from './packages.js'
import { factsForScenario } from '../evaluation/corpus.js'
import { diffClassifications, summariseClassification, type ClassificationSnapshot } from './diff.js'

const CTX = { seed: 91, startAt: '2026-08-05T06:00:00.000Z' }
const AT = '2026-09-01T00:00:00.000Z'

function currentSnapshot(): ClassificationSnapshot {
  const snapshot: Record<string, ReturnType<typeof summariseClassification>> = {}
  for (const name of SCENARIO_NAMES) {
    const { events } = runScenario(name, CTX)
    const result = classify({
      facts: factsForScenario(events),
      packages: RULE_PACKAGES,
      contradictions: CONTRADICTIONS,
      at: AT,
      factVocabularyVersion: FACT_VOCABULARY_VERSION,
    })
    snapshot[name] = summariseClassification(result)
  }
  return snapshot
}

describe('the published classification baseline', () => {
  it('matches the committed snapshot — a change here is the diff the approver signs', async () => {
    await expect(JSON.stringify(currentSnapshot(), null, 2)).toMatchFileSnapshot(
      './fixtures/classification-baseline.json',
    )
  })

  it('is deterministic across runs', () => {
    expect(currentSnapshot()).toEqual(currentSnapshot())
  })

  it('classifies the traps the corpus was built to carry', () => {
    const snapshot = currentSnapshot()

    // The power-cut scenario produces the direct hypothesis and urgent eligibility.
    const powerCut = snapshot['vendor-outage-with-individual-power-cut']
    expect(powerCut?.fired).toContain('H-POWER')
    expect(powerCut?.urgentEligible).toBe(true)

    // Deep sleep produces no jamming hypothesis: the fact was unavailable, not false.
    const deepSleep = snapshot['teltonika-deep-sleep']
    expect(deepSleep?.fired ?? []).not.toContain('H-GNSS')

    // GNSS loss while reporting continues is recognised as a positioning statement.
    expect(snapshot['gnss-loss-cellular-continues']?.fired).toContain('H-GNSS')
  })
})

describe('diffClassifications', () => {
  const summary = (fired: string[]): ReturnType<typeof summariseClassification> => ({
    fired, bands: {}, suppressed: [], unknown: fired.length === 0, urgentEligible: false,
  })

  it('reports changed, added and removed scenarios — a vanished case can hide a regression too', () => {
    const before: ClassificationSnapshot = {
      a: summary(['H-POWER']), b: summary(['H-VENDOR']), gone: summary([]),
    }
    const after: ClassificationSnapshot = {
      a: summary(['H-POWER']), b: summary(['H-TAMPER']), fresh: summary([]),
    }
    const changes = diffClassifications(before, after)
    expect(changes.map((c) => `${c.scenario}:${c.kind}`).sort()).toEqual([
      'b:changed', 'fresh:added', 'gone:removed',
    ])
  })

  it('reports nothing when nothing changed', () => {
    const snapshot: ClassificationSnapshot = { a: summary(['H-POWER']) }
    expect(diffClassifications(snapshot, snapshot)).toEqual([])
  })
})

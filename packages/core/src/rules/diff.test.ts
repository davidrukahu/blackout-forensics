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
import { SCENARIO_NAMES, runScenario, type CanonicalEvent } from '@blackout/generator'

import { sampleEpisodes, type SamplerEvent } from '../episodes/sampler.js'
import type { ReportingPolicyRecord } from '../reporting-policy.js'
import { FACT_VOCABULARY_VERSION, deriveFacts, type FactSet } from './facts.js'
import { classify } from './classify.js'
import { CONTRADICTIONS, RULE_PACKAGES } from './packages.js'
import { diffClassifications, summariseClassification, type ClassificationSnapshot } from './diff.js'

const CTX = { seed: 91, startAt: '2026-08-05T06:00:00.000Z' }
const AT = '2026-09-01T00:00:00.000Z'

const POLICY: ReportingPolicyRecord = {
  cohort: 'corpus',
  intervals: { moving: 60, ignition_on: 120, parked: 300, sleep: 3600, exception: 30 },
  provenance: 'declared',
  sleepAfterStationaryS: 900,
  graceFactor: 1.5,
  version: '1.0.0',
}

/**
 * Derive facts for one scenario from its events alone — never from its ground-truth labels, which
 * would be the classifier grading its own homework.
 *
 * Peer, corridor and maintenance context are single-device unknowns here, so those facts arrive
 * unavailable — which is itself part of what the baseline pins: the classifications below are what
 * the rules say *with* that evidence missing.
 */
function factsForScenario(events: readonly CanonicalEvent[]): FactSet {
  const byDevice = new Map<string, CanonicalEvent[]>()
  for (const event of events) {
    byDevice.set(event.device_ref, [...(byDevice.get(event.device_ref) ?? []), event])
  }
  const primary = [...byDevice.values()].sort((a, b) => b.length - a.length)[0] ?? []
  const ordered = [...primary].sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at))

  const episodes = sampleEpisodes(ordered as unknown as SamplerEvent[], { policy: POLICY })
  const first = episodes[0]

  const anyAlert = (code: string): boolean =>
    ordered.some((e) => (e.alerts ?? []).some((a) => a.code === code))
  const sleepStates = ordered
    .map((e) => (e.device as { sleep_state?: string } | undefined)?.sleep_state)
    .filter((s): s is string => typeof s === 'string')
  const lastMotion = [...ordered].reverse()
    .map((e) => (e.motion as { motion_state?: string } | null | undefined)?.motion_state)
    .find((m) => typeof m === 'string')
  const lastPower = [...ordered].reverse()
    .map((e) => (e.power as { external_state?: string } | null | undefined)?.external_state)
    .find((p) => typeof p === 'string')
  const rebooted = ordered.some(
    (e) => (e.device as { reboot_reason?: string | null } | undefined)?.reboot_reason != null,
  )

  return deriveFacts({
    ...(first !== undefined
      ? {
          episode: {
            type: first.type,
            durationS: first.durationS,
            missedReports: first.missedReports,
            weakBasis: first.weakBasis,
            policyState: 'moving',
            sleepProvenance: POLICY.provenance,
          },
        }
      : {}),
    lastObservations: {
      moving: lastMotion === undefined ? null : lastMotion === 'moving',
      externalPowerState: (lastPower ?? null) as 'present' | 'absent' | 'unknown' | null,
      sleepState: sleepStates.includes('deep_sleep')
        ? 'deep_sleep'
        : ((sleepStates[sleepStates.length - 1] ?? null) as 'awake' | null),
    },
    alerts: {
      powerCut: anyAlert('power_cut'),
      tamper: anyAlert('tamper') || anyAlert('unplug'),
      gnssJamming: anyAlert('gnss_jamming'),
      networkJamming: anyAlert('network_jamming'),
    },
    recovery: { rebootReported: rebooted, sequenceReset: false },
  })
}

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

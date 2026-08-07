// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The labelled evaluation corpus: reference scenarios turned into fact sets, with their ground
 * truth alongside — never inside — the facts.
 *
 * The derivation reads only the events, exactly as production would. Truth labels ride separately
 * so the classifier can be *measured* against them; a derivation that peeked at labels would be the
 * classifier grading its own homework. Moved verbatim from the diff test when the harness landed,
 * so the committed classification baseline did not shift.
 */

import { SCENARIO_NAMES, runScenario, type CanonicalEvent, type GroundTruth } from '@blackout/generator'

import { sampleEpisodes, type SamplerEvent } from '../episodes/sampler.js'
import type { ReportingPolicyRecord } from '../reporting-policy.js'
import { deriveFacts, type FactSet } from '../rules/facts.js'

export const CORPUS_POLICY: ReportingPolicyRecord = {
  cohort: 'corpus',
  intervals: { moving: 60, ignition_on: 120, parked: 300, sleep: 3600, exception: 30 },
  provenance: 'declared',
  sleepAfterStationaryS: 900,
  graceFactor: 1.5,
  version: '1.0.0',
}

export function factsForScenario(events: readonly CanonicalEvent[]): FactSet {
  const byDevice = new Map<string, CanonicalEvent[]>()
  for (const event of events) {
    byDevice.set(event.device_ref, [...(byDevice.get(event.device_ref) ?? []), event])
  }
  const primary = [...byDevice.values()].sort((a, b) => b.length - a.length)[0] ?? []
  const ordered = [...primary].sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at))

  const episodes = sampleEpisodes(ordered as unknown as SamplerEvent[], { policy: CORPUS_POLICY })
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
            sleepProvenance: CORPUS_POLICY.provenance,
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
      // Finding M8: absence of a jamming alert in the stream is NOT "checked and found none" — the
      // device may carry no detector. Null means the capability is unestablished; only an actual
      // alert asserts the capability existed.
      gnssJamming: anyAlert('gnss_jamming') ? true : null,
      networkJamming: anyAlert('network_jamming') ? true : null,
    },
    recovery: { rebootReported: rebooted, sequenceReset: false },
  })
}

export interface LabelledCase {
  readonly scenario: string
  readonly seed: number
  readonly facts: FactSet
  readonly truth: GroundTruth
}

/**
 * Build the corpus across several seeds per scenario.
 *
 * Fourteen scenarios is a tiny sample and its intervals would say almost nothing. Seed variation
 * multiplies the cases while keeping every one deterministic — wider n, honestly obtained, though
 * still synthetic and the report must keep saying so.
 */
export function buildCorpus(params: { readonly seeds: readonly number[] }): LabelledCase[] {
  const cases: LabelledCase[] = []
  for (const seed of params.seeds) {
    for (const scenario of SCENARIO_NAMES) {
      const { events, truth } = runScenario(scenario, { seed, startAt: '2026-08-05T06:00:00.000Z' })
      cases.push({ scenario, seed, facts: factsForScenario(events), truth })
    }
  }
  return cases
}

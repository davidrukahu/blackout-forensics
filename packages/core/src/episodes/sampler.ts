// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Historical blackout sampler.
 *
 * FR-EPI-001: open an episode after the expected deadline plus measured grace.
 * FR-EPI-002: distinguish total silence, GNSS-only loss, stale position and vendor ingestion delay.
 *
 * Deliberately narrow. This produces *bounded intervals with a type*, and nothing else — no
 * lifecycle states, no revisions, no evidence, no hypotheses. Those belong to Release B's episode
 * engine. What the audit needs is an episode count and duration distribution honest enough to put
 * in front of a customer, and adding inference here would let a two-week audit make claims the
 * evidence engine has not earned.
 *
 * The four types are observations about the *shape* of the gap, not causes. `vendor_ingestion_delay`
 * says the platform held records, not that the platform is at fault; `gnss_only_loss` says position
 * quality failed while reporting continued, not that jamming occurred. Naming a cause is the
 * evidence engine's job, and calling either of these a cause here would be exactly the false
 * certainty PRD §8.1 forbids.
 */

import {
  expectedNextReport,
  findSuppression,
  type ExpectedReport,
  type MotionState,
  type ReportingPolicyRecord,
  type SuppressionWindow,
} from '../reporting-policy.js'

export interface SamplerEvent {
  readonly device_ref: string
  readonly received_at: string
  readonly device_time?: string | null
  readonly vendor_received_at?: string | null
  readonly position?: { lat?: number; lon?: number; valid?: boolean } | null
  readonly motion?: { motion_state?: string | null; ignition?: string | null } | null
  readonly device?: { sleep_state?: string | null } | null
}

export type EpisodeType =
  /** No report of any kind arrived when one was expected. */
  | 'total_silence'
  /** Reports continued on schedule, but position quality failed. */
  | 'gnss_only_loss'
  /** Reports continued and positions validated, but the coordinates stopped changing. */
  | 'stale_position'
  /** Records existed all along; the platform delivered them late. */
  | 'vendor_ingestion_delay'

export interface EpisodeSample {
  readonly deviceRef: string
  readonly type: EpisodeType
  /** Device-time bounds where available, receipt-time otherwise. Basis is always stated. */
  readonly startAt: string
  readonly endAt: string | null
  readonly durationS: number | null
  readonly clockBasis: 'device_time' | 'received_at'
  readonly expectedIntervalS: number
  readonly missedReports: number
  readonly policyVersion: string
  /** True where the deadline rested on an assumed or measured sleep interval. */
  readonly weakBasis: boolean
  /** Set when the gap fell inside an approved window — recorded, not dropped (FR-POL-004). */
  readonly suppressedBy?: SuppressionWindow['reason']
}

export interface SamplerOptions {
  readonly policy: ReportingPolicyRecord
  readonly deliveryLagP95S?: number
  readonly suppressionWindows?: readonly SuppressionWindow[]
  /**
   * Receipt-versus-device delay above which a record counts as buffered backfill, meaning the gap
   * was in delivery rather than in the device.
   */
  readonly backfillThresholdS?: number
  /** Consecutive unchanged positions before the fix is called stale. */
  readonly staleAfterReports?: number
}

const parse = (iso: string): number => Date.parse(iso)

const motionStateOf = (event: SamplerEvent): MotionState => {
  const sleep = event.device?.sleep_state
  if (sleep === 'deep_sleep' || sleep === 'light_sleep') return 'sleep'
  const motion = event.motion?.motion_state
  if (motion === 'moving') return 'moving'
  if (event.motion?.ignition === 'on') return 'ignition_on'
  return 'parked'
}

const timeOf = (event: SamplerEvent, basis: 'device_time' | 'received_at'): string =>
  basis === 'device_time' ? (event.device_time ?? event.received_at) : event.received_at

/**
 * Sample episodes for one device.
 *
 * Clock basis is chosen once per device and stated on every episode. FR-POL-003 makes receipt time
 * the SLA clock until device clocks pass quality criteria, so a device whose clock moves backwards
 * is measured on receipt time — otherwise a 47-minute clock jump becomes a 47-minute blackout that
 * never happened.
 */
export function sampleEpisodes(
  events: readonly SamplerEvent[],
  options: SamplerOptions,
): EpisodeSample[] {
  if (events.length < 2) return []

  const {
    policy,
    deliveryLagP95S = 0,
    suppressionWindows = [],
    backfillThresholdS = 900,
    staleAfterReports = 3,
  } = options

  const deviceRef = events[0]!.device_ref
  const deviceTimes = events.map((e) => (e.device_time == null ? null : parse(e.device_time)))
  const clockUsable =
    deviceTimes.every((t) => t !== null) &&
    deviceTimes.every((t, i) => i === 0 || (t as number) >= (deviceTimes[i - 1] as number))
  const clockBasis: 'device_time' | 'received_at' = clockUsable ? 'device_time' : 'received_at'

  const ordered = [...events].sort((a, b) => parse(timeOf(a, clockBasis)) - parse(timeOf(b, clockBasis)))
  const samples: EpisodeSample[] = []

  let unchangedRun = 0

  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!
    const current = ordered[i]!
    const previousAt = timeOf(previous, clockBasis)
    const currentAt = timeOf(current, clockBasis)

    const state = motionStateOf(previous)
    const expected: ExpectedReport = expectedNextReport({
      lastReportAt: previousAt,
      state,
      policy,
      deliveryLagP95S,
    })

    const gapS = (parse(currentAt) - parse(previousAt)) / 1000
    const lateBy = parse(currentAt) - parse(expected.deadlineAt)

    // Position that validates but never moves is a distinct failure: the device is talking and the
    // fix passes quality checks, yet it is reporting a position it is no longer at.
    const samePosition =
      previous.position?.lat != null &&
      previous.position.lat === current.position?.lat &&
      previous.position.lon === current.position?.lon
    unchangedRun = samePosition ? unchangedRun + 1 : 0

    if (lateBy <= 0) {
      if (unchangedRun >= staleAfterReports && current.position?.valid === true) {
        samples.push({
          deviceRef,
          type: 'stale_position',
          startAt: previousAt,
          endAt: currentAt,
          durationS: gapS,
          clockBasis,
          expectedIntervalS: expected.intervalS,
          missedReports: 0,
          policyVersion: expected.policyVersion,
          weakBasis: expected.weakBasis,
        })
        unchangedRun = 0
      }
      // GNSS-only loss: reporting continued on schedule, position quality did not.
      if (current.position != null && current.position.valid === false) {
        samples.push({
          deviceRef,
          type: 'gnss_only_loss',
          startAt: previousAt,
          endAt: currentAt,
          durationS: gapS,
          clockBasis,
          expectedIntervalS: expected.intervalS,
          missedReports: 0,
          policyVersion: expected.policyVersion,
          weakBasis: expected.weakBasis,
        })
      }
      continue
    }

    // The gap is real. Was the device silent, or did the platform hold the records?
    const heldByPlatform =
      current.device_time != null &&
      (parse(current.received_at) - parse(current.device_time)) / 1000 > backfillThresholdS

    const suppression = findSuppression(suppressionWindows, previousAt)

    samples.push({
      deviceRef,
      type: heldByPlatform ? 'vendor_ingestion_delay' : 'total_silence',
      startAt: previousAt,
      endAt: currentAt,
      durationS: gapS,
      clockBasis,
      expectedIntervalS: expected.intervalS,
      missedReports: Math.max(1, Math.floor(gapS / expected.intervalS) - 1),
      policyVersion: expected.policyVersion,
      weakBasis: expected.weakBasis,
      ...(suppression !== undefined ? { suppressedBy: suppression.reason } : {}),
    })
  }

  return samples
}

export interface EpisodeSummary {
  readonly total: number
  readonly byType: Readonly<Record<EpisodeType, number>>
  readonly suppressed: number
  readonly weakBasis: number
  readonly durationsS: readonly number[]
  /** Devices contributing at least one episode, over devices observed — the exposure denominator. */
  readonly devicesWithEpisodes: number
  readonly devicesObserved: number
}

/**
 * Summarise a sample set for the audit report.
 *
 * Suppressed and weak-basis episodes are counted separately rather than removed: an episode
 * suppressed by a maintenance window still happened, and hiding it would understate how much of the
 * fleet's silence is planned (FR-POL-004).
 */
export function summariseEpisodes(
  samples: readonly EpisodeSample[],
  devicesObserved: number,
): EpisodeSummary {
  const byType: Record<EpisodeType, number> = {
    total_silence: 0,
    gnss_only_loss: 0,
    stale_position: 0,
    vendor_ingestion_delay: 0,
  }
  for (const s of samples) byType[s.type] += 1

  return {
    total: samples.length,
    byType,
    suppressed: samples.filter((s) => s.suppressedBy !== undefined).length,
    weakBasis: samples.filter((s) => s.weakBasis).length,
    durationsS: samples.map((s) => s.durationS).filter((d): d is number => d !== null),
    devicesWithEpisodes: new Set(samples.map((s) => s.deviceRef)).size,
    devicesObserved,
  }
}

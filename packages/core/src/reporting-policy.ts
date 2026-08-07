// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reporting policies and expected-next-report calculation.
 *
 * FR-POL-001 requires effective intervals for moving, ignition-on, parked, sleep and exception
 * states. FR-TEN-003 requires replay to use the policy effective at event time.
 *
 * The single most consequential thing here is where the sleep interval comes from. Platform research
 * found sleep configuration to be the dominant false-positive source and largely invisible in the
 * telemetry: Teltonika Deep Sleep emits stale coordinates and strips IO elements, Queclink Power
 * Saving suppresses reporting by design. A policy that *guesses* the sleep interval will manufacture
 * blackouts at scale, so provenance is a required field and it propagates into evidence.
 */

import { resolveAt, type EffectiveDated } from './temporal.js'

export type MotionState = 'moving' | 'ignition_on' | 'parked' | 'sleep' | 'exception'

/**
 * Where an interval came from. This is not metadata — it changes how much the resulting episode can
 * be trusted, and a `declared` policy is worth materially more than a `measured` one.
 */
export type PolicyProvenance =
  /** Read from device configuration or vendor documentation, and archived. */
  | 'declared'
  /** Inferred from observed behaviour. Usable, but the resulting confidence is capped. */
  | 'measured'
  /** Neither available. Episodes derived from this cannot support an urgent classification. */
  | 'assumed'

export interface PolicyIntervals {
  readonly moving: number
  readonly ignition_on: number
  readonly parked: number
  readonly sleep: number
  readonly exception: number
}

export interface ReportingPolicyRecord {
  /** Cohort this applies to: a device model, a firmware band, or a single device. */
  readonly cohort: string
  readonly intervals: PolicyIntervals
  readonly provenance: PolicyProvenance
  /**
   * Stationary seconds before the device enters its sleep state. Null where the device does not
   * sleep, or where nobody knows — which are different, so null carries provenance too.
   */
  readonly sleepAfterStationaryS: number | null
  /** Multiplier applied to the interval before a report is considered late. */
  readonly graceFactor: number
  readonly version: string
}

export type EffectivePolicy = EffectiveDated<ReportingPolicyRecord>

export class PolicyRegistry {
  private readonly records: EffectivePolicy[] = []

  add(record: EffectivePolicy): this {
    this.records.push(record)
    return this
  }

  /** The policy in force for a cohort at an instant. */
  resolve(cohort: string, at: string): EffectivePolicy | undefined {
    return resolveAt(this.records.filter((r) => r.cohort === cohort), at)
  }
}

export interface ExpectedReport {
  /** When the next report is due, before grace. */
  readonly dueAt: string
  /** When absence becomes an episode, after grace and measured lag. */
  readonly deadlineAt: string
  readonly intervalS: number
  readonly state: MotionState
  readonly policyVersion: string
  readonly provenance: PolicyProvenance
  /**
   * True where the deadline rests on an assumed or measured sleep interval. Episodes carrying this
   * cannot meet the urgent-action threshold on their own (FR-CLS-007).
   */
  readonly weakBasis: boolean
}

/**
 * When should the next report arrive, and when does its absence become an episode?
 *
 * `deliveryLagP95S` is the measured p95 for the source (FR-POL-002). It is added rather than
 * multiplied because delivery lag is a property of the platform, not of the reporting interval —
 * a slow platform delays a 60-second and a 3600-second policy by the same amount.
 */
export function expectedNextReport(params: {
  lastReportAt: string
  state: MotionState
  policy: ReportingPolicyRecord
  deliveryLagP95S?: number
}): ExpectedReport {
  const { lastReportAt, state, policy, deliveryLagP95S = 0 } = params
  const intervalS = policy.intervals[state]
  const base = Date.parse(lastReportAt)
  if (Number.isNaN(base)) throw new Error(`invalid timestamp: ${lastReportAt}`)

  const dueMs = base + intervalS * 1000
  const deadlineMs = base + intervalS * policy.graceFactor * 1000 + deliveryLagP95S * 1000

  return {
    dueAt: new Date(dueMs).toISOString(),
    deadlineAt: new Date(deadlineMs).toISOString(),
    intervalS,
    state,
    policyVersion: policy.version,
    provenance: policy.provenance,
    weakBasis: state === 'sleep' && policy.provenance !== 'declared',
  }
}

/**
 * Resolve the policy at event time and compute the deadline in one step.
 *
 * This is the function replay must use. Applying today's policy to last month's events is exactly
 * the failure FR-TEN-003 forbids: a policy change from 60s to 300s invents four missing reports for
 * every real one when applied backwards.
 */
export function expectedNextReportAt(params: {
  registry: PolicyRegistry
  cohort: string
  lastReportAt: string
  state: MotionState
  deliveryLagP95S?: number
}): ExpectedReport | undefined {
  const policy = params.registry.resolve(params.cohort, params.lastReportAt)
  if (policy === undefined) return undefined
  return expectedNextReport({
    lastReportAt: params.lastReportAt,
    state: params.state,
    policy,
    ...(params.deliveryLagP95S !== undefined ? { deliveryLagP95S: params.deliveryLagP95S } : {}),
  })
}

export interface SuppressionWindow {
  readonly reason: 'maintenance' | 'installation' | 'known_outage'
  readonly from: string
  readonly to: string
  readonly approvedBy: string
}

/**
 * Whether an instant falls inside an approved suppression window.
 *
 * FR-POL-004 requires suppressed episodes to remain auditable and to appear in excluded
 * denominators. Suppression therefore means "do not raise a case", never "do not record" —
 * silently dropping a window corrupts the SLA numerator and hides the cost of maintenance.
 */
export function findSuppression(
  windows: readonly SuppressionWindow[],
  at: string,
): SuppressionWindow | undefined {
  const t = Date.parse(at)
  return windows.find((w) => t >= Date.parse(w.from) && t < Date.parse(w.to))
}

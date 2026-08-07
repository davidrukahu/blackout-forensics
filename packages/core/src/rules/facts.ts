// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The fact vocabulary — the fixed, typed set of facts a rule may reference.
 *
 * Ticket 37 decided that a rule is declarative data over this vocabulary, not code, because §3.3's
 * risk approver cannot meaningfully review a code diff. The vocabulary is therefore versioned and
 * **closed**: a rule referencing a fact not listed here fails validation, and extending the list is
 * its own reviewed change. That is the safeguard against the failure mode the decision accepted —
 * pressure to bolt on an escape hatch that quietly becomes code again.
 *
 * Every fact is either available with a value or unavailable with a stated reason. Availability is
 * computed per event from the adapter manifest plus runtime state, which is how the three-valued
 * evaluator gets its third value: a rule whose required facts are unavailable is *inapplicable*,
 * not false (FR-CLS-006).
 *
 * Deliberately absent: any fact derived from OpenCellID. FR-CLS-005 requires that removing the cell
 * layer cannot change a classification, and the cheapest proof is that no rule can see it — cell
 * priors remain display context, outside the vocabulary entirely.
 */

export const FACT_VOCABULARY_VERSION = '1.0.0'

export type FactValue = string | number | boolean

export type Fact =
  | { readonly status: 'available'; readonly value: FactValue }
  | { readonly status: 'unavailable'; readonly reason: string }

export type FactSet = Readonly<Record<string, Fact>>

export interface FactDefinition {
  readonly name: string
  readonly type: 'string' | 'number' | 'boolean'
  readonly description: string
}

/** The closed vocabulary. Order is presentation order in evidence displays. */
export const FACT_VOCABULARY: readonly FactDefinition[] = [
  { name: 'episode.type', type: 'string', description: 'Shape of the gap: total_silence, gnss_only_loss, stale_position or vendor_ingestion_delay' },
  { name: 'episode.duration_s', type: 'number', description: 'Gap duration on the stated clock basis' },
  { name: 'episode.missed_reports', type: 'number', description: 'Expected reports that did not arrive' },

  { name: 'policy.state_at_gap', type: 'string', description: 'Motion state the effective policy assigned when the gap opened' },
  { name: 'policy.sleep_provenance', type: 'string', description: 'declared, measured or assumed — where the sleep interval came from' },
  { name: 'policy.weak_basis', type: 'boolean', description: 'True when the deadline rested on a measured or assumed sleep interval' },

  { name: 'movement.moving_before_gap', type: 'boolean', description: 'Whether the asset was moving in the last valid observations' },

  { name: 'power.cut_alert_present', type: 'boolean', description: 'Device reported loss of external power' },
  { name: 'power.external_state_before_gap', type: 'string', description: 'present, absent or unknown in the last observation' },

  { name: 'device.sleep_state_before_gap', type: 'string', description: 'awake, light_sleep, deep_sleep or unknown' },
  { name: 'device.reboot_after_gap', type: 'boolean', description: 'Device reported a reboot when reporting resumed' },
  { name: 'device.sequence_reset', type: 'boolean', description: 'Vendor sequence restarted from zero across the gap' },
  { name: 'device.model_fault_pattern', type: 'boolean', description: 'This model shows a repeated reviewed fault pattern' },

  { name: 'gnss.reports_continued', type: 'boolean', description: 'Reports kept arriving while position quality failed' },
  { name: 'gnss.jamming_alert', type: 'boolean', description: 'Device reported a GNSS jamming indication' },

  { name: 'network.jamming_alert', type: 'boolean', description: 'Device reported a network jamming indication' },
  { name: 'network.independent_devices', type: 'number', description: 'Independent devices on the same network identity with correlated episodes' },
  { name: 'network.identity_known', type: 'boolean', description: 'Serving network identity was observed before the gap' },

  { name: 'source.independent_devices', type: 'number', description: 'Independent devices on the same source with correlated receipt failure' },
  { name: 'source.health_incident_active', type: 'boolean', description: 'A source-wide health incident overlaps this episode' },

  { name: 'corridor.recurrence_qualified', type: 'boolean', description: 'Corridor met the count floor AND a rate significantly above the fleet base rate' },

  { name: 'tamper.alert_present', type: 'boolean', description: 'Device reported a tamper or unplug indication' },

  { name: 'maintenance.window_active', type: 'boolean', description: 'An approved maintenance, installation or known-outage window covers the gap' },
] as const

const FACT_NAMES = new Set(FACT_VOCABULARY.map((f) => f.name))

export function isVocabularyFact(name: string): boolean {
  return FACT_NAMES.has(name)
}

export function available(value: FactValue): Fact {
  return { status: 'available', value }
}

export function unavailable(reason: string): Fact {
  return { status: 'unavailable', reason }
}

/**
 * Structured input for fact derivation.
 *
 * Callers assemble what they know; absent sections become unavailable facts with a stated reason
 * rather than defaults. A default here would be a measurement the source never made.
 */
export interface FactDerivationInput {
  readonly episode?: {
    readonly type: string
    readonly durationS: number | null
    readonly missedReports: number
    readonly weakBasis: boolean
    readonly policyState: string
    readonly sleepProvenance: string
  }
  readonly lastObservations?: {
    readonly moving: boolean | null
    readonly externalPowerState: 'present' | 'absent' | 'unknown' | null
    readonly sleepState: 'awake' | 'light_sleep' | 'deep_sleep' | 'unknown' | null
  }
  readonly alerts?: {
    readonly powerCut: boolean
    readonly tamper: boolean
    readonly gnssJamming: boolean | null
    readonly networkJamming: boolean | null
  }
  readonly recovery?: {
    readonly rebootReported: boolean
    readonly sequenceReset: boolean
  }
  readonly modelFaultPattern?: boolean
  readonly peers?: {
    readonly sourceIndependentDevices: number
    readonly networkIndependentDevices: number | null
    readonly networkIdentityKnown: boolean
    readonly sourceHealthIncident: boolean
  }
  readonly corridorRecurrenceQualified?: boolean
  readonly maintenanceWindowActive?: boolean
  /** From the adapter capability manifest: dotted canonical paths the device can produce. */
  readonly capabilities?: readonly string[]
}

const NOT_SUPPLIED = 'not supplied to fact derivation'

/**
 * Derive the fact set for one episode.
 *
 * Two rules matter more than the plumbing:
 *
 *   * A capability the manifest marks unsupported makes the fact **unavailable**, not false. The
 *     evidence engine cannot require a field the manifest marks unsupported (FR-AST-004).
 *   * Deep Sleep disables both jamming detectors regardless of what the manifest says the device
 *     supports, so the jamming facts go unavailable whenever the device was in deep sleep. This is
 *     the Teltonika trap made structural: a missing jamming flag on a sleeping device is no
 *     evidence, and no rule downstream can accidentally read it as false.
 */
export function deriveFacts(input: FactDerivationInput): FactSet {
  const facts: Record<string, Fact> = {}

  const capability = (path: string): boolean =>
    input.capabilities === undefined || input.capabilities.includes(path)

  if (input.episode !== undefined) {
    facts['episode.type'] = available(input.episode.type)
    facts['episode.duration_s'] =
      input.episode.durationS === null
        ? unavailable('episode is still open')
        : available(input.episode.durationS)
    facts['episode.missed_reports'] = available(input.episode.missedReports)
    facts['policy.state_at_gap'] = available(input.episode.policyState)
    facts['policy.sleep_provenance'] = available(input.episode.sleepProvenance)
    facts['policy.weak_basis'] = available(input.episode.weakBasis)
  } else {
    for (const name of [
      'episode.type', 'episode.duration_s', 'episode.missed_reports',
      'policy.state_at_gap', 'policy.sleep_provenance', 'policy.weak_basis',
    ]) facts[name] = unavailable(NOT_SUPPLIED)
  }

  const observations = input.lastObservations
  facts['movement.moving_before_gap'] =
    observations?.moving == null ? unavailable(NOT_SUPPLIED) : available(observations.moving)
  facts['power.external_state_before_gap'] =
    observations?.externalPowerState == null
      ? unavailable(NOT_SUPPLIED)
      : available(observations.externalPowerState)
  facts['device.sleep_state_before_gap'] =
    observations?.sleepState == null ? unavailable(NOT_SUPPLIED) : available(observations.sleepState)

  const deepSleep = observations?.sleepState === 'deep_sleep'

  if (input.alerts !== undefined) {
    facts['power.cut_alert_present'] = capability('alerts.power_cut')
      ? available(input.alerts.powerCut)
      : unavailable('capability manifest marks power-cut alerts unsupported')
    facts['tamper.alert_present'] = capability('alerts.tamper')
      ? available(input.alerts.tamper)
      : unavailable('capability manifest marks tamper alerts unsupported')

    // The Teltonika trap: Deep Sleep disables both jamming detectors, so absence is not a reading.
    facts['gnss.jamming_alert'] = deepSleep
      ? unavailable('jamming detectors are disabled in deep sleep')
      : input.alerts.gnssJamming === null || !capability('alerts.gnss_jamming')
        ? unavailable('device does not report GNSS jamming')
        : available(input.alerts.gnssJamming)
    facts['network.jamming_alert'] = deepSleep
      ? unavailable('jamming detectors are disabled in deep sleep')
      : input.alerts.networkJamming === null || !capability('alerts.network_jamming')
        ? unavailable('device does not report network jamming')
        : available(input.alerts.networkJamming)
  } else {
    for (const name of [
      'power.cut_alert_present', 'tamper.alert_present', 'gnss.jamming_alert', 'network.jamming_alert',
    ]) facts[name] = unavailable(NOT_SUPPLIED)
  }

  facts['gnss.reports_continued'] =
    input.episode === undefined
      ? unavailable(NOT_SUPPLIED)
      : available(input.episode.type === 'gnss_only_loss' || input.episode.type === 'stale_position')

  if (input.recovery !== undefined) {
    facts['device.reboot_after_gap'] = available(input.recovery.rebootReported)
    facts['device.sequence_reset'] = available(input.recovery.sequenceReset)
  } else {
    facts['device.reboot_after_gap'] = unavailable('reporting has not resumed')
    facts['device.sequence_reset'] = unavailable('reporting has not resumed')
  }

  facts['device.model_fault_pattern'] =
    input.modelFaultPattern === undefined
      ? unavailable('no reviewed fault-pattern analysis for this model')
      : available(input.modelFaultPattern)

  if (input.peers !== undefined) {
    facts['source.independent_devices'] = available(input.peers.sourceIndependentDevices)
    facts['source.health_incident_active'] = available(input.peers.sourceHealthIncident)
    facts['network.identity_known'] = available(input.peers.networkIdentityKnown)
    facts['network.independent_devices'] =
      input.peers.networkIndependentDevices === null
        ? unavailable('serving network identity was not observed before the gap')
        : available(input.peers.networkIndependentDevices)
  } else {
    for (const name of [
      'source.independent_devices', 'source.health_incident_active',
      'network.identity_known', 'network.independent_devices',
    ]) facts[name] = unavailable('peer correlation has not run for this episode')
  }

  facts['corridor.recurrence_qualified'] =
    input.corridorRecurrenceQualified === undefined
      ? unavailable('corridor baseline has not been evaluated')
      : available(input.corridorRecurrenceQualified)

  facts['maintenance.window_active'] =
    input.maintenanceWindowActive === undefined
      ? unavailable(NOT_SUPPLIED)
      : available(input.maintenanceWindowActive)

  return facts
}

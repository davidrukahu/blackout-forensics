// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Actions and canonical outcomes — PRD §22, FR-OUT-001..005.
 *
 * The taxonomy is closed and each code names its confirmation source: an outcome is a claim
 * about the world, and the code says what kind of record backs it. Three separations are
 * structural rather than procedural:
 *
 *   * **The product records; it never acts** (§17.4). There is no action kind for immobilizing,
 *     messaging, dispatching, repossessing or changing credit state — recording that an external
 *     party did something is the entire vocabulary, and `PROHIBITED_PRODUCT_CAPABILITIES` exists
 *     so a test can prove the vocabulary never grows one.
 *   * **Workflow outcome ≠ legal recovery authorization** (FR-OUT-002). OUT-RECOVERY cannot be
 *     recorded without an external authorization reference — the product holds a pointer to the
 *     authority, never the authority itself.
 *   * **Unresolved and unknown are first-class** (FR-OUT-004). Closing a review without a cause
 *     is an honest outcome, listed separately in aging — forcing a label would manufacture
 *     false certainty at exactly the moment the evidence ran out.
 */

export type OutcomeCategory = 'technical' | 'vendor' | 'field' | 'recovery' | 'open'

export interface OutcomeDefinition {
  readonly code: string
  readonly meaning: string
  readonly confirmationSource: string
  readonly category: OutcomeCategory
  /** FR-OUT-002: recording this code demands an external authorization reference. */
  readonly requiresExternalAuthorization: boolean
}

/** PRD §22, verbatim. */
export const OUTCOME_TAXONOMY: readonly OutcomeDefinition[] = [
  { code: 'OUT-RESUMED', meaning: 'Telemetry resumed without intervention', confirmationSource: 'Platform receipt and backfill', category: 'technical', requiresExternalAuthorization: false },
  { code: 'OUT-EXPECTED', meaning: 'Expected sleep or parked behaviour', confirmationSource: 'Policy plus later observations', category: 'technical', requiresExternalAuthorization: false },
  { code: 'OUT-FALSE', meaning: 'Alert or episode did not represent a qualifying gap', confirmationSource: 'Reviewed data correction', category: 'technical', requiresExternalAuthorization: false },
  { code: 'OUT-VENDOR', meaning: 'Vendor platform service restored', confirmationSource: 'Vendor ticket and receipt pattern', category: 'vendor', requiresExternalAuthorization: false },
  { code: 'OUT-BACKFILL', meaning: 'Buffered records arrived after restoration', confirmationSource: 'Device time versus receipt time', category: 'technical', requiresExternalAuthorization: false },
  { code: 'OUT-SIM-REACTIVATED', meaning: 'SIM service was restored', confirmationSource: 'Authorized vendor or customer record', category: 'vendor', requiresExternalAuthorization: false },
  { code: 'OUT-SIM-REPLACED', meaning: 'SIM was replaced', confirmationSource: 'Installation or service record', category: 'field', requiresExternalAuthorization: false },
  { code: 'OUT-RESET', meaning: 'Tracker reset', confirmationSource: 'Technician or device event', category: 'field', requiresExternalAuthorization: false },
  { code: 'OUT-RECONFIGURED', meaning: 'Reporting configuration changed', confirmationSource: 'Approved configuration record', category: 'field', requiresExternalAuthorization: false },
  { code: 'OUT-POWER-REPAIRED', meaning: 'Wiring or external power path repaired', confirmationSource: 'Technician record', category: 'field', requiresExternalAuthorization: false },
  { code: 'OUT-RESEATED', meaning: 'Tracker connection or installation reseated', confirmationSource: 'Technician record', category: 'field', requiresExternalAuthorization: false },
  { code: 'OUT-DEVICE-REPLACED', meaning: 'Tracker replaced', confirmationSource: 'Assignment and technician record', category: 'field', requiresExternalAuthorization: false },
  { code: 'OUT-FIELD-CHECK', meaning: 'Field verification completed', confirmationSource: 'Authorized external reference', category: 'field', requiresExternalAuthorization: false },
  { code: 'OUT-ASSET-LOCATED', meaning: 'Asset located', confirmationSource: 'Authorized field outcome', category: 'field', requiresExternalAuthorization: false },
  { code: 'OUT-RECOVERY', meaning: 'Separately authorized recovery completed', confirmationSource: 'External authorization and outcome', category: 'recovery', requiresExternalAuthorization: true },
  { code: 'OUT-UNRESOLVED', meaning: 'Evidence review complete but cause unresolved', confirmationSource: 'Analyst and supervisor review', category: 'open', requiresExternalAuthorization: false },
  { code: 'OUT-UNKNOWN', meaning: 'Outcome evidence is not available', confirmationSource: 'Controlled closure reason', category: 'open', requiresExternalAuthorization: false },
] as const

/**
 * §17.4: what the product must demonstrably be unable to do. The action vocabulary below records
 * work done by external parties; a test asserts none of these words ever appears in it.
 */
export const PROHIBITED_PRODUCT_CAPABILITIES = [
  'immobilize', 'immobilise', 'message', 'dispatch', 'repossess', 'credit',
] as const

/** What the product can track being done — by someone else, with a reference. */
export const ACTION_KINDS = [
  'field_verification',
  'vendor_ticket',
  'technician_visit',
  'record_external_recovery',
] as const
export type ActionKind = (typeof ACTION_KINDS)[number]

export interface VendorTicket {
  readonly vendor: string
  readonly reference: string
  readonly openedAt: string
  /** Hash of the evidence pack shared with the vendor — linkage, not disclosure. */
  readonly evidencePackSha256: string
}

export interface RecordedActionOutcome {
  readonly id: string
  readonly episodeId: string
  readonly actionKind: ActionKind
  readonly owner: string
  readonly startedAt: string
  readonly completedAt: string | null
  readonly outcomeCode: string | null
  /** Authorized free-text note. Explains; never substitutes for the code. */
  readonly note: string | null
  readonly evidenceRefs: readonly string[]
  readonly costAmount: number | null
  readonly costCurrency: string | null
  readonly externalAuthorizationRef: string | null
  readonly vendorTicket: VendorTicket | null
}

export class UnknownOutcomeError extends Error {
  constructor(readonly code: string) {
    super(`The code "${code}" is not in the outcome taxonomy.`)
    this.name = 'UnknownOutcomeError'
  }
}

export class MissingAuthorizationError extends Error {
  constructor(readonly code: string) {
    super(
      `You cannot record ${code} without an external authorization reference. ` +
        'The product records the authorization. The product does not hold the authority.',
    )
    this.name = 'MissingAuthorizationError'
  }
}

export class IncoherentTimesError extends Error {
  constructor() {
    super('The completion time cannot be before the start time.')
    this.name = 'IncoherentTimesError'
  }
}

export function outcomeByCode(code: string): OutcomeDefinition {
  const outcome = OUTCOME_TAXONOMY.find((o) => o.code === code)
  if (outcome === undefined) throw new UnknownOutcomeError(code)
  return outcome
}

export function recordAction(params: {
  readonly id: string
  readonly episodeId: string
  readonly actionKind: ActionKind
  readonly owner: string
  readonly startedAt: string
  readonly vendorTicket?: VendorTicket
}): RecordedActionOutcome {
  return {
    id: params.id,
    episodeId: params.episodeId,
    actionKind: params.actionKind,
    owner: params.owner,
    startedAt: params.startedAt,
    completedAt: null,
    outcomeCode: null,
    note: null,
    evidenceRefs: [],
    costAmount: null,
    costCurrency: null,
    externalAuthorizationRef: null,
    vendorTicket: params.vendorTicket ?? null,
  }
}

/**
 * Complete an action with an outcome — or without one. FR-OUT-004: passing OUT-UNRESOLVED or
 * OUT-UNKNOWN is supported and never upgraded; omitting the code entirely leaves the action
 * complete-but-unlabelled, which aging reports must show rather than hide.
 */
export function completeAction(
  action: RecordedActionOutcome,
  params: {
    readonly completedAt: string
    readonly outcomeCode?: string
    readonly note?: string
    readonly evidenceRefs?: readonly string[]
    readonly costAmount?: number
    readonly costCurrency?: string
    readonly externalAuthorizationRef?: string
  },
): RecordedActionOutcome {
  if (Date.parse(params.completedAt) < Date.parse(action.startedAt)) {
    throw new IncoherentTimesError()
  }
  if (params.outcomeCode !== undefined) {
    const outcome = outcomeByCode(params.outcomeCode)
    if (outcome.requiresExternalAuthorization && params.externalAuthorizationRef === undefined) {
      throw new MissingAuthorizationError(outcome.code)
    }
  }
  return {
    ...action,
    completedAt: params.completedAt,
    outcomeCode: params.outcomeCode ?? null,
    note: params.note ?? null,
    evidenceRefs: params.evidenceRefs ?? [],
    costAmount: params.costAmount ?? null,
    costCurrency: params.costCurrency ?? null,
    externalAuthorizationRef: params.externalAuthorizationRef ?? null,
  }
}

/** FR-OUT-003's acceptance: the metrics reproduce from the record, not from a dashboard cache. */
export function actionMetrics(
  action: RecordedActionOutcome,
  episodeOpenedAt: string,
): {
  readonly timeToActionS: number
  readonly timeToCompleteS: number | null
  readonly cost: { readonly amount: number; readonly currency: string } | null
} {
  return {
    timeToActionS: Math.round((Date.parse(action.startedAt) - Date.parse(episodeOpenedAt)) / 1000),
    timeToCompleteS:
      action.completedAt === null
        ? null
        : Math.round((Date.parse(action.completedAt) - Date.parse(action.startedAt)) / 1000),
    cost:
      action.costAmount === null || action.costCurrency === null
        ? null
        : { amount: action.costAmount, currency: action.costCurrency },
  }
}

/** FR-OUT-004's acceptance: unresolved cases age separately; nothing is folded into "done". */
export function agingReport(
  actions: readonly RecordedActionOutcome[],
  now: string,
): {
  readonly open: readonly { id: string; ageS: number }[]
  readonly unresolved: readonly { id: string; ageS: number }[]
  readonly unlabelled: readonly { id: string; ageS: number }[]
  readonly resolved: number
} {
  const ageOf = (from: string): number => Math.max(0, Math.round((Date.parse(now) - Date.parse(from)) / 1000))
  const open = actions.filter((a) => a.completedAt === null)
  const unresolved = actions.filter(
    (a) => a.outcomeCode === 'OUT-UNRESOLVED' || a.outcomeCode === 'OUT-UNKNOWN',
  )
  const unlabelled = actions.filter((a) => a.completedAt !== null && a.outcomeCode === null)
  return {
    open: open.map((a) => ({ id: a.id, ageS: ageOf(a.startedAt) })),
    unresolved: unresolved.map((a) => ({ id: a.id, ageS: ageOf(a.startedAt) })),
    unlabelled: unlabelled.map((a) => ({ id: a.id, ageS: ageOf(a.startedAt) })),
    resolved: actions.filter(
      (a) => a.completedAt !== null && a.outcomeCode !== null &&
        a.outcomeCode !== 'OUT-UNRESOLVED' && a.outcomeCode !== 'OUT-UNKNOWN',
    ).length,
  }
}

// ------------------------------------------------------------------ FR-OUT-005: adjudication

export interface ReviewerLabel {
  readonly reviewer: string
  readonly outcomeCode: string
  readonly at: string
  readonly rationale: string
}

export interface Adjudication {
  readonly episodeId: string
  /** Every reviewer's label, retained verbatim. Disagreement is data, not noise. */
  readonly labels: readonly ReviewerLabel[]
  readonly final: { readonly outcomeCode: string; readonly adjudicatedBy: string; readonly at: string } | null
}

export function addLabel(adjudication: Adjudication, label: ReviewerLabel): Adjudication {
  outcomeByCode(label.outcomeCode)
  return { ...adjudication, labels: [...adjudication.labels, label] }
}

export function adjudicate(
  adjudication: Adjudication,
  final: { readonly outcomeCode: string; readonly adjudicatedBy: string; readonly at: string },
): Adjudication {
  outcomeByCode(final.outcomeCode)
  // Adjudication settles the label without erasing the disagreement: the labels stay.
  return { ...adjudication, final }
}

export function isDisputed(adjudication: Adjudication): boolean {
  return new Set(adjudication.labels.map((l) => l.outcomeCode)).size > 1
}

/**
 * FR-OUT-005's acceptance: an evaluation dataset can exclude disputed labels, or measure them
 * separately — both from the same retained record.
 */
export function datasetView(
  adjudications: readonly Adjudication[],
  options: { readonly disputed: 'exclude' | 'only' | 'include' },
): readonly Adjudication[] {
  switch (options.disputed) {
    case 'exclude':
      return adjudications.filter((a) => !isDisputed(a))
    case 'only':
      return adjudications.filter((a) => isDisputed(a))
    case 'include':
      return adjudications
  }
}

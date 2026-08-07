// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

export { contains, detectDefects, isWellFormed, overlaps, resolveAt } from './temporal.js'
export type { EffectiveDated, Interval, TemporalDefect } from './temporal.js'
export { AssignmentRegistry } from './assignments.js'
export type {
  AssetDeviceAssignment, DeviceSimAssignment, EffectiveAssetDevice, EffectiveDeviceSim,
  ResolvedAssignment, TrackerRole,
} from './assignments.js'
export {
  PolicyRegistry, expectedNextReport, expectedNextReportAt, findSuppression,
} from './reporting-policy.js'
export type {
  EffectivePolicy, ExpectedReport, MotionState, PolicyIntervals, PolicyProvenance,
  ReportingPolicyRecord, SuppressionWindow,
} from './reporting-policy.js'
export {
  addExclusion, emptyDenominated, percentiles, ratio,
} from './analysers/distribution.js'
export type { Denominated, Percentiles } from './analysers/distribution.js'
export {
  FIELD_GROUPS, analyseCompleteness, analyseIntegrity, analysePlatformConfiguration, analyseTiming,
  cohortKey, cohortOf,
} from './analysers/quality.js'
export type {
  Cohort, CompletenessReport, DestructiveSetting, FieldGroup, IntegrityReport, ObservedEvent,
  RetentionFinding, TimingReport,
} from './analysers/quality.js'
export { sampleEpisodes, summariseEpisodes } from './episodes/sampler.js'
export type {
  EpisodeSample, EpisodeSummary, EpisodeType, SamplerEvent, SamplerOptions,
} from './episodes/sampler.js'
export {
  BUNDLE_FIELD_ALLOWLIST, MAX_H3_RESOLUTION, MIN_COHORT_SIZE, MIN_TIME_BUCKET_S,
  checkRedaction, coarsenToCell, suppressSmallCohorts,
} from './bundle/redaction.js'
export type { RedactionViolation, RedactionViolationCode } from './bundle/redaction.js'
export { BUNDLE_VERSION, emitBundle, serializeBundle } from './bundle/emitter.js'
export type { BundleManifest, BundleThresholds, EmitResult, FindingsBundle } from './bundle/emitter.js'
export { MissingNarrativeError, UnsupportedClaimError, renderReport } from './report/render.js'
export type {
  Claim, EvidenceStatus, NarrativeSections, Recommendation, ReportInput,
} from './report/render.js'
export {
  MissingTenantContextError, checkTenantIsolation, withTenant, withoutTenantForTesting,
} from './db/tenant.js'
export type { TenantContextCheck } from './db/tenant.js'
export { FileObjectStore, IntegrityError, sha256Hex, verifySample } from './db/object-store.js'
export type { ObjectStore, VerificationReport } from './db/object-store.js'
export {
  PostgresObservationStore, PostgresQuarantineStore, PostgresReceiptStore, traceToReceipt,
} from './db/stores.js'
export type { AuditTrace, StoredQuarantine, StoredReceipt } from './db/stores.js'
export {
  IMMUTABLE_TIME_FIELDS, TimeOverwriteError, currentVersion, diffVersions, enrich, nextVersionFor,
  normalize,
} from './normalize/normalizer.js'
export type { Adapter, NormalizeResult, ObservationVersion, VersionDiff } from './normalize/normalizer.js'
export { redecode } from './db/stores.js'
export type { RedecodeOutcome } from './db/stores.js'
export {
  DEFAULT_LIMITS, checkScope, planWindows, remainingWindows, runReplay,
} from './replay/replay.js'
export type {
  ReplayHooks, ReplayLimits, ReplayOutcome, ReplayProgress, ReplayScope, ReplayStatus, ReplayWindow,
  ScopeCheck, ScopeRejection,
} from './replay/replay.js'
export { postgresHooks, startOrResumeRun } from './replay/postgres-replay.js'
export type { StartedRun } from './replay/postgres-replay.js'
export {
  ACCEPTED_MAP_LICENCES, FORBIDDEN_IN_TENANT_SCHEMA, MissingAttributionError, OSM_ATTRIBUTION,
  TENANT_SAFE_SEGMENT_FIELDS, assertAttributed, attributionFor, checkSnapshot, surrogateKeyFor,
} from './geo/snapshot.js'
export type {
  ExportManifestAttribution, SegmentGeometry, SnapshotCheck, SnapshotMetadata, SnapshotRejection,
} from './geo/snapshot.js'
export { runAcceptance, summarise } from './acceptance/release-a.js'
export type { AcceptanceReport, Criterion, CriterionResult, CriterionStatus } from './acceptance/release-a.js'
export {
  DisabledCellLookup, ForbiddenAcquisitionError, OPENCELLID_ATTRIBUTION, assertAcquisitionPermitted,
  canSupportUrgentAction, cellEvidenceFrom, describeAbsence, explainActionability,
} from './cells/opencellid.js'
export type {
  ActionabilityExplanation, CellAcquisition, CellKey, CellLookup, CellLookupResult, CellRecord,
  EvidenceFamily, EvidenceItem, EvidenceStrength,
} from './cells/opencellid.js'
export {
  ALLOWED_TRANSITIONS, ApprovalRequiredError, IllegalTransitionError, applyLateData,
  confirmsRecovery, currentState, currentVersion as currentEpisodeVersion, evaluateLateData,
  isFinalised, openEpisode, requiresApproval, transition,
} from './episodes/lifecycle.js'
export type {
  ConfirmationPolicy, Episode, EpisodeState, EpisodeVersion, LateDataOutcome, LateReport,
  RecordedAction, RevisionCause, TransitionRequest,
} from './episodes/lifecycle.js'
export {
  FACT_VOCABULARY, FACT_VOCABULARY_VERSION, available, deriveFacts, isVocabularyFact, unavailable,
} from './rules/facts.js'
export type { Fact, FactDefinition, FactDerivationInput, FactSet, FactValue } from './rules/facts.js'
export {
  GLOBAL_PROHIBITED, HYPOTHESIS_CODES, PROHIBITED_BY_HYPOTHESIS, TAMPER_REQUIRED_PHRASE,
  evaluateRule, isEffectiveAt, validateRulePackage,
} from './rules/package.js'
export type {
  CounterCondition, CounterNote, HypothesisCode, Predicate, RuleFixture, RuleGovernance,
  RuleOutcome, RulePackage, RuleViolation,
} from './rules/package.js'
export { CONTRADICTIONS, RULE_PACKAGES } from './rules/packages.js'
export type { Contradiction } from './rules/packages.js'
export { classify } from './rules/classify.js'
export type {
  ClassificationResult, ClassifiedHypothesis, InapplicableRule, PriorityFactor,
} from './rules/classify.js'
export { diffClassifications, summariseClassification } from './rules/diff.js'
export type {
  ClassificationChange, ClassificationSnapshot, ClassificationSummary,
} from './rules/diff.js'

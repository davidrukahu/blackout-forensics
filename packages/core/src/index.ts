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

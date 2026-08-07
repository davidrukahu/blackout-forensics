// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

export { createRng, syntheticRef } from './prng.js'
export type { Rng } from './prng.js'
export { CORRIDORS, distanceM, bearingDeg, walkCorridor } from './geography.js'
export type { Corridor, LatLon, TrackPoint } from './geography.js'
export {
  DEFAULT_POLICY, QUECLINK_GV75, TELTONIKA_FMB920, SYNTHETIC_TENANT_PREFIX, generateBaseline,
} from './generate.js'
export type {
  Baseline, BaselineOptions, CanonicalEvent, DeviceProfile, MotionState, ReportingPolicy,
} from './generate.js'
export { SCENARIOS, SCENARIO_NAMES, POLICY_CHANGE_MID_EPISODE, runScenario } from './scenarios.js'
export type { GroundTruth, Scenario, ScenarioContext, ScenarioResult } from './scenarios.js'

// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Backup, restore and disaster recovery — NFR-DR-001 (15-minute RPO), NFR-DR-002 (four-hour
 * RTO), NFR-DUR-002 (quarterly full restore exercise).
 *
 * The targets are data, the status is computed, and the exercise record is evidence: a DR page
 * that says "backups are healthy" without saying what would satisfy the RPO is reassurance, not
 * a control. Everything here is deployment-profile-agnostic domain logic; the container ships
 * the pg_dump/WAL machinery, and the integration tests exercise a real timed restore.
 */

/** Documented recovery targets for the self-hosted profile. Referenced by the runbook and docs. */
export const DR_TARGETS = {
  rpoMinutes: 15,
  rtoHours: 4,
  baseBackupEvery: 'daily',
  walShipEveryMinutes: 5,
  restoreExerciseEveryDays: 92,
  backupRetentionDays: 35,
} as const

export const RECOVERY_RUNBOOK: readonly string[] = [
  '1. Declare the incident and record the declared point-in-time recovery target.',
  '2. Provision a clean Postgres 16 instance (same major version) from the container image.',
  '3. Restore the most recent base backup; verify its checksum against the backup record.',
  '4. Replay WAL segments to the recovery target; the gap between target and last segment is the realized RPO.',
  '5. Run the verification suite: row counts, RLS policies, append-only triggers, object-store sample verification.',
  '6. Repoint the application; record start-to-serving duration — the realized RTO.',
  '7. File the exercise record; two-person review if any verification failed.',
] as const

export interface BackupRecord {
  readonly id: string
  readonly kind: 'base' | 'wal_segment'
  readonly takenAt: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly ok: boolean
}

export interface DailyBackupStatus {
  readonly at: string
  readonly health: 'healthy' | 'degraded' | 'failing'
  /** Age of the newest successful artifact — the realized RPO bound right now. */
  readonly realizedRpoMinutes: number | null
  readonly rpoSatisfied: boolean
  readonly lastBaseAgeHours: number | null
  readonly reasons: readonly string[]
}

/** The daily status NFR-DR asks operators to automate. Computed, never asserted. */
export function backupStatus(records: readonly BackupRecord[], now: string): DailyBackupStatus {
  const nowMs = Date.parse(now)
  const ok = records.filter((record) => record.ok)
  const newest = ok.map((record) => Date.parse(record.takenAt)).sort((a, b) => b - a)[0]
  const newestBase = ok
    .filter((record) => record.kind === 'base')
    .map((record) => Date.parse(record.takenAt))
    .sort((a, b) => b - a)[0]

  const reasons: string[] = []
  const realizedRpoMinutes = newest === undefined ? null : (nowMs - newest) / 60_000
  const lastBaseAgeHours = newestBase === undefined ? null : (nowMs - newestBase) / 3_600_000

  if (realizedRpoMinutes === null) reasons.push('no successful backup artifact exists')
  else if (realizedRpoMinutes > DR_TARGETS.rpoMinutes) {
    reasons.push(
      `newest artifact is ${Math.round(realizedRpoMinutes)}m old; the RPO target is ${DR_TARGETS.rpoMinutes}m`,
    )
  }
  if (lastBaseAgeHours === null) reasons.push('no successful base backup exists')
  else if (lastBaseAgeHours > 26) {
    // Daily cadence with a two-hour scheduling margin: past that, the base is late, not "roughly daily".
    reasons.push(`base backup is ${lastBaseAgeHours.toFixed(1)}h old; cadence is daily`)
  }
  const recentFailures = records.filter(
    (record) => !record.ok && nowMs - Date.parse(record.takenAt) < 24 * 3_600_000,
  )
  if (recentFailures.length > 0) {
    reasons.push(`${recentFailures.length} failed backup(s) in the last 24h`)
  }

  const rpoSatisfied = realizedRpoMinutes !== null && realizedRpoMinutes <= DR_TARGETS.rpoMinutes
  const health =
    realizedRpoMinutes === null || lastBaseAgeHours === null
      ? 'failing'
      : reasons.length === 0
        ? 'healthy'
        : rpoSatisfied
          ? 'degraded'
          : 'failing'

  return { at: now, health, realizedRpoMinutes, rpoSatisfied, lastBaseAgeHours, reasons }
}

// ------------------------------------------------------------------ restore exercises

export interface RestoreVerification {
  readonly rowsRestored: number
  readonly rlsPolicies: number
  readonly appendOnlyTriggers: number
  readonly objectSampleVerified: boolean
}

export interface RestoreExercise {
  readonly id: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly recoveryTargetAt: string
  /** Newest data actually recovered — target minus this is the realized RPO. */
  readonly recoveredThroughAt: string
  readonly verification: RestoreVerification
  readonly passed: boolean
  readonly realizedRtoHours: number
  readonly realizedRpoMinutes: number
  readonly notes: readonly string[]
}

export function evaluateExercise(params: {
  readonly id: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly recoveryTargetAt: string
  readonly recoveredThroughAt: string
  readonly verification: RestoreVerification
}): RestoreExercise {
  const realizedRtoHours =
    (Date.parse(params.finishedAt) - Date.parse(params.startedAt)) / 3_600_000
  const realizedRpoMinutes =
    (Date.parse(params.recoveryTargetAt) - Date.parse(params.recoveredThroughAt)) / 60_000

  const notes: string[] = []
  const { verification } = params
  if (verification.rowsRestored <= 0) notes.push('no rows restored')
  if (verification.rlsPolicies <= 0) notes.push('row-level security policies missing after restore')
  if (verification.appendOnlyTriggers <= 0) notes.push('append-only triggers missing after restore')
  if (!verification.objectSampleVerified) notes.push('object-store sample verification failed')
  if (realizedRtoHours > DR_TARGETS.rtoHours) {
    notes.push(`realized RTO ${realizedRtoHours.toFixed(2)}h exceeds the ${DR_TARGETS.rtoHours}h target`)
  }
  if (realizedRpoMinutes > DR_TARGETS.rpoMinutes) {
    notes.push(
      `realized RPO ${realizedRpoMinutes.toFixed(1)}m exceeds the ${DR_TARGETS.rpoMinutes}m target`,
    )
  }

  return {
    ...params,
    passed: notes.length === 0,
    realizedRtoHours,
    realizedRpoMinutes,
    notes,
  }
}

/** NFR-DUR-002: quarterly. Due when none passed within the window — a failed exercise never resets the clock. */
export function exerciseDue(exercises: readonly RestoreExercise[], now: string): boolean {
  const cutoff = Date.parse(now) - DR_TARGETS.restoreExerciseEveryDays * 86_400_000
  return !exercises.some(
    (exercise) => exercise.passed && Date.parse(exercise.finishedAt) >= cutoff,
  )
}

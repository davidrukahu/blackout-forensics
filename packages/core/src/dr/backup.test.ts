// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * NFR-DR-001/002 and NFR-DUR-002: targets as data, status computed, exercises evidenced.
 */

import { describe, expect, it } from 'vitest'

import {
  DR_TARGETS,
  RECOVERY_RUNBOOK,
  backupStatus,
  evaluateExercise,
  exerciseDue,
  type BackupRecord,
  type RestoreExercise,
} from './backup.js'

const NOW = '2026-08-08T06:00:00.000Z'
const minutesAgo = (m: number): string => new Date(Date.parse(NOW) - m * 60_000).toISOString()

const record = (overrides: Partial<BackupRecord> & { id: string }): BackupRecord => ({
  kind: 'wal_segment',
  takenAt: minutesAgo(5),
  sizeBytes: 1024,
  sha256: 'a'.repeat(64),
  ok: true,
  ...overrides,
})

describe('the documented targets', () => {
  it('carry the NFR numbers and a runbook that ends in a filed record', () => {
    expect(DR_TARGETS.rpoMinutes).toBe(15)
    expect(DR_TARGETS.rtoHours).toBe(4)
    expect(DR_TARGETS.restoreExerciseEveryDays).toBe(92)
    expect(DR_TARGETS.backupRetentionDays).toBe(35)
    expect(RECOVERY_RUNBOOK.at(-1)).toContain('exercise record')
  })
})

describe('daily backup status', () => {
  it('healthy when base is fresh and the newest artifact is inside the RPO', () => {
    const status = backupStatus(
      [record({ id: 'base', kind: 'base', takenAt: minutesAgo(600) }), record({ id: 'wal' })],
      NOW,
    )
    expect(status.health).toBe('healthy')
    expect(status.rpoSatisfied).toBe(true)
    expect(status.realizedRpoMinutes).toBe(5)
  })

  it('failing when the newest artifact is older than the RPO — the number names the gap', () => {
    const status = backupStatus(
      [record({ id: 'base', kind: 'base', takenAt: minutesAgo(60) })],
      NOW,
    )
    expect(status.health).toBe('failing')
    expect(status.reasons.some((reason) => reason.includes('RPO target is 15m'))).toBe(true)
  })

  it('degraded when RPO holds but the base is late or a backup failed recently', () => {
    const status = backupStatus(
      [
        record({ id: 'base', kind: 'base', takenAt: minutesAgo(28 * 60) }),
        record({ id: 'wal' }),
        record({ id: 'bad', ok: false, takenAt: minutesAgo(30) }),
      ],
      NOW,
    )
    expect(status.health).toBe('degraded')
    expect(status.reasons).toHaveLength(2)
  })

  it('failing outright with no artifacts — absence is not health', () => {
    expect(backupStatus([], NOW).health).toBe('failing')
  })
})

describe('restore exercises', () => {
  const verification = {
    rowsRestored: 1200, rlsPolicies: 12, appendOnlyTriggers: 3, objectSampleVerified: true,
  }

  it('passes when verification holds and both targets are met, with realized numbers recorded', () => {
    const exercise = evaluateExercise({
      id: 'dr-2026-q3',
      startedAt: '2026-08-08T01:00:00.000Z',
      finishedAt: '2026-08-08T02:30:00.000Z',
      recoveryTargetAt: '2026-08-08T00:00:00.000Z',
      recoveredThroughAt: '2026-08-07T23:52:00.000Z',
      verification,
    })
    expect(exercise.passed).toBe(true)
    expect(exercise.realizedRtoHours).toBe(1.5)
    expect(exercise.realizedRpoMinutes).toBe(8)
  })

  it('fails on a slow restore or a data gap past the RPO, and says which', () => {
    const slow = evaluateExercise({
      id: 'dr-slow',
      startedAt: '2026-08-08T01:00:00.000Z',
      finishedAt: '2026-08-08T06:30:00.000Z',
      recoveryTargetAt: '2026-08-08T00:00:00.000Z',
      recoveredThroughAt: '2026-08-07T23:00:00.000Z',
      verification,
    })
    expect(slow.passed).toBe(false)
    expect(slow.notes.some((note) => note.includes('RTO'))).toBe(true)
    expect(slow.notes.some((note) => note.includes('RPO'))).toBe(true)
  })

  it('missing RLS after restore fails the exercise regardless of speed', () => {
    const exercise = evaluateExercise({
      id: 'dr-norls',
      startedAt: '2026-08-08T01:00:00.000Z',
      finishedAt: '2026-08-08T01:30:00.000Z',
      recoveryTargetAt: '2026-08-08T00:00:00.000Z',
      recoveredThroughAt: '2026-08-08T00:00:00.000Z',
      verification: { ...verification, rlsPolicies: 0 },
    })
    expect(exercise.passed).toBe(false)
    expect(exercise.notes[0]).toContain('row-level security')
  })

  it('quarterly cadence: due with none, satisfied by a recent pass, never by a recent failure', () => {
    expect(exerciseDue([], NOW)).toBe(true)
    const pass: RestoreExercise = evaluateExercise({
      id: 'ok', startedAt: minutesAgo(60 * 24 * 30), finishedAt: minutesAgo(60 * 24 * 30 - 90),
      recoveryTargetAt: minutesAgo(60 * 24 * 30 + 10), recoveredThroughAt: minutesAgo(60 * 24 * 30 + 12),
      verification,
    })
    expect(pass.passed).toBe(true)
    expect(exerciseDue([pass], NOW)).toBe(false)

    const fail = { ...pass, passed: false }
    expect(exerciseDue([fail], NOW)).toBe(true)
  })
})

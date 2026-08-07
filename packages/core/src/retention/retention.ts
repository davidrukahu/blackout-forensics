// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Retention automation — PRD §11.4.
 *
 * The defaults are configurable product defaults, never represented as statutory periods. The
 * three MUSTs are structural:
 *
 *   * **Idempotent**: a plan is a pure function of (inventory, policy, now) with a deterministic
 *     run id; executing the same plan twice deletes nothing the second time, because execution
 *     tombstones what it deletes and the plan excludes what is tombstoned.
 *   * **Observable**: the run report says what was deleted, what was kept and *why* it was kept —
 *     held, not yet due, or already tombstoned. Silence about a skipped item would make a hold
 *     indistinguishable from a bug.
 *   * **Evidenced**: every deletion leaves a tombstone naming the item, its class, the policy
 *     that made it due, and the run — the record that deletion happened on schedule is itself
 *     evidence with its own retention.
 *
 * Legal hold records scope, authority, start, review and release; a held item is reported, not
 * silently skipped, and release is an audited act. Backups age out on the documented schedule:
 * an expired item's tombstone carries the date after which no backup generation can contain it.
 */

export type DataClass =
  | 'quarantined_payload'
  | 'raw_receipt'
  | 'normalized_telemetry'
  | 'episode_evidence'
  | 'decision_outcome'
  | 'sla_aggregate'
  | 'audit_metadata'
  | 'map_snapshot'

export interface RetentionPolicy {
  /** Days each class is kept. Null = kept while needed for report reproduction (map snapshots). */
  readonly days: Readonly<Record<DataClass, number | null>>
  /** Rolling backup window, days. §11.4 caps it at 35. */
  readonly backupWindowDays: number
  readonly version: string
}

/** §11.4's table, verbatim. Configurable; the backup cap is not. */
export const DEFAULT_RETENTION: RetentionPolicy = {
  days: {
    quarantined_payload: 14,
    raw_receipt: 30,
    normalized_telemetry: 90,
    episode_evidence: 730,
    decision_outcome: 730,
    sla_aggregate: 1095,
    audit_metadata: 730,
    map_snapshot: null,
  },
  backupWindowDays: 35,
  version: '2026-08-08.1',
}

export const MAX_BACKUP_WINDOW_DAYS = 35
/** Tenants can approve normalized telemetry up to 180 days; nothing approves beyond it. */
export const MAX_NORMALIZED_TELEMETRY_DAYS = 180

export class InvalidRetentionPolicyError extends Error {
  constructor(detail: string) {
    super(`invalid retention policy: ${detail}`)
    this.name = 'InvalidRetentionPolicyError'
  }
}

export function validateRetentionPolicy(policy: RetentionPolicy): void {
  if (policy.backupWindowDays > MAX_BACKUP_WINDOW_DAYS) {
    throw new InvalidRetentionPolicyError(
      `backup window ${policy.backupWindowDays}d exceeds the §11.4 maximum of ${MAX_BACKUP_WINDOW_DAYS}d`,
    )
  }
  const telemetry = policy.days.normalized_telemetry
  if (telemetry !== null && telemetry > MAX_NORMALIZED_TELEMETRY_DAYS) {
    throw new InvalidRetentionPolicyError(
      `normalized telemetry ${telemetry}d exceeds the approvable maximum of ${MAX_NORMALIZED_TELEMETRY_DAYS}d`,
    )
  }
  for (const [dataClass, days] of Object.entries(policy.days)) {
    if (days !== null && days <= 0) {
      throw new InvalidRetentionPolicyError(`${dataClass} must keep data for at least one day`)
    }
  }
}

// ------------------------------------------------------------------ legal hold

export interface LegalHold {
  readonly id: string
  /** What the hold covers. An item matches if any selector matches. */
  readonly scope: {
    readonly tenantId: string
    readonly episodeIds?: readonly string[]
    readonly deviceRefs?: readonly string[]
    /** True = everything in the tenant. */
    readonly entireTenant?: boolean
  }
  readonly authority: string
  readonly placedBy: string
  readonly placedAt: string
  readonly reviewAt: string
  readonly releasedBy: string | null
  readonly releasedAt: string | null
}

export function holdActive(hold: LegalHold, at: string): boolean {
  return hold.releasedAt === null || Date.parse(at) < Date.parse(hold.releasedAt)
}

export function releaseHold(
  hold: LegalHold,
  params: { readonly releasedBy: string; readonly at: string },
): LegalHold {
  if (hold.releasedAt !== null) {
    throw new Error(`hold ${hold.id} was already released at ${hold.releasedAt}`)
  }
  return { ...hold, releasedBy: params.releasedBy, releasedAt: params.at }
}

// ------------------------------------------------------------------ planning

export interface RetainedItem {
  readonly ref: string
  readonly dataClass: DataClass
  readonly tenantId: string
  readonly createdAt: string
  readonly episodeId?: string
  readonly deviceRef?: string
  /** Set when a prior run already deleted it — the idempotency marker. */
  readonly tombstonedAt?: string
  /** Map snapshots: still referenced by a reproducible report. */
  readonly neededForReproduction?: boolean
}

export interface PlannedDeletion {
  readonly ref: string
  readonly dataClass: DataClass
  readonly dueAt: string
  /** No backup generation may contain this item after this date. */
  readonly purgedFromBackupsBy: string
}

export interface KeptItem {
  readonly ref: string
  readonly reason: 'not_due' | 'legal_hold' | 'already_tombstoned' | 'needed_for_reproduction'
  readonly holdId?: string
}

export interface RetentionPlan {
  /** Deterministic: sha of (policy version, now, sorted refs). Same inputs, same id. */
  readonly runId: string
  readonly now: string
  readonly policyVersion: string
  readonly deletions: readonly PlannedDeletion[]
  readonly kept: readonly KeptItem[]
}

function matchesHold(item: RetainedItem, hold: LegalHold): boolean {
  if (hold.scope.tenantId !== item.tenantId) return false
  if (hold.scope.entireTenant === true) return true
  if (item.episodeId !== undefined && hold.scope.episodeIds?.includes(item.episodeId) === true) return true
  if (item.deviceRef !== undefined && hold.scope.deviceRefs?.includes(item.deviceRef) === true) return true
  return false
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function planRetention(params: {
  readonly items: readonly RetainedItem[]
  readonly holds: readonly LegalHold[]
  readonly policy?: RetentionPolicy
  readonly now: string
}): RetentionPlan {
  const policy = params.policy ?? DEFAULT_RETENTION
  validateRetentionPolicy(policy)
  const nowMs = Date.parse(params.now)
  const activeHolds = params.holds.filter((hold) => holdActive(hold, params.now))

  const deletions: PlannedDeletion[] = []
  const kept: KeptItem[] = []

  for (const item of [...params.items].sort((a, b) => a.ref.localeCompare(b.ref))) {
    if (item.tombstonedAt !== undefined) {
      kept.push({ ref: item.ref, reason: 'already_tombstoned' })
      continue
    }

    const hold = activeHolds.find((h) => matchesHold(item, h))
    if (hold !== undefined) {
      kept.push({ ref: item.ref, reason: 'legal_hold', holdId: hold.id })
      continue
    }

    const days = policy.days[item.dataClass]
    if (days === null) {
      if (item.neededForReproduction === true) {
        kept.push({ ref: item.ref, reason: 'needed_for_reproduction' })
      } else {
        // A snapshot nothing references any more is due immediately.
        deletions.push({
          ref: item.ref,
          dataClass: item.dataClass,
          dueAt: params.now,
          purgedFromBackupsBy: new Date(nowMs + policy.backupWindowDays * 86_400_000).toISOString(),
        })
      }
      continue
    }

    const dueAtMs = Date.parse(item.createdAt) + days * 86_400_000
    if (dueAtMs > nowMs) {
      kept.push({ ref: item.ref, reason: 'not_due' })
    } else {
      deletions.push({
        ref: item.ref,
        dataClass: item.dataClass,
        dueAt: new Date(dueAtMs).toISOString(),
        purgedFromBackupsBy: new Date(nowMs + policy.backupWindowDays * 86_400_000).toISOString(),
      })
    }
  }

  const runId = `ret-${fnv1a(
    `${policy.version}|${params.now}|${deletions.map((d) => d.ref).join(',')}`,
  )}`
  return { runId, now: params.now, policyVersion: policy.version, deletions, kept }
}

// ------------------------------------------------------------------ execution

export interface Tombstone {
  readonly ref: string
  readonly dataClass: DataClass
  readonly deletedAt: string
  readonly runId: string
  readonly policyVersion: string
  readonly purgedFromBackupsBy: string
}

export interface RetentionRunReport {
  readonly runId: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly deleted: number
  readonly failed: readonly { ref: string; error: string }[]
  readonly keptByReason: Readonly<Record<KeptItem['reason'], number>>
  readonly tombstones: readonly Tombstone[]
}

export interface DeletionExecutor {
  /** Physically remove one item. Must be safe to call for an already-absent ref. */
  delete(ref: string, dataClass: DataClass): Promise<void>
}

export async function executeRetention(
  plan: RetentionPlan,
  executor: DeletionExecutor,
  finishedAt: string,
): Promise<RetentionRunReport> {
  const tombstones: Tombstone[] = []
  const failed: { ref: string; error: string }[] = []

  for (const deletion of plan.deletions) {
    try {
      await executor.delete(deletion.ref, deletion.dataClass)
      tombstones.push({
        ref: deletion.ref,
        dataClass: deletion.dataClass,
        deletedAt: finishedAt,
        runId: plan.runId,
        policyVersion: plan.policyVersion,
        purgedFromBackupsBy: deletion.purgedFromBackupsBy,
      })
    } catch (error) {
      // A failed deletion is reported, never silently retried into ambiguity: the next run's
      // plan will include the item again because no tombstone exists.
      failed.push({ ref: deletion.ref, error: error instanceof Error ? error.message : 'unknown' })
    }
  }

  const keptByReason = { not_due: 0, legal_hold: 0, already_tombstoned: 0, needed_for_reproduction: 0 }
  for (const item of plan.kept) keptByReason[item.reason] += 1

  return {
    runId: plan.runId,
    startedAt: plan.now,
    finishedAt,
    deleted: tombstones.length,
    failed,
    keptByReason,
    tombstones,
  }
}

/** Backup generations older than the window must be gone; §11.4's "expire from backups" check. */
export function overdueBackups(
  generations: readonly { readonly id: string; readonly takenAt: string }[],
  now: string,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): readonly { readonly id: string; readonly takenAt: string }[] {
  const cutoff = Date.parse(now) - policy.backupWindowDays * 86_400_000
  return generations.filter((generation) => Date.parse(generation.takenAt) < cutoff)
}

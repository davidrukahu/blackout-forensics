// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Offline historical replay.
 *
 * FR-EPI-007: recompute over an authorized historical interval, with runs that are resumable,
 * scoped and separately audited. The API contract adds approval and bounded scope
 * (POST /v1/adapters/{source}/replay).
 *
 * Three properties, and the reason each is a hard requirement rather than a nicety:
 *
 *   * **Bounded.** An unbounded replay over a live tenant is an unplanned reprocessing of the whole
 *     history, at a cost nobody agreed to. The scope is validated before a single window runs.
 *   * **Resumable.** A replay that fails halfway and must restart from the beginning will, in
 *     practice, be abandoned halfway — so the work never gets done and the data stays stale.
 *   * **Audited separately.** A replay changes what the evidence says. Recording it in the same
 *     stream as routine ingestion would make "why did this episode change?" unanswerable.
 */

export interface ReplayScope {
  readonly tenantId: string
  readonly source: string
  /** Inclusive lower bound. */
  readonly from: string
  /** Exclusive upper bound. */
  readonly to: string
  readonly approvedBy: string
  readonly reason: string
}

export interface ReplayLimits {
  /** Longest interval a single run may cover. */
  readonly maxIntervalDays: number
  /** Window size the interval is split into for checkpointing. */
  readonly windowHours: number
}

export const DEFAULT_LIMITS: ReplayLimits = {
  // Ninety days matches the default retention for normalized telemetry, so a single run cannot
  // silently exceed the period the tenant agreed to hold.
  maxIntervalDays: 90,
  windowHours: 24,
}

export type ScopeRejection =
  | 'unbounded'
  | 'inverted'
  | 'too_long'
  | 'missing_approval'
  | 'missing_reason'
  | 'future_interval'

export interface ScopeCheck {
  readonly ok: boolean
  readonly rejections: readonly ScopeRejection[]
}

/**
 * Validate a replay request before any work begins.
 *
 * Approval and reason are checked here rather than at the audit-writing step: a run that starts and
 * is then found unapproved has already changed data.
 */
export function checkScope(
  scope: Partial<ReplayScope>,
  now: string,
  limits: ReplayLimits = DEFAULT_LIMITS,
): ScopeCheck {
  const rejections: ScopeRejection[] = []

  if (scope.from === undefined || scope.to === undefined || scope.from === '' || scope.to === '') {
    rejections.push('unbounded')
    return { ok: false, rejections }
  }

  const from = Date.parse(scope.from)
  const to = Date.parse(scope.to)
  const nowMs = Date.parse(now)

  if (Number.isNaN(from) || Number.isNaN(to)) return { ok: false, rejections: ['unbounded'] }
  if (to <= from) rejections.push('inverted')
  if (to - from > limits.maxIntervalDays * 86_400_000) rejections.push('too_long')
  if (from > nowMs) rejections.push('future_interval')
  if (scope.approvedBy === undefined || scope.approvedBy === '') rejections.push('missing_approval')
  if (scope.reason === undefined || scope.reason === '') rejections.push('missing_reason')

  return { ok: rejections.length === 0, rejections }
}

export interface ReplayWindow {
  readonly index: number
  readonly from: string
  readonly to: string
}

/**
 * Split an interval into checkpointable windows.
 *
 * Windows are half-open and contiguous, so no observation is processed twice or skipped at a
 * boundary — the same discipline the assignment model uses, for the same reason.
 */
export function planWindows(scope: ReplayScope, limits: ReplayLimits = DEFAULT_LIMITS): ReplayWindow[] {
  const from = Date.parse(scope.from)
  const to = Date.parse(scope.to)
  const step = limits.windowHours * 3_600_000

  const windows: ReplayWindow[] = []
  let cursor = from
  let index = 0

  while (cursor < to) {
    const end = Math.min(cursor + step, to)
    windows.push({
      index,
      from: new Date(cursor).toISOString(),
      to: new Date(end).toISOString(),
    })
    cursor = end
    index += 1
  }
  return windows
}

/**
 * Windows still to run, given a checkpoint.
 *
 * A checkpoint records the upper bound of the last window *fully* processed, so resumption starts
 * at the first window beginning at or after it. A partially-processed window is re-run in full,
 * which is safe because ingestion is idempotent — and is the reason idempotency had to come first.
 */
export function remainingWindows(
  windows: readonly ReplayWindow[],
  checkpointAt: string | null,
): ReplayWindow[] {
  if (checkpointAt === null) return [...windows]
  const checkpoint = Date.parse(checkpointAt)
  return windows.filter((w) => Date.parse(w.to) > checkpoint)
}

export type ReplayStatus = 'running' | 'completed' | 'cancelled' | 'failed'

export interface ReplayProgress {
  readonly runId: string
  readonly status: ReplayStatus
  readonly windowsTotal: number
  readonly windowsDone: number
  readonly checkpointAt: string | null
}

export interface ReplayHooks {
  /** Process one window. Must be idempotent: a window may be re-run after a partial failure. */
  processWindow(window: ReplayWindow): Promise<void>
  /** Persist progress so a later run can resume. */
  saveCheckpoint(progress: ReplayProgress): Promise<void>
  /** Separate audit stream — never the routine ingestion log. */
  audit(entry: { action: string; detail: Record<string, unknown> }): Promise<void>
  /** Cooperative cancellation, checked between windows. */
  shouldCancel?(): Promise<boolean>
}

export interface ReplayOutcome {
  readonly status: ReplayStatus
  readonly windowsProcessed: number
  readonly checkpointAt: string | null
  readonly failedWindow?: ReplayWindow
}

/**
 * Run or resume a replay.
 *
 * Cancellation is checked between windows rather than inside one: stopping mid-window would leave a
 * checkpoint that claims more progress than was made, and the next resume would skip real work.
 */
export async function runReplay(
  runId: string,
  scope: ReplayScope,
  hooks: ReplayHooks,
  options: { checkpointAt?: string | null; limits?: ReplayLimits } = {},
): Promise<ReplayOutcome> {
  const limits = options.limits ?? DEFAULT_LIMITS
  const all = planWindows(scope, limits)
  const todo = remainingWindows(all, options.checkpointAt ?? null)

  await hooks.audit({
    action: options.checkpointAt == null ? 'replay.started' : 'replay.resumed',
    detail: {
      run_id: runId,
      source: scope.source,
      interval_start: scope.from,
      interval_end: scope.to,
      approved_by: scope.approvedBy,
      reason: scope.reason,
      windows_total: all.length,
      windows_remaining: todo.length,
    },
  })

  let checkpointAt = options.checkpointAt ?? null
  let processed = all.length - todo.length

  for (const window of todo) {
    if (hooks.shouldCancel !== undefined && (await hooks.shouldCancel())) {
      await hooks.audit({
        action: 'replay.cancelled',
        detail: { run_id: runId, windows_done: processed, checkpoint_at: checkpointAt },
      })
      await hooks.saveCheckpoint({
        runId, status: 'cancelled', windowsTotal: all.length, windowsDone: processed, checkpointAt,
      })
      return { status: 'cancelled', windowsProcessed: processed, checkpointAt }
    }

    try {
      await hooks.processWindow(window)
    } catch {
      // The checkpoint stays where it was: the failed window has not been fully processed, and
      // advancing past it would silently skip data on resume.
      await hooks.audit({
        action: 'replay.failed',
        detail: { run_id: runId, window_from: window.from, window_to: window.to, windows_done: processed },
      })
      await hooks.saveCheckpoint({
        runId, status: 'failed', windowsTotal: all.length, windowsDone: processed, checkpointAt,
      })
      return { status: 'failed', windowsProcessed: processed, checkpointAt, failedWindow: window }
    }

    processed += 1
    checkpointAt = window.to
    await hooks.saveCheckpoint({
      runId, status: 'running', windowsTotal: all.length, windowsDone: processed, checkpointAt,
    })
  }

  await hooks.audit({
    action: 'replay.completed',
    detail: { run_id: runId, windows_done: processed, checkpoint_at: checkpointAt },
  })
  await hooks.saveCheckpoint({
    runId, status: 'completed', windowsTotal: all.length, windowsDone: processed, checkpointAt,
  })

  return { status: 'completed', windowsProcessed: processed, checkpointAt }
}

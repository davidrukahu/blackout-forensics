// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Release A exit criteria, as executable checks.
 *
 * PRD §16.1's exit condition is "all deterministic ingestion, assignment, RLS, data-quality and
 * restore tests pass", and §17.1 lists the data-and-integration acceptance items.
 *
 * The point of running these as code rather than reading them as a checklist is that a gate which
 * cannot fail is not a gate. This runner reports `not_met` for criteria the project genuinely does
 * not satisfy yet, and the report is only "green" when every criterion passes — there is no partial
 * credit, and no way to declare Release A complete by omitting an inconvenient row.
 */

export type CriterionStatus = 'pass' | 'fail' | 'not_met'

export interface CriterionResult {
  readonly id: string
  readonly requirement: string
  readonly title: string
  readonly status: CriterionStatus
  /** What was actually observed. Evidence, not assertion. */
  readonly evidence: readonly string[]
  /** Present when not met: what remains, stated plainly. */
  readonly outstanding?: string
}

export interface AcceptanceReport {
  readonly release: 'A' | 'B'
  readonly generatedAt: string
  readonly criteria: readonly CriterionResult[]
  readonly passed: number
  readonly failed: number
  readonly notMet: number
  /** True only when every criterion passes. */
  readonly complete: boolean
}

export interface Criterion {
  readonly id: string
  readonly requirement: string
  readonly title: string
  run(): Promise<Omit<CriterionResult, 'id' | 'requirement' | 'title'>>
}

export async function runAcceptance(
  criteria: readonly Criterion[],
  generatedAt: string,
  release: 'A' | 'B' = 'A',
): Promise<AcceptanceReport> {
  const results: CriterionResult[] = []

  for (const criterion of criteria) {
    try {
      const outcome = await criterion.run()
      results.push({
        id: criterion.id,
        requirement: criterion.requirement,
        title: criterion.title,
        ...outcome,
      })
    } catch (error) {
      // A criterion that throws is a failure, never a skip. Swallowing it would produce a report
      // that looks complete because a check crashed.
      results.push({
        id: criterion.id,
        requirement: criterion.requirement,
        title: criterion.title,
        status: 'fail',
        evidence: [`check threw: ${error instanceof Error ? error.name : 'unknown error'}`],
      })
    }
  }

  const passed = results.filter((r) => r.status === 'pass').length
  const failed = results.filter((r) => r.status === 'fail').length
  const notMet = results.filter((r) => r.status === 'not_met').length

  return {
    release,
    generatedAt,
    criteria: results,
    passed,
    failed,
    notMet,
    complete: failed === 0 && notMet === 0,
  }
}

/** Human-readable summary. Failures and unmet criteria are listed first, never buried. */
export function summarise(report: AcceptanceReport): string {
  const lines: string[] = [
    `Release ${report.release} acceptance — ${report.generatedAt}`,
    `${report.passed} passed, ${report.failed} failed, ${report.notMet} not met`,
    '',
  ]

  const unresolved = report.criteria.filter((c) => c.status !== 'pass')
  if (unresolved.length > 0) {
    lines.push('OUTSTANDING:')
    for (const c of unresolved) {
      lines.push(`  [${c.status.toUpperCase()}] ${c.id} ${c.title} (${c.requirement})`)
      if (c.outstanding !== undefined) lines.push(`      ${c.outstanding}`)
    }
    lines.push('')
  }

  lines.push('PASSED:')
  for (const c of report.criteria.filter((x) => x.status === 'pass')) {
    lines.push(`  [PASS] ${c.id} ${c.title}`)
  }

  lines.push('')
  lines.push(
    report.complete
      ? `Release ${report.release} exit criteria are met.`
      : `Release ${report.release} is NOT complete. The items above must be resolved first.`,
  )
  return lines.join('\n')
}

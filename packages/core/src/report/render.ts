// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Telemetry Control Audit report.
 *
 * A single self-contained HTML file generated from a findings bundle. Everything quantitative is
 * generated; everything interpretive is written by a human and passed in as a narrative slot.
 *
 * The generator **fails when a slot is empty**. An unwritten judgement must not ship as a silent
 * omission — a report that quietly drops the data-rights grading looks complete to a customer who
 * has no way to know a section was skipped, and that is precisely the failure this product exists to
 * replace.
 *
 * The no-go path is a first-class output, not a failure mode. The engagement's own terms require the
 * audit to remain useful when the platform cannot proceed: the same document, a different
 * recommendation.
 */

import type { FindingsBundle } from '../bundle/emitter.js'

/** Biz plan §5.2's legend, applied to every claim in the document. */
export type EvidenceStatus = 'observed' | 'modeled' | 'customer-verified' | 'unconfirmed'

export interface Claim {
  readonly text: string
  readonly status: EvidenceStatus
  /** Required when the status is `modeled`: the inputs behind the number. */
  readonly inputs?: readonly string[]
}

export type Recommendation = 'proceed_to_pilot' | 'proceed_with_conditions' | 'no_go'

export interface NarrativeSections {
  /** Data-rights matrix grading and what it means for the engagement. */
  readonly dataRights: readonly Claim[]
  /** Reporting-policy gaps found, and what must be established before a pilot. */
  readonly reportingPolicyGaps: readonly Claim[]
  /** Whether a baseline comparison is feasible on this data. */
  readonly baselineFeasibility: readonly Claim[]
  /** The recommendation and its reasoning. */
  readonly recommendation: readonly Claim[]
}

const REQUIRED_SLOTS: readonly (keyof NarrativeSections)[] = [
  'dataRights',
  'reportingPolicyGaps',
  'baselineFeasibility',
  'recommendation',
]

export interface ReportInput {
  readonly bundle: FindingsBundle
  readonly narrative: NarrativeSections
  readonly recommendation: Recommendation
  readonly customerName: string
  readonly preparedBy: string
  /** Supplied rather than read from the clock, so a report regenerates identically. */
  readonly preparedAt: string
}

export class MissingNarrativeError extends Error {
  constructor(public readonly slots: readonly string[]) {
    super(
      `refusing to generate: ${slots.length} narrative slot(s) empty — ${slots.join(', ')}. ` +
        'An unwritten judgement must not ship as a silent omission.',
    )
    this.name = 'MissingNarrativeError'
  }
}

export class UnsupportedClaimError extends Error {
  constructor(public readonly claims: readonly string[]) {
    super(
      `refusing to generate: ${claims.length} modeled claim(s) with no inputs shown. ` +
        'A modeled number without its inputs is indistinguishable from a measurement.',
    )
    this.name = 'UnsupportedClaimError'
  }
}

const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const STATUS_LABEL: Record<EvidenceStatus, string> = {
  observed: 'Observed',
  modeled: 'Modeled',
  'customer-verified': 'Customer-verified',
  unconfirmed: 'Unconfirmed',
}

function renderClaim(claim: Claim): string {
  const inputs =
    claim.status === 'modeled' && claim.inputs !== undefined
      ? `<ul class="inputs">${claim.inputs.map((i) => `<li>${escape(i)}</li>`).join('')}</ul>`
      : ''
  return `<li><span class="chip ${claim.status}">${STATUS_LABEL[claim.status]}</span>${escape(claim.text)}${inputs}</li>`
}

function renderSection(title: string, claims: readonly Claim[]): string {
  return `<section><h2>${escape(title)}</h2><ul class="claims">${claims.map(renderClaim).join('')}</ul></section>`
}

function renderTable(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return '<p class="empty">No rows met the cohort floor for publication.</p>'
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))]
  const head = headers.map((h) => `<th>${escape(h)}</th>`).join('')
  const body = rows
    .map(
      (row) =>
        `<tr>${headers
          .map((h) => {
            const v = row[h]
            return `<td>${escape(v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v))}</td>`
          })
          .join('')}</tr>`,
    )
    .join('')
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
}

const RECOMMENDATION_COPY: Record<Recommendation, { heading: string; note: string }> = {
  proceed_to_pilot: {
    heading: 'Recommendation: proceed to a paid pilot',
    note: 'The data supports a historical evaluation and a shadow queue.',
  },
  proceed_with_conditions: {
    heading: 'Recommendation: proceed, subject to the conditions below',
    note: 'A pilot is feasible once the listed gaps are closed. Each condition names who closes it.',
  },
  no_go: {
    heading: 'Recommendation: do not proceed to a pilot',
    note:
      'The findings below stand on their own. Every measurement in this report describes your ' +
      'telemetry supply chain and is actionable with your vendors regardless of whether any ' +
      'further engagement follows.',
  },
}

/**
 * Render the report.
 *
 * Throws rather than degrading. Both failure modes are deliberate: a missing judgement and an
 * unsupported modeled number are the two ways a document like this misleads without lying.
 */
export function renderReport(input: ReportInput): string {
  const empty = REQUIRED_SLOTS.filter((slot) => input.narrative[slot].length === 0)
  if (empty.length > 0) throw new MissingNarrativeError(empty)

  const unsupported = REQUIRED_SLOTS.flatMap((slot) =>
    input.narrative[slot]
      .filter((c) => c.status === 'modeled' && (c.inputs === undefined || c.inputs.length === 0))
      .map((c) => c.text.slice(0, 60)),
  )
  if (unsupported.length > 0) throw new UnsupportedClaimError(unsupported)

  const { bundle } = input
  const copy = RECOMMENDATION_COPY[input.recommendation]

  const sections = Object.entries(bundle.sections)
    .map(([name, value]) => {
      const rows = Array.isArray(value) ? (value as Record<string, unknown>[]) : [value as Record<string, unknown>]
      return `<section><h3>${escape(name)}</h3>${renderTable(rows)}</section>`
    })
    .join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Telemetry Control Audit — ${escape(input.customerName)}</title>
<style>
  :root { color-scheme: light dark; --fg: #16181d; --bg: #fff; --muted: #5b6270; --line: #d9dde5; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e8eaef; --bg: #14161a; --muted: #9aa2b1; --line: #2c313a; }
  }
  body { margin: 0 auto; padding: 2rem 1.25rem 5rem; max-width: 52rem;
         font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif;
         color: var(--fg); background: var(--bg); }
  h1 { font-size: 1.6rem; margin-bottom: .25rem; }
  h2 { font-size: 1.15rem; margin-top: 2.5rem; border-bottom: 1px solid var(--line); padding-bottom: .35rem; }
  h3 { font-size: .95rem; margin-top: 1.75rem; color: var(--muted); font-weight: 600; }
  .sub { color: var(--muted); margin-top: 0; }
  .chip { display: inline-block; font-size: .7rem; letter-spacing: .04em; text-transform: uppercase;
          padding: .1rem .45rem; border-radius: 3px; margin-right: .5rem; border: 1px solid var(--line); }
  .chip.observed { background: #e6f4ea; color: #14532d; border-color: #a7d8b8; }
  .chip.modeled { background: #fff4e0; color: #663c00; border-color: #f0cf9a; }
  .chip.customer-verified { background: #e7f0fd; color: #10357a; border-color: #a9c4f0; }
  .chip.unconfirmed { background: #fdeaea; color: #7a1010; border-color: #f0adad; }
  .claims { list-style: none; padding: 0; }
  .claims > li { margin-bottom: .9rem; }
  .inputs { color: var(--muted); font-size: .85rem; margin: .35rem 0 0 1.25rem; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: .82rem; }
  th, td { border: 1px solid var(--line); padding: .3rem .5rem; text-align: left; white-space: nowrap; }
  th { background: color-mix(in srgb, var(--line) 30%, transparent); }
  .banner { border: 1px solid var(--line); border-left: 4px solid var(--muted);
            padding: .85rem 1rem; margin: 1.5rem 0; }
  .legend { font-size: .8rem; color: var(--muted); }
  footer { margin-top: 4rem; padding-top: 1rem; border-top: 1px solid var(--line);
           font-size: .8rem; color: var(--muted); }
  code { font-size: .78rem; }
</style>
</head>
<body>
<h1>Telemetry Control Audit</h1>
<p class="sub">${escape(input.customerName)} · prepared by ${escape(input.preparedBy)} · ${escape(input.preparedAt)}</p>

<div class="banner">
  <strong>${escape(copy.heading)}</strong><br>${escape(copy.note)}
</div>

<p class="legend">
  Every claim carries its evidence status.
  <span class="chip observed">Observed</span> measured from your data or read from your configuration.
  <span class="chip modeled">Modeled</span> a planning input, with its inputs shown.
  <span class="chip customer-verified">Customer-verified</span> confirmed by your team.
  <span class="chip unconfirmed">Unconfirmed</span> no sufficient evidence — stated so it is not mistaken for a finding.
</p>

${renderSection('Data rights', input.narrative.dataRights)}
${renderSection('Reporting-policy gaps', input.narrative.reportingPolicyGaps)}
${renderSection('Baseline feasibility', input.narrative.baselineFeasibility)}
${renderSection('Recommendation', input.narrative.recommendation)}

<h2>Measurements</h2>
<p class="legend">
  Generated from findings bundle <code>${escape(bundle.manifest.bundle_version)}</code>,
  covering ${escape(bundle.manifest.period_start)} to ${escape(bundle.manifest.period_end)}.
  Rows below a cohort of ${bundle.manifest.thresholds.min_cohort_size} devices are suppressed, and
  positions are published no finer than H3 resolution ${bundle.manifest.thresholds.max_h3_resolution}.
</p>
${sections}

<h2>How these thresholds were chosen</h2>
<ul class="claims">
${bundle.manifest.reasoning.map((r) => `<li><span class="chip modeled">Modeled</span>${escape(r)}</li>`).join('')}
</ul>

<footer>
<p>
  Bundle hashes: ${Object.entries(bundle.manifest.content_hashes)
    .map(([k, v]) => `<code>${escape(k)}=${escape(v.slice(0, 12))}</code>`)
    .join(' · ')}
</p>
<p>
  Container ${escape(bundle.manifest.container_version)} ·
  analysers ${Object.entries(bundle.manifest.analyser_versions).map(([k, v]) => `${escape(k)} ${escape(v)}`).join(', ')}
</p>
<p>
  <strong>Licence to the customer.</strong> Internal use unlimited. You may share this report with
  your own vendors and auditors — that is its purpose. Please do not publish it externally without
  our consent.
</p>
<p>
  This report describes telemetry behaviour. It is not legal advice, and it does not assert cause,
  intent or fault on the part of any borrower, vendor or operator.
</p>
</footer>
</body>
</html>
`
}

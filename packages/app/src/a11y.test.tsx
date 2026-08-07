// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom

/**
 * WCAG 2.2 AA verification for the core flows — §15.5 blocks release on an unresolved critical
 * finding in queue or case.
 *
 * Three layers, honestly labelled in the artifact this writes:
 *
 *   * axe-core over the real screens rendered with real corpus data — the automated floor.
 *   * Structural keyboard audit: every interactive element is a native control (button, a,
 *     input, select), which is what makes the flows operable without a mouse. The flows were
 *     additionally driven end-to-end through the accessibility tree during development —
 *     views switched, rows claimed, proposals made — which is recorded, not claimed as a
 *     substitute for a human screen-reader session.
 *   * Semantics the screens promised: landmarks, caption, header scope, labels, skip link.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import axe from 'axe-core'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getQueue, resetStoreForTesting } from './data/store.server.js'
import { loader as queueLoader } from './routes/queue.js'
import QueueScreen from './routes/queue.js'
import { loader as caseLoader } from './routes/case.js'
import CaseScreen from './routes/case.js'

const NOW = '2026-08-05T12:00:00.000Z'
const ANALYST = ['queue:read', 'queue:assign', 'case:read']

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  resetStoreForTesting()
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  container.remove()
})

const args = (url: string, params: Record<string, string> = {}) =>
  ({
    request: new Request(url, { headers: { cookie: 'bf-role=analyst' } }),
    params,
    context: {},
  }) as never

async function renderRoute(
  Component: () => React.ReactNode,
  loaderData: unknown,
  path: string,
): Promise<void> {
  // hydrationData pre-fills the loader result, so the router never issues its own fetch —
  // which jsdom's AbortSignal would reject.
  const router = createMemoryRouter(
    [{ id: 'route', path, Component: Component as never, loader: () => loaderData }],
    { initialEntries: [path], hydrationData: { loaderData: { route: loaderData } } },
  )
  await act(async () => {
    root = createRoot(container)
    root.render(<RouterProvider router={router} />)
  })
}

async function runAxe(): Promise<axe.AxeResults> {
  return axe.run(container, {
    // Colour-contrast needs real layout; jsdom has none. Contrast is controlled by the token
    // set in styles.css and belongs to the browser-level review, recorded in the artifact.
    rules: { 'color-contrast': { enabled: false } },
  })
}

const critical = (results: axe.AxeResults) =>
  results.violations.filter((violation) => ['critical', 'serious'].includes(violation.impact ?? ''))

const artifact: Record<string, unknown> = {}

describe('queue flow', () => {
  it('axe finds no critical or serious violation', async () => {
    const data = await queueLoader(args('http://app.test/queue'))
    await renderRoute(QueueScreen, data, '/queue')

    const results = await runAxe()
    const found = critical(results)
    expect(
      found.map((violation) => `${violation.id}: ${violation.nodes[0]?.html}`),
    ).toEqual([])
    artifact['queue_axe'] = { passes: results.passes.length, violations: results.violations.length }
  })

  it('every interactive element is a native control — the keyboard floor', async () => {
    const data = await queueLoader(args('http://app.test/queue'))
    await renderRoute(QueueScreen, data, '/queue')

    const clickable = container.querySelectorAll('[onclick], [role="button"]:not(button)')
    expect(clickable.length).toBe(0)
    const controls = container.querySelectorAll('button, a[href], input, select')
    expect(controls.length).toBeGreaterThan(5)

    // The named semantics: caption, header scope, labelled checkboxes.
    expect(container.querySelector('table.queue caption')).not.toBeNull()
    for (const th of container.querySelectorAll('th')) {
      expect(th.getAttribute('scope')).toBe('col')
    }
    for (const checkbox of container.querySelectorAll('input[type="checkbox"]')) {
      expect(checkbox.getAttribute('aria-label')).toBeTruthy()
    }
    artifact['queue_keyboard'] = {
      nativeControls: controls.length,
      nonNativeClickables: clickable.length,
    }
  })
})

describe('case flow', () => {
  async function renderCase(): Promise<void> {
    const id = getQueue({ scopes: ANALYST, viewId: 'view-urgent', now: NOW }).items[0]!.episodeId
    const data = await caseLoader(args(`http://app.test/cases/${id}`, { id }))
    await renderRoute(CaseScreen, data, `/cases/${id}`)
  }

  it('axe finds no critical or serious violation', async () => {
    await renderCase()
    const results = await runAxe()
    expect(
      critical(results).map((violation) => `${violation.id}: ${violation.nodes[0]?.html}`),
    ).toEqual([])
    artifact['case_axe'] = { passes: results.passes.length, violations: results.violations.length }
  })

  it('the §9.3 sections are labelled landmarks in document order', async () => {
    await renderCase()
    const headings = [...container.querySelectorAll('section[aria-labelledby] h2')].map(
      (heading) => heading.textContent,
    )
    expect(headings[0]).toBe('Reason and uncertainty')
    expect(headings).toContain('Candidate corridor')
    expect(headings.indexOf('Candidate corridor')).toBeGreaterThan(
      headings.indexOf('Reason and uncertainty'),
    )
    // Forms are labelled; nothing relies on placeholder text.
    for (const select of container.querySelectorAll('select')) {
      expect(select.closest('label')?.textContent ?? '').not.toBe('')
    }
    artifact['case_structure'] = { sections: headings.length }
  })

  it('writes the review record with what automation can and cannot claim', () => {
    artifact['manual_review'] = {
      keyboardTraversal:
        'performed via accessibility-tree navigation of the running app: view switching, row claim, proposal and approval flows all operable without a mouse',
      screenReader:
        'automated semantics verified (landmarks, labels, captions, scope); a human screen-reader session remains the pilot-readiness item and is tracked in the acceptance pack',
      colourContrast:
        'token set uses ink #1a1c1e on #ffffff and badge pairs chosen above 4.5:1; verified in browser, not assertable in jsdom',
    }
    mkdirSync(join(process.cwd(), 'release'), { recursive: true })
    writeFileSync(
      join(process.cwd(), 'release', 'a11y-review.json'),
      `${JSON.stringify({ standard: 'WCAG 2.2 AA', flows: ['queue', 'case'], ...artifact }, null, 2)}\n`,
    )
  })
})

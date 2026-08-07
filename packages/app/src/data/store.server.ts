// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The application's data layer, seeded from the reference corpus.
 *
 * Until the deployment wiring lands, episodes come from running every reference scenario through
 * the same sampler and classifier production uses — real domain objects, never hand-typed rows.
 * The layer's contracts are production's, though:
 *
 *   * Every function re-checks authorization at the object level (§11.1 — enforced twice).
 *   * Assignment goes through the domain's optimistic-concurrency check; the store never
 *     overwrites an owner without the caller having seen the current version.
 *   * Sensitive reads emit audit events through the same in-memory sink the audit screen reads.
 */

import {
  BUILTIN_VIEWS,
  CONTRADICTIONS,
  CORPUS_POLICY,
  FACT_VOCABULARY_VERSION,
  RULE_PACKAGES,
  applyView,
  assign,
  buildQueueItem,
  checkBulk,
  classify,
  expectedNextReport,
  factsForScenario,
  openEpisode,
  sampleEpisodes,
  transition,
  type AppAuditEvent,
  type BulkRefusal,
  type ClassificationResult,
  type Episode,
  type QueueItem,
  type SamplerEvent,
  type SavedView,
} from './core.server.js'
import { buildCaseDetail, type CaseDetail } from './case.server.js'
import { SCENARIO_NAMES, runScenario, type CanonicalEvent } from '@blackout/generator'

const SEED_START = '2026-08-05T06:00:00.000Z'
/** Each scenario runs as its own device (distinct seed): the seeded queue is a small fleet. */
const seedFor = (index: number) => ({ seed: 91 + index * 7, startAt: SEED_START })
/** Classification date: after the shipped rules' effective-from, as production replay would use. */
const CLASSIFY_AT = '2026-09-01T00:00:00.000Z'

interface StoredCase {
  episode: Episode
  classification: ClassificationResult
  source: string
  assetRef: string
  lastDefensibleObservationAt: string | null
  owner: string | null
  version: number
  scenario: string
  events: readonly CanonicalEvent[]
  corridorId: string
}

interface AppStore {
  readonly cases: Map<string, StoredCase>
  readonly auditEvents: AppAuditEvent[]
  readonly customViews: Map<string, SavedView>
}

function seed(): AppStore {
  const cases = new Map<string, StoredCase>()
  let assetCounter = 0

  for (const [index, name] of SCENARIO_NAMES.entries()) {
    const { events } = runScenario(name, seedFor(index))
    const byDevice = new Map<string, CanonicalEvent[]>()
    for (const event of events) {
      byDevice.set(event.device_ref, [...(byDevice.get(event.device_ref) ?? []), event])
    }

    const classification = classify({
      facts: factsForScenario(events),
      packages: RULE_PACKAGES,
      contradictions: CONTRADICTIONS,
      at: CLASSIFY_AT,
      factVocabularyVersion: FACT_VOCABULARY_VERSION,
    })

    for (const [deviceRef, deviceEvents] of byDevice) {
      const ordered = [...deviceEvents].sort((a, b) => a.received_at.localeCompare(b.received_at))
      const episodes = sampleEpisodes(ordered as unknown as SamplerEvent[], {
        policy: CORPUS_POLICY,
      })
      let sample = episodes[0]
      if (sample === undefined) {
        // A gap at the end of the stream is invisible to between-report sampling; production's
        // deadline monitor opens it. Seed the same way: if the classifier found something on
        // this scenario, the silence past the last report is the episode it found it about.
        if (classification.hypotheses.length === 0) continue
        const last = ordered.at(-1)
        if (last === undefined) continue
        const lastAt = (last.device_time ?? last.received_at) as string
        const expected = expectedNextReport({
          lastReportAt: lastAt,
          state: 'moving',
          policy: CORPUS_POLICY,
        })
        sample = {
          deviceRef,
          type: 'total_silence',
          startAt: lastAt,
          endAt: null,
          durationS: null,
          clockBasis: 'device_time',
          expectedIntervalS: expected.intervalS,
          missedReports: 1,
          policyVersion: expected.policyVersion,
          weakBasis: expected.weakBasis,
        }
      }

      assetCounter += 1
      const id = `ep-${name}-${deviceRef.slice(0, 6)}`
      let episode = openEpisode({
        id,
        deviceRef,
        type: sample.type,
        startAt: sample.startAt,
        actor: 'system:sampler',
        reason: `expected report missed (${sample.missedReports} missed)`,
        at: sample.startAt,
        clockBasis: sample.clockBasis,
        policyVersion: sample.policyVersion,
        finalisationWatermarkAt: '2026-09-04T00:00:00.000Z',
      })
      // An interior gap has already ended: the recovery that bounded the sample closes the
      // provisional watch into monitoring, carrying the end — exactly what the watermark
      // processor does when late records confirm the gap's edge.
      if (sample.endAt !== null) {
        episode = transition(episode, {
          to: 'monitoring',
          cause: 'evidence_updated',
          actor: 'system:watermark',
          reason: 'recovery observed; gap bounded',
          at: sample.endAt,
          endAt: sample.endAt,
        }, sample.endAt)
      }
      // A fired classification routes the episode to review, exactly as the pipeline would.
      if (classification.hypotheses.length > 0) {
        episode = transition(episode, {
          to: 'review_required',
          cause: 'evidence_updated',
          actor: 'system:classifier',
          reason: `hypotheses fired: ${classification.hypotheses.map((h) => h.code).join(', ')}`,
          at: sample.endAt ?? sample.startAt,
        }, sample.endAt ?? sample.startAt)
      }

      const lastBefore = ordered
        .filter((e) => Date.parse(e.received_at) <= Date.parse(sample.startAt))
        .at(-1)

      cases.set(id, {
        episode,
        classification,
        source: ordered[0]?.source ?? 'unknown',
        assetRef: `ast-${String(assetCounter).padStart(4, '0')}`,
        lastDefensibleObservationAt: lastBefore?.received_at ?? null,
        owner: null,
        version: 1,
        scenario: name,
        events: ordered,
        // Every reference scenario drives the generator's default corridor.
        corridorId: 'thika-road',
      })
    }
  }

  return { cases, auditEvents: [], customViews: new Map() }
}

// One store per server process; hot reload in dev replaces the module, so keep it on globalThis.
const globalStore = globalThis as { __bfStore?: AppStore }
function store(): AppStore {
  globalStore.__bfStore ??= seed()
  return globalStore.__bfStore
}

/** Test hook: a fresh seed, so tests never share mutable state. */
export function resetStoreForTesting(): void {
  delete globalStore.__bfStore
}

function toQueueItem(record: StoredCase, now: string): QueueItem {
  return buildQueueItem({
    episode: record.episode,
    classification: record.classification,
    source: record.source,
    assetRef: record.assetRef,
    lastDefensibleObservationAt: record.lastDefensibleObservationAt,
    owner: record.owner,
    version: record.version,
    now,
  })
}

function requireScope(scopes: readonly string[], needed: string): void {
  if (!scopes.includes(needed)) {
    throw new Response(`Missing scope: ${needed}`, { status: 403 })
  }
}

export function listViews(): readonly SavedView[] {
  return [...BUILTIN_VIEWS, ...store().customViews.values()]
}

export function getQueue(params: {
  readonly scopes: readonly string[]
  readonly viewId?: string
  readonly now?: string
}): { readonly view: SavedView; readonly items: readonly QueueItem[] } {
  requireScope(params.scopes, 'queue:read')
  const now = params.now ?? new Date().toISOString()
  const view =
    listViews().find((v) => v.id === params.viewId) ??
    ({ id: 'view-all', name: 'Everything', filters: {}, sort: 'due_first' } satisfies SavedView)
  const items = [...store().cases.values()].map((record) => toQueueItem(record, now))
  return { view, items: applyView(view, items) }
}

export type AssignResult =
  | { readonly kind: 'assigned'; readonly owner: string }
  | { readonly kind: 'conflict'; readonly episodeId: string; readonly currentOwner: string | null; readonly currentVersion: number }
  | { readonly kind: 'not_found' }

export function assignOwner(params: {
  readonly scopes: readonly string[]
  readonly actor: string
  readonly episodeId: string
  readonly owner: string
  readonly expectedVersion: number
}): AssignResult {
  requireScope(params.scopes, 'queue:assign')
  const record = store().cases.get(params.episodeId)
  if (record === undefined) return { kind: 'not_found' }

  const outcome = assign(
    { owner: record.owner, version: record.version },
    { owner: params.owner, expectedVersion: params.expectedVersion },
  )
  if (outcome.kind === 'conflict') {
    return {
      kind: 'conflict',
      episodeId: params.episodeId,
      currentOwner: outcome.currentOwner,
      currentVersion: outcome.currentVersion,
    }
  }

  record.owner = outcome.owner
  record.version = outcome.version
  store().auditEvents.push({
    actor: params.actor,
    action: 'queue.assign',
    at: new Date().toISOString(),
    detail: { episode_id: params.episodeId, owner: outcome.owner },
  })
  return { kind: 'assigned', owner: outcome.owner }
}

export function bulkAssign(params: {
  readonly scopes: readonly string[]
  readonly actor: string
  readonly episodeIds: readonly string[]
  readonly owner: string
  readonly now?: string
}): { readonly assigned: number; readonly refused: readonly BulkRefusal[] } {
  requireScope(params.scopes, 'queue:assign')
  const now = params.now ?? new Date().toISOString()
  const records = params.episodeIds
    .map((id) => store().cases.get(id))
    .filter((r): r is StoredCase => r !== undefined)

  const { eligible, refused } = checkBulk('assign_owner', records.map((r) => toQueueItem(r, now)))

  let assigned = 0
  for (const item of eligible) {
    const record = store().cases.get(item.episodeId)
    if (record === undefined) continue
    // Bulk assignment still goes through the same optimistic check — using the version just
    // read. A row that moved between read and write conflicts instead of being overwritten.
    const outcome = assign(
      { owner: record.owner, version: record.version },
      { owner: params.owner, expectedVersion: item.version },
    )
    if (outcome.kind === 'assigned') {
      record.owner = outcome.owner
      record.version = outcome.version
      assigned += 1
    }
  }
  if (assigned > 0) {
    store().auditEvents.push({
      actor: params.actor,
      action: 'queue.bulk_assign',
      at: new Date().toISOString(),
      detail: { episode_ids: [...params.episodeIds], owner: params.owner, assigned },
    })
  }
  return { assigned, refused }
}

export function saveView(params: {
  readonly scopes: readonly string[]
  readonly view: SavedView
}): void {
  requireScope(params.scopes, 'queue:read')
  if (BUILTIN_VIEWS.some((v) => v.id === params.view.id)) {
    throw new Response('Built-in views cannot be replaced', { status: 422 })
  }
  store().customViews.set(params.view.id, params.view)
}

export function auditTrail(): readonly AppAuditEvent[] {
  return store().auditEvents
}

export function getCase(params: {
  readonly scopes: readonly string[]
  readonly actor: string
  readonly episodeId: string
  readonly now?: string
}): CaseDetail | null {
  requireScope(params.scopes, 'case:read')
  const record = store().cases.get(params.episodeId)
  if (record === undefined) return null

  // §10.4: reading a case's full evidence is a sensitive view, recorded before it is returned.
  store().auditEvents.push({
    actor: params.actor,
    action: 'case.sensitive_view',
    at: new Date().toISOString(),
    detail: { episode_id: params.episodeId, device_ref: record.episode.deviceRef },
  })

  const now = params.now ?? new Date().toISOString()
  return buildCaseDetail({
    record,
    item: toQueueItem(record, now),
    fleet: [...store().cases.values()],
  })
}

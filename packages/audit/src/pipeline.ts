// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The audit pipeline: batch files in, findings bundle out.
 *
 * This is what runs inside the customer's environment. It reads their telemetry, computes
 * aggregates, and emits a bundle carrying no coordinates, no identifiers and no row-level data.
 * Nothing here reaches the network — the container has no outbound path, and the only thing that
 * leaves is a file the customer has read and approved.
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import {
  createMemoryStores,
  formatFromFilename,
  importBatch,
  type ImportResult,
} from '@blackout/connectors'
import {
  AssignmentRegistry,
  analyseCompleteness,
  analyseIntegrity,
  analysePlatformConfiguration,
  analyseTiming,
  emitBundle,
  percentiles,
  ratio,
  sampleEpisodes,
  summariseEpisodes,
  type DestructiveSetting,
  type EmitResult,
  type ObservedEvent,
  type ReportingPolicyRecord,
  type RetentionFinding,
  type SamplerEvent,
} from '@blackout/core'

export interface AuditInput {
  /** Paths to batch files inside the customer's environment. */
  readonly files: readonly string[]
  readonly tenantId: string
  readonly tenantLabel: string
  readonly source: string
  readonly periodStart: string
  readonly periodEnd: string
  /** Supplied by the caller so a run reproduces exactly. */
  readonly runAt: string
  readonly containerVersion: string
  readonly policy: ReportingPolicyRecord
  readonly assignments?: AssignmentRegistry
  /** Read from the platform's own configuration, not inferred from telemetry. */
  readonly destructiveSettings?: readonly DestructiveSetting[]
  readonly retention?: readonly Omit<RetentionFinding, 'sufficient'>[]
}

export interface AuditRunReport {
  readonly imports: readonly ImportResult[]
  readonly observationCount: number
  readonly quarantinedCount: number
  readonly emit: EmitResult
}

/**
 * Aggregate a completeness report into publishable rows.
 *
 * `device_count` is carried on every row because the cohort floor is enforced on it, and because a
 * completeness percentage without the population behind it is the easiest way to mislead.
 */
function completenessRows(
  events: readonly ObservedEvent[],
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []

  for (const report of analyseCompleteness(events)) {
    const devices = new Set(
      events
        .filter(
          (e) =>
            (e.device?.model ?? 'unknown') === report.cohort.model &&
            e.source === report.cohort.source &&
            e.received_at.slice(0, 10) === report.cohort.day,
        )
        .map((e) => e.device_ref),
    ).size

    for (const [group, d] of Object.entries(report.groups)) {
      rows.push({
        model: report.cohort.model,
        source: report.cohort.source,
        day: report.cohort.day,
        device_count: devices,
        field_group: group,
        denominator: d.denominator,
        numerator: d.numerator,
        excluded: d.excluded,
        exclusion_reasons: d.exclusionReasons,
        completeness: ratio(d),
      })
    }
  }
  return rows
}

export async function runAudit(input: AuditInput): Promise<AuditRunReport> {
  const stores = createMemoryStores()
  const imports: ImportResult[] = []

  for (const file of input.files) {
    const format = formatFromFilename(file)
    if (format === null) throw new Error(`unrecognised batch format: ${basename(file)}`)

    // Parquet needs random access to its footer, so the reader takes a path rather than bytes.
    const payload = format === 'parquet' ? file : readFileSync(file, 'utf8')

    imports.push(
      await importBatch(payload, stores, {
        tenantId: input.tenantId,
        source: input.source,
        batchId: `batch_${basename(file)}`,
        receivedAt: input.runAt,
        format,
        filename: file,
      }),
    )
  }

  const keys = await stores.observations.keys()
  const observations: ObservedEvent[] = []
  for (const key of keys) {
    const record = await stores.observations.get(key)
    if (record !== undefined) observations.push(record as unknown as ObservedEvent)
  }

  const timing = analyseTiming(observations)
  const integrity = analyseIntegrity(observations)
  const platform = analysePlatformConfiguration({
    destructive: input.destructiveSettings ?? [],
    retention: input.retention ?? [],
  })

  // Episodes are sampled per device: a gap only means something relative to one device's policy.
  const byDevice = new Map<string, SamplerEvent[]>()
  for (const observation of observations) {
    const list = byDevice.get(observation.device_ref) ?? []
    list.push(observation as unknown as SamplerEvent)
    byDevice.set(observation.device_ref, list)
  }

  const samples = [...byDevice.values()].flatMap((events) =>
    sampleEpisodes(
      [...events].sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at)),
      { policy: input.policy },
    ),
  )
  const episodes = summariseEpisodes(samples, byDevice.size)

  const observedForCoverage = observations.map((o) => ({
    deviceRef: o.device_ref,
    at: o.received_at,
  }))
  const registry = input.assignments ?? new AssignmentRegistry()

  const emit = emitBundle({
    tenantLabel: input.tenantLabel,
    sourceLabels: [input.source],
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    generatedAt: input.runAt,
    containerVersion: input.containerVersion,
    analyserVersions: { quality: '0.1.0', sampler: '0.1.0', importer: '0.1.0' },
    sections: {
      completeness: completenessRows(observations),
      timing: {
        platform_lag_s: timing.platformLagS,
        total_lag_s: timing.totalLagS,
        device_to_vendor_lag_s: timing.deviceToVendorLagS,
        observation_count: observations.length,
        device_count: byDevice.size,
      },
      integrity: {
        observation_count: integrity.total,
        duplicate_rate: integrity.total === 0 ? null : integrity.duplicateIdentities / integrity.total,
        out_of_order_rate: integrity.total === 0 ? null : integrity.outOfOrderByDeviceTime / integrity.total,
        backfill_rate: integrity.total === 0 ? null : integrity.backfilled / integrity.total,
        impossible_value_counts: integrity.impossibleValues,
        device_count: byDevice.size,
      },
      episodes: {
        episode_count: episodes.total,
        devices_with_episodes: episodes.devicesWithEpisodes,
        devices_observed: episodes.devicesObserved,
        suppressed_count: episodes.suppressed,
        weak_basis_count: episodes.weakBasis,
        duration_s: percentiles(episodes.durationsS),
        device_count: byDevice.size,
      },
      assignments: {
        assignment_coverage: registry.coverage(observedForCoverage),
        unmapped_device_count: registry.unmappedDevices(observedForCoverage).length,
        device_count: byDevice.size,
      },
      platform_configuration: {
        destructive_settings: platform.activeDestructiveSettings.map((d) => ({
          source: d.source, setting: d.setting, effect: d.effect,
          enabled: d.enabled, default_enabled: d.defaultEnabled,
        })),
        retention_findings: platform.retention.map((r) => ({
          source: r.source, raw_days: r.rawDays,
          customer_reducible: r.customerReducible, sufficient: r.sufficient,
        })),
        blocking_findings: platform.blockingFindings,
      },
    },
  })

  return {
    imports,
    observationCount: observations.length,
    quarantinedCount: (await stores.quarantine.list()).length,
    emit,
  }
}

// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Effective-dated asset, device, SIM and installer relationships.
 *
 * FR-AST-002: events before and after a reassignment must resolve to the correct historical
 * relationships. FR-AST-003: one asset may carry primary and secondary trackers, each evaluated
 * separately and combined only by a versioned asset policy. FR-AST-005: every overlap and unmapped
 * active device must reach the data-quality queue.
 */

import {
  detectDefects,
  resolveAt,
  type EffectiveDated,
  type TemporalDefect,
} from './temporal.js'

/**
 * A secondary tracker is not a spare — it is an independent observer of the same asset. Keeping the
 * role explicit is what stops peer correlation from counting two trackers on one motorcycle as two
 * independent devices (FR-COR-003).
 */
export type TrackerRole = 'primary' | 'secondary'

export interface AssetDeviceAssignment {
  readonly assetRef: string
  readonly deviceRef: string
  readonly role: TrackerRole
  readonly installerRef?: string
}

export interface DeviceSimAssignment {
  readonly deviceRef: string
  readonly simRef: string
  readonly providerRef?: string
}

export type EffectiveAssetDevice = EffectiveDated<AssetDeviceAssignment>
export type EffectiveDeviceSim = EffectiveDated<DeviceSimAssignment>

export interface ResolvedAssignment {
  readonly assetRef: string
  readonly deviceRef: string
  readonly role: TrackerRole
  readonly simRef?: string
  readonly installerRef?: string
  readonly providerRef?: string
}

export class AssignmentRegistry {
  private readonly assetDevice: EffectiveAssetDevice[] = []
  private readonly deviceSim: EffectiveDeviceSim[] = []

  addAssetDevice(record: EffectiveAssetDevice): this {
    this.assetDevice.push(record)
    return this
  }

  addDeviceSim(record: EffectiveDeviceSim): this {
    this.deviceSim.push(record)
    return this
  }

  /**
   * Resolve what a device belonged to at an instant.
   *
   * Keyed on device rather than asset because that is the direction telemetry arrives in: an event
   * names a device, and which asset it was attached to is a question about that moment in history.
   */
  resolveDevice(deviceRef: string, at: string): ResolvedAssignment | undefined {
    const assignment = resolveAt(
      this.assetDevice.filter((r) => r.deviceRef === deviceRef),
      at,
    )
    if (assignment === undefined) return undefined

    const sim = resolveAt(this.deviceSim.filter((r) => r.deviceRef === deviceRef), at)

    return {
      assetRef: assignment.assetRef,
      deviceRef: assignment.deviceRef,
      role: assignment.role,
      ...(sim?.simRef !== undefined ? { simRef: sim.simRef } : {}),
      ...(assignment.installerRef !== undefined ? { installerRef: assignment.installerRef } : {}),
      ...(sim?.providerRef !== undefined ? { providerRef: sim.providerRef } : {}),
    }
  }

  /** Every device attached to an asset at an instant, primary first. */
  resolveAsset(assetRef: string, at: string): ResolvedAssignment[] {
    const active = this.assetDevice.filter(
      (r) => r.assetRef === assetRef && resolveAt([r], at) !== undefined,
    )
    return active
      .map((r) => this.resolveDevice(r.deviceRef, at))
      .filter((r): r is ResolvedAssignment => r !== undefined)
      .sort((a, b) => (a.role === b.role ? 0 : a.role === 'primary' ? -1 : 1))
  }

  /**
   * Data-quality defects across every logical key.
   *
   * A device overlapping two assets is always wrong — a tracker is on one motorcycle at a time. An
   * asset with two devices is only wrong when both claim the same role, which is why overlap
   * detection is keyed on asset *and* role rather than asset alone.
   */
  defects(): TemporalDefect<AssetDeviceAssignment | DeviceSimAssignment>[] {
    const found: TemporalDefect<AssetDeviceAssignment | DeviceSimAssignment>[] = []

    for (const deviceRef of new Set(this.assetDevice.map((r) => r.deviceRef))) {
      found.push(
        ...detectDefects(
          `device:${deviceRef}`,
          this.assetDevice.filter((r) => r.deviceRef === deviceRef),
        ).filter((d) => d.kind !== 'gap'),
      )
    }

    for (const assetRef of new Set(this.assetDevice.map((r) => r.assetRef))) {
      for (const role of ['primary', 'secondary'] as const) {
        found.push(
          ...detectDefects(
            `asset:${assetRef}:${role}`,
            this.assetDevice.filter((r) => r.assetRef === assetRef && r.role === role),
          ),
        )
      }
    }

    for (const deviceRef of new Set(this.deviceSim.map((r) => r.deviceRef))) {
      found.push(
        ...detectDefects(
          `device-sim:${deviceRef}`,
          this.deviceSim.filter((r) => r.deviceRef === deviceRef),
        ).filter((d) => d.kind !== 'gap'),
      )
    }

    return found
  }

  /**
   * Devices that produced telemetry but have no effective assignment.
   *
   * This is the number the audit reports as assignment coverage, and the one PRD §18.1 gates a pilot
   * on at 95%.
   */
  unmappedDevices(observed: readonly { deviceRef: string; at: string }[]): string[] {
    const unmapped = new Set<string>()
    for (const { deviceRef, at } of observed) {
      if (this.resolveDevice(deviceRef, at) === undefined) unmapped.add(deviceRef)
    }
    return [...unmapped].sort()
  }

  /** Fraction of observations resolving to an effective assignment, 0–1. */
  coverage(observed: readonly { deviceRef: string; at: string }[]): number {
    if (observed.length === 0) return 1
    const resolved = observed.filter((o) => this.resolveDevice(o.deviceRef, o.at) !== undefined)
    return resolved.length / observed.length
  }
}

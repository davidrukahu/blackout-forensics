// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OSM snapshot provenance, activation and attribution.
 *
 * FR-GEO-001 requires a self-hosted road graph from a licensed extract, with no production
 * dependency on public OSM tile or routing servers. FR-GEO-005 requires map-data version, H3 cells
 * and stable geometry references, so historical evidence stays reproducible after OSM identifiers
 * change. FR-ADM-003 forbids an open-data layer from activating without source, licence and version
 * metadata.
 *
 * The licence research adds two structural constraints that this module exists to enforce:
 *
 *   * **No customer-derived attribute may be keyed on an OSM feature identifier.** A "risk score per
 *     OSM way" table is the shape ODbL's Horizontal Map Layers guideline treats as a Derivative
 *     Database, which would oblige publishing it. Segments therefore carry a surrogate key derived
 *     from geometry, and the OSM id lives only in the isolated snapshot schema.
 *   * **OSM and OpenCellID never share a derived database.** ODbL and CC BY-SA 4.0 are incompatible
 *     copylefts; a commingled derived database would owe both.
 */

import { createHash } from 'node:crypto'

/** Licences this project accepts for a map extract. Anything else needs a human decision. */
export const ACCEPTED_MAP_LICENCES = ['ODbL-1.0'] as const

export interface SnapshotMetadata {
  readonly sourceUrl: string
  readonly licence: string
  /** Extract date, YYYY-MM-DD. Part of the identity of a snapshot, not decoration. */
  readonly extractDate: string
  readonly sha256: string
  readonly attribution: string
}

export type SnapshotRejection =
  | 'missing_source_url'
  | 'missing_licence'
  | 'unaccepted_licence'
  | 'missing_extract_date'
  | 'malformed_extract_date'
  | 'missing_checksum'
  | 'malformed_checksum'
  | 'missing_attribution'
  | 'checksum_mismatch'

export interface SnapshotCheck {
  readonly ok: boolean
  readonly rejections: readonly SnapshotRejection[]
}

/** Attribution required wherever OSM-derived output appears — UI, PDF, CSV, API. */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors, licensed under ODbL 1.0'

/**
 * Decide whether a snapshot may be activated.
 *
 * Deliberately strict about the checksum: an extract whose bytes do not match the recorded hash is
 * not the extract that was reviewed, and a map layer nobody can pin to a known artefact cannot
 * support the claim that a corridor was computed from licensed data.
 */
export function checkSnapshot(
  metadata: Partial<SnapshotMetadata>,
  observedSha256?: string,
): SnapshotCheck {
  const rejections: SnapshotRejection[] = []

  if (metadata.sourceUrl === undefined || metadata.sourceUrl === '') rejections.push('missing_source_url')

  if (metadata.licence === undefined || metadata.licence === '') rejections.push('missing_licence')
  else if (!(ACCEPTED_MAP_LICENCES as readonly string[]).includes(metadata.licence)) {
    rejections.push('unaccepted_licence')
  }

  if (metadata.extractDate === undefined || metadata.extractDate === '') {
    rejections.push('missing_extract_date')
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(metadata.extractDate)) {
    rejections.push('malformed_extract_date')
  }

  if (metadata.sha256 === undefined || metadata.sha256 === '') rejections.push('missing_checksum')
  else if (!/^[0-9a-f]{64}$/.test(metadata.sha256)) rejections.push('malformed_checksum')
  else if (observedSha256 !== undefined && observedSha256 !== metadata.sha256) {
    rejections.push('checksum_mismatch')
  }

  if (metadata.attribution === undefined || metadata.attribution === '') {
    rejections.push('missing_attribution')
  }

  return { ok: rejections.length === 0, rejections }
}

export interface SegmentGeometry {
  /** Ordered coordinates of the way, as imported. */
  readonly coordinates: readonly (readonly [lon: number, lat: number])[]
  readonly osmWayId: number
  readonly highwayClass?: string
}

/**
 * Derive a stable key for a road segment from its geometry.
 *
 * OSM way identifiers are reassigned when a way is split or merged, so an episode whose corridor
 * evidence referenced a way id would become unresolvable after an ordinary map update — evidence
 * that decays is not evidence. Hashing rounded geometry instead means the same physical stretch of
 * road keeps the same key across snapshots.
 *
 * Coordinates are rounded to six decimals (~11 cm) before hashing: finer precision makes the key
 * sensitive to trivial re-surveys, coarser starts merging genuinely distinct segments.
 */
export function surrogateKeyFor(geometry: SegmentGeometry): string {
  const canonical = geometry.coordinates
    .map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`)
    .join(';')
  return `seg_${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`
}

/**
 * Fields a tenant table is permitted to hold about a road segment.
 *
 * An allow-list, checked in tests against the real schema: this is the boundary that keeps the
 * customer database out of ODbL's reach, and it must fail loudly rather than drift.
 */
export const TENANT_SAFE_SEGMENT_FIELDS = ['surrogate_key', 'h3_cell'] as const

/** Column names that must never appear in a tenant-schema table. */
export const FORBIDDEN_IN_TENANT_SCHEMA = [
  'osm_way_id',
  'osm_id',
  'osm_node_id',
  'osm_relation_id',
  'way_id',
  'geometry',
  'geom',
] as const

export interface ExportManifestAttribution {
  readonly osm?: string
  readonly opencellid?: string
  readonly snapshotSha256?: string
  readonly extractDate?: string
}

/**
 * Attribution block for an export manifest.
 *
 * A required field rather than a rendering concern: a PDF or CSV that leaves the building without
 * attribution is the failure mode ODbL actually cares about, and it is exactly the one a UI-level
 * component cannot prevent.
 */
export function attributionFor(
  snapshot: Pick<SnapshotMetadata, 'sha256' | 'extractDate'> | undefined,
  options: { includesCellData?: boolean } = {},
): ExportManifestAttribution {
  if (snapshot === undefined) return {}
  return {
    osm: OSM_ATTRIBUTION,
    ...(options.includesCellData === true
      ? { opencellid: '© OpenCellID contributors, licensed under CC BY-SA 4.0' }
      : {}),
    snapshotSha256: snapshot.sha256,
    extractDate: snapshot.extractDate,
  }
}

export class MissingAttributionError extends Error {
  constructor(readonly artefact: string) {
    super(
      `refusing to emit ${artefact}: OSM-derived output carries mandatory attribution, and an ` +
        'export that leaves without it is the failure ODbL actually cares about.',
    )
    this.name = 'MissingAttributionError'
  }
}

/** Assert an export manifest carries attribution before it is written. */
export function assertAttributed(
  manifest: { attribution?: ExportManifestAttribution },
  artefact: string,
  usedMapData: boolean,
): void {
  if (!usedMapData) return
  if (manifest.attribution?.osm === undefined || manifest.attribution.osm === '') {
    throw new MissingAttributionError(artefact)
  }
}

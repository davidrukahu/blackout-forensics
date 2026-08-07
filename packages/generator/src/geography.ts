// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Movement over real Nairobi-area corridors.
 *
 * Synthetic movements run over genuine road geometry so map-matching and corridor tests exercise
 * real topology — including the junctions that should make corridor projection return
 * `corridor_ambiguous` rather than a confident line.
 *
 * Coordinates are coarse waypoints entered by hand, not an OSM extract: this file is a route
 * skeleton, and no OSM-derived data is stored here. Map matching against a licensed extract happens
 * downstream, and no customer-derived attribute is ever keyed on an OSM feature id.
 */

import type { Rng } from './prng.js'

export interface LatLon {
  readonly lat: number
  readonly lon: number
}

export interface Corridor {
  readonly id: string
  readonly name: string
  /** Ordered waypoints, roughly 1–3 km apart. */
  readonly waypoints: readonly LatLon[]
  /** Typical speed for a boda on this corridor, km/h. */
  readonly typicalSpeedKph: number
  /**
   * True where the corridor has a junction dense enough that two plausible paths fit the same
   * elapsed time — the case corridor projection must refuse to resolve.
   */
  readonly hasAmbiguousJunction: boolean
}

export const CORRIDORS: readonly Corridor[] = [
  {
    id: 'thika-road',
    name: 'Thika Superhighway, Nairobi CBD to Ruiru',
    waypoints: [
      { lat: -1.2833, lon: 36.8253 },
      { lat: -1.2699, lon: 36.8348 },
      { lat: -1.2510, lon: 36.8471 },
      { lat: -1.2333, lon: 36.8600 },
      { lat: -1.2166, lon: 36.8752 },
      { lat: -1.1900, lon: 36.9020 },
      { lat: -1.1470, lon: 36.9600 },
    ],
    typicalSpeedKph: 42,
    hasAmbiguousJunction: true,
  },
  {
    id: 'mombasa-road',
    name: 'Mombasa Road, CBD to Athi River',
    waypoints: [
      { lat: -1.2921, lon: 36.8219 },
      { lat: -1.3110, lon: 36.8330 },
      { lat: -1.3280, lon: 36.8480 },
      { lat: -1.3480, lon: 36.8760 },
      { lat: -1.3860, lon: 36.9250 },
      { lat: -1.4560, lon: 36.9780 },
    ],
    typicalSpeedKph: 38,
    hasAmbiguousJunction: true,
  },
  {
    id: 'ngong-road',
    name: 'Ngong Road, CBD to Karen',
    waypoints: [
      { lat: -1.2900, lon: 36.8180 },
      { lat: -1.2960, lon: 36.7980 },
      { lat: -1.3010, lon: 36.7790 },
      { lat: -1.3100, lon: 36.7580 },
      { lat: -1.3190, lon: 36.7290 },
    ],
    typicalSpeedKph: 28,
    hasAmbiguousJunction: false,
  },
  {
    id: 'juja-outer',
    name: 'Outer Ring to Juja, mixed surface',
    waypoints: [
      { lat: -1.2620, lon: 36.8890 },
      { lat: -1.2450, lon: 36.9100 },
      { lat: -1.2210, lon: 36.9400 },
      { lat: -1.1980, lon: 36.9800 },
    ],
    typicalSpeedKph: 31,
    hasAmbiguousJunction: false,
  },
]

const EARTH_RADIUS_M = 6_371_000
const toRad = (deg: number): number => (deg * Math.PI) / 180

/** Great-circle distance in metres. */
export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))
}

/** Initial bearing in degrees, 0–360. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360
}

export interface TrackPoint extends LatLon {
  /** Metres travelled from the route start. */
  readonly odometerM: number
  readonly headingDeg: number
  readonly speedKph: number
}

/**
 * Walk a corridor at roughly its typical speed, emitting one point per interval.
 *
 * Speed jitters within a plausible band so that derived measures — delivery lag against distance,
 * corridor traversal time — are not suspiciously uniform.
 */
export function walkCorridor(
  corridor: Corridor,
  intervalS: number,
  pointCount: number,
  rng: Rng,
): TrackPoint[] {
  const points: TrackPoint[] = []
  let legIndex = 0
  let alongLegM = 0
  let odometerM = 0

  let arrived = false
  let lastHeading = 0

  for (let i = 0; i < pointCount; i++) {
    if (!arrived) {
      const from = corridor.waypoints[legIndex]
      const to = corridor.waypoints[legIndex + 1]
      if (from === undefined || to === undefined) break

      const legLengthM = distanceM(from, to)
      const speedKph = rng.float(corridor.typicalSpeedKph * 0.65, corridor.typicalSpeedKph * 1.25)
      const stepM = (speedKph / 3.6) * intervalS

      alongLegM += stepM
      odometerM += stepM

      while (alongLegM > legLengthM && legIndex + 2 < corridor.waypoints.length) {
        alongLegM -= legLengthM
        legIndex += 1
      }

      const current = corridor.waypoints[legIndex]
      const nextPoint = corridor.waypoints[legIndex + 1]
      if (current === undefined || nextPoint === undefined) break

      const remaining = distanceM(current, nextPoint)
      if (alongLegM >= remaining && legIndex + 2 >= corridor.waypoints.length) {
        // The route is exhausted: the vehicle has arrived. An earlier version pinned the track at
        // the final waypoint while KEEPING its jittered speed — bit-identical coordinates under a
        // claimed 40 km/h, which is precisely the frozen-fix-while-moving signature the stale-
        // position rule exists to catch. The generator was fabricating a GNSS fault at the end of
        // every track. An arrived vehicle parks: zero speed, stationary, and coordinates that
        // wander by a few metres the way a real parked GPS does.
        arrived = true
      }

      const fraction = Math.min(1, alongLegM / Math.max(1, remaining))
      lastHeading = Math.round(bearingDeg(current, nextPoint) * 10) / 10
      points.push({
        lat: current.lat + (nextPoint.lat - current.lat) * fraction,
        lon: current.lon + (nextPoint.lon - current.lon) * fraction,
        odometerM: Math.round(odometerM),
        headingDeg: lastHeading,
        speedKph: arrived ? 0 : Math.round(speedKph * 10) / 10,
      })
    } else {
      const end = corridor.waypoints[corridor.waypoints.length - 1] as LatLon
      points.push({
        // ~±2 m of jitter: a parked receiver never repeats a fix to the sixth decimal.
        lat: end.lat + rng.float(-0.00002, 0.00002),
        lon: end.lon + rng.float(-0.00002, 0.00002),
        odometerM: Math.round(odometerM),
        headingDeg: lastHeading,
        speedKph: 0,
      })
    }
  }

  return points
}

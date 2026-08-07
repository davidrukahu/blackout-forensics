// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: Apache-2.0

/**
 * The Traccar adapter against a real Traccar server.
 *
 * The ticket's done-condition is a self-hosted rig driving simulated devices and producing canonical
 * events that pass schema validation. Fixtures cannot establish that: they encode what I *believe*
 * Traccar emits, and the whole value of a reference adapter is that the belief has been checked.
 *
 * Positions are pushed over the OsmAnd protocol — plain HTTP, no device hardware — and read back
 * through Traccar's REST API, which returns the same position objects its forwarder wraps.
 */

import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateCanonicalEvent } from '@blackout/spec'

import { decodeTraccar, type TraccarForwardPayload } from './adapter.js'

let traccar: StartedTestContainer
let apiBase: string
let osmandBase: string
let deviceId: number

const UNIQUE_ID = '860123456789012'
const EMAIL = 'rig@example.invalid'
const PASSWORD = 'rig-password-1'
/** Set once the rig account exists. Traccar 6 does not accept a default admin over Basic auth. */
let AUTH = ''

const OPTIONS = {
  tenantId: 'synthetic_demo',
  source: 'traccar_forwarder',
  receivedAt: '2026-08-05T09:20:04.000Z',
  // Hex, because the schema's pseudonym pattern is hex — caught by the rig on the first run.
  assetRef: 'ast_a1b2c3d4',
  deviceRef: 'dev_e5f60718',
}

/** A short stretch of Thika Road, so the fixture geography matches the rest of the corpus. */
const TRACK = [
  { lat: -1.2833, lon: 36.8253, speed: 11.5, course: 41 },
  { lat: -1.2799, lon: 36.8288, speed: 13.2, course: 44 },
  { lat: -1.2750, lon: 36.8341, speed: 12.1, course: 46 },
]

beforeAll(async () => {
  traccar = await new GenericContainer('traccar/traccar:6.4-alpine')
    .withExposedPorts(8082, 5055)
    .withWaitStrategy(Wait.forHttp('/api/server', 8082).forStatusCode(200))
    .withStartupTimeout(180_000)
    .start()

  apiBase = `http://${traccar.getHost()}:${traccar.getMappedPort(8082)}/api`
  osmandBase = `http://${traccar.getHost()}:${traccar.getMappedPort(5055)}`

  // Traccar 6 enables self-registration by default, and that is the supported way to obtain an
  // account non-interactively. Falling back to a default admin would be guessing at credentials.
  const registered = await fetch(`${apiBase}/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'rig', email: EMAIL, password: PASSWORD }),
  })
  if (!registered.ok) {
    throw new Error(`could not register a rig account: ${registered.status} ${await registered.text()}`)
  }
  AUTH = `Basic ${Buffer.from(`${EMAIL}:${PASSWORD}`).toString('base64')}`

  const created = await fetch(`${apiBase}/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: AUTH },
    body: JSON.stringify({ name: 'rig-boda-01', uniqueId: UNIQUE_ID }),
  })
  if (!created.ok) throw new Error(`device creation failed: ${created.status} ${await created.text()}`)
  deviceId = ((await created.json()) as { id: number }).id

  // Drive the simulated device over the OsmAnd protocol.
  for (const [i, point] of TRACK.entries()) {
    const params = new URLSearchParams({
      id: UNIQUE_ID,
      lat: String(point.lat),
      lon: String(point.lon),
      speed: String(point.speed),
      bearing: String(point.course),
      timestamp: String(Math.floor(Date.parse('2026-08-05T09:19:55.000Z') / 1000) + i * 60),
      hdop: '0.9',
      batt: '88',
      ignition: 'true',
    })
    const sent = await fetch(`${osmandBase}/?${params.toString()}`)
    if (!sent.ok) throw new Error(`position push failed: ${sent.status}`)
  }

  // Traccar writes positions asynchronously; poll rather than sleep a fixed amount.
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await fetch(`${apiBase}/positions?deviceId=${deviceId}`, {
      headers: { authorization: AUTH },
    })
    if (response.ok && ((await response.clone().json()) as unknown[]).length > 0) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}, 300_000)

afterAll(async () => {
  await traccar?.stop()
})

type LivePosition = NonNullable<TraccarForwardPayload['position']>

async function livePositions(): Promise<LivePosition[]> {
  const response = await fetch(`${apiBase}/positions?deviceId=${deviceId}`, {
    headers: { authorization: AUTH },
  })
  expect(response.ok).toBe(true)
  return (await response.json()) as LivePosition[]
}

describe('the rig actually runs', () => {
  it('accepts positions over the OsmAnd protocol and stores them', async () => {
    const positions = await livePositions()
    expect(positions.length).toBeGreaterThan(0)
    expect(positions[0]?.latitude).toBeCloseTo(-1.27, 1)
  })

  it('reports the device it was told about', async () => {
    const response = await fetch(`${apiBase}/devices?id=${deviceId}`, {
      headers: { authorization: AUTH },
    })
    const devices = (await response.json()) as { uniqueId: string }[]
    expect(devices[0]?.uniqueId).toBe(UNIQUE_ID)
  })
})

describe('real Traccar output decodes to valid canonical events', () => {
  it('validates every position the rig produced', async () => {
    const positions = await livePositions()
    expect(positions.length).toBeGreaterThan(0)

    for (const position of positions) {
      const event = decodeTraccar({ position, device: { id: deviceId, uniqueId: UNIQUE_ID } }, OPTIONS)
      const result = validateCanonicalEvent(event)
      expect(result.errors, JSON.stringify(position).slice(0, 200)).toEqual([])
    }
  })

  it('reads the attributes Traccar actually attaches, not the ones I assumed', async () => {
    // The point of the rig: fixtures encode a belief about Traccar's output, and this is where the
    // belief gets checked.
    const positions = await livePositions()
    const first = positions[0]
    if (first === undefined) throw new Error('rig produced no positions')
    expect(Object.keys(first.attributes ?? {}).length).toBeGreaterThan(0)

    const event = decodeTraccar({ position: first }, OPTIONS)
    expect(validateCanonicalEvent(event).valid).toBe(true)
  })

  it('converts the speed Traccar stored, in the units Traccar uses', async () => {
    const positions = await livePositions()
    const withSpeed = positions.find((p) => (p?.speed ?? 0) > 0)
    if (withSpeed === undefined) {
      throw new Error('rig produced no position with a speed; the conversion cannot be checked')
    }
    const event = decodeTraccar({ position: withSpeed }, OPTIONS)
    const kph = (event['motion'] as { speed_kph: number }).speed_kph
    expect(kph).toBeCloseTo(withSpeed.speed! * 1.852, 1)
  })

  it('never lets the device identifier through', async () => {
    const positions = await livePositions()
    for (const position of positions) {
      const event = decodeTraccar({ position, device: { uniqueId: UNIQUE_ID } }, OPTIONS)
      expect(JSON.stringify(event)).not.toContain(UNIQUE_ID)
    }
  })

  it('gives every position a distinct vendor event id', async () => {
    const positions = await livePositions()
    const identities = positions.map(
      (p) => (decodeTraccar({ position: p }, OPTIONS)['event_identity'] as { value: string }).value,
    )
    expect(new Set(identities).size).toBe(positions.length)
  })
})

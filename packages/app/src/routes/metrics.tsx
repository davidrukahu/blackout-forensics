// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Metrics dashboard — shadcn-admin's dashboard composition (stat-card row, Overview chart with
 * a recent-activity list beside it), rendered server-side. The chart is deterministic SVG, not a
 * client chart library: the screen works before JavaScript arrives, like every other screen.
 *
 * Every number comes from getMetrics(), which runs the same §6.12 report builder the signed
 * exports use — there is no dashboard-only arithmetic, and the SLA card shows the report's own
 * integrity hash so what you see on screen is traceable to what an export would say.
 */

import { AlertTriangle, Clock3, Gauge, HelpCircle, Link as LinkIcon, ShieldAlert } from 'lucide-react'
import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router'

import { requireUser } from '../auth.server.js'
import { getMetrics } from '../data/store.server.js'
import { Badge } from '../components/ui/badge.js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.js'

import '../tailwind.css'

export async function loader({ request }: LoaderFunctionArgs) {
  const user = requireUser(request, ['queue:read'])
  return { metrics: getMetrics({ scopes: user.scopes }), actor: user.actor }
}

const BAND_VARIANT: Record<string, 'destructive' | 'default' | 'secondary' | 'outline'> = {
  direct: 'destructive',
  corroborated: 'default',
  weak: 'secondary',
  indeterminate: 'outline',
  unknown: 'outline',
}

/** shadcn's Overview bar chart, as deterministic SVG: primary bars, rounded tops, muted axis. */
function GapChart({ data }: { data: readonly { label: string; minutes: number }[] }) {
  const width = 640
  const height = 280
  const pad = { top: 12, right: 8, bottom: 44, left: 40 }
  const max = Math.max(1, ...data.map((d) => d.minutes))
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom
  const step = innerW / Math.max(1, data.length)
  const barW = Math.min(44, step * 0.62)

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f))

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      role="img"
      aria-label={`Gap duration in minutes for ${data.length} closed episodes`}
    >
      {ticks.map((tick) => {
        const y = pad.top + innerH - (tick / max) * innerH
        return (
          <g key={tick}>
            <text x={pad.left - 8} y={y + 4} textAnchor="end" className="fill-muted-foreground" fontSize="11">
              {tick}
            </text>
            <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} className="stroke-border" strokeDasharray="3 3" strokeWidth="1" />
          </g>
        )
      })}
      {data.map((d, i) => {
        const h = Math.max(2, (d.minutes / max) * innerH)
        const x = pad.left + i * step + (step - barW) / 2
        const y = pad.top + innerH - h
        return (
          <g key={d.label}>
            <rect x={x} y={y} width={barW} height={h} rx="4" className="fill-primary" />
            <text
              x={x + barW / 2}
              y={height - pad.bottom + 16}
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize="11"
            >
              {d.label.replace('ast-', '')}
            </text>
          </g>
        )
      })}
      <text x={width / 2} y={height - 6} textAnchor="middle" className="fill-muted-foreground" fontSize="11">
        asset (gap minutes) — open episodes are counted, never charted as bounded
      </text>
    </svg>
  )
}

function StatCard({
  title,
  value,
  hint,
  icon,
}: {
  title: string
  value: string
  hint: string
  icon: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle>{title}</CardTitle>
        <span className="text-muted-foreground">{icon}</span>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  )
}

export default function MetricsScreen() {
  const { metrics } = useLoaderData<typeof loader>()
  const sla = metrics.sla

  return (
    <div className="shadcn-scope bg-background font-sans text-foreground antialiased">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Fleet telemetry-evidence metrics · every number from the §6.12 report builder
            </p>
          </div>
          <nav className="flex gap-2 text-sm" aria-label="Sections">
            <Link className="rounded-md border border-border px-3 py-1.5 hover:bg-accent" to="/queue">
              Review queue
            </Link>
            <span className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground" aria-current="page">
              Metrics
            </span>
          </nav>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title="Open cases"
            value={String(metrics.stats.totalCases)}
            hint={`${metrics.openEpisodes} still unbounded by a recovery fix`}
            icon={<Gauge className="h-4 w-4" />}
          />
          <StatCard
            title="Urgent tier"
            value={String(metrics.stats.urgentTier)}
            hint={`${metrics.stats.directEvidence} with direct evidence`}
            icon={<ShieldAlert className="h-4 w-4" />}
          />
          <StatCard
            title="Overdue"
            value={String(metrics.stats.overdue)}
            hint="past due state plus grace window"
            icon={<Clock3 className="h-4 w-4" />}
          />
          <StatCard
            title="Unknown classifications"
            value={String(metrics.stats.unknownClassification)}
            hint="honest unknowns — evidence missing, not guessed"
            icon={<HelpCircle className="h-4 w-4" />}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-7">
          <Card className="lg:col-span-4">
            <CardHeader>
              <CardTitle className="text-base">Overview</CardTitle>
              <CardDescription>Gap duration per closed episode, minutes</CardDescription>
            </CardHeader>
            <CardContent className="pl-2">
              <GapChart data={metrics.gapChart} />
            </CardContent>
          </Card>

          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle className="text-base">Recent episodes</CardTitle>
              <CardDescription>
                Latest {metrics.recent.length} of {metrics.stats.totalCases} open cases
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {metrics.recent.map((entry) => (
                <div key={entry.episodeId} className="flex items-center gap-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary font-mono text-xs font-medium text-secondary-foreground">
                    {entry.assetRef.replace('ast-00', '')}
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link to={`/cases/${entry.episodeId}`} className="text-sm font-medium hover:underline">
                      {entry.assetRef}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {entry.episodeType.replaceAll('_', ' ')} · {entry.tier}
                    </p>
                  </div>
                  <Badge variant={BAND_VARIANT[entry.band ?? 'unknown'] ?? 'outline'}>
                    {entry.band ?? 'unknown'}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Telemetry SLA</CardTitle>
              <CardDescription>tracker + platform delivery</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-y-3 text-sm">
                <dt className="text-muted-foreground">delivery lag p50</dt>
                <dd className="text-right font-mono">{sla.telemetry.deliveryLagP50S?.toFixed(1) ?? '–'} s</dd>
                <dt className="text-muted-foreground">delivery lag p95</dt>
                <dd className="text-right font-mono">{sla.telemetry.deliveryLagP95S?.toFixed(1) ?? '–'} s</dd>
                <dt className="text-muted-foreground">episodes / 1000 asset-h</dt>
                <dd className="text-right font-mono">
                  {sla.telemetry.episodesPer1000AssetHours?.toFixed(1) ?? '–'}
                </dd>
                <dt className="text-muted-foreground">retractions</dt>
                <dd className="text-right font-mono">
                  {sla.telemetry.retractionRate.numerator}/{sla.telemetry.retractionRate.denominator}
                </dd>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Evidence bands</CardTitle>
              <CardDescription>strength across open cases</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {metrics.bands.map((band) => (
                <div key={band.band} className="flex items-center gap-3 text-sm">
                  <Badge variant={BAND_VARIANT[band.band] ?? 'outline'} className="w-28 justify-center">
                    {band.band}
                  </Badge>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${(band.count / metrics.stats.totalCases) * 100}%` }}
                    />
                  </div>
                  <span className="w-6 text-right font-mono text-muted-foreground">{band.count}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Report integrity</CardTitle>
              <CardDescription>what an export of this screen would sign</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <div className="flex items-center gap-2 text-muted-foreground">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>
                  {sla.recovery.unresolvedAging[0]?.count ?? 0} unresolved past due — aged separately,
                  never folded into done
                </span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <LinkIcon className="h-4 w-4 shrink-0" />
                <span className="min-w-0">
                  manifest sha256{' '}
                  <span className="font-mono text-xs break-all text-foreground">
                    {sla.manifest.integritySha256.slice(0, 24)}…
                  </span>
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                rule {sla.manifest.ruleVersion} · vocabulary {sla.manifest.factVocabularyVersion} ·
                clock basis {sla.manifest.clockBasis} · denominators travel with every rate
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

import * as Plot from '@observablehq/plot'
import { useEffect, useMemo, useState } from 'react'
import PlotFigure from '../components/PlotFigure.jsx'
import { Legend } from '../components/ui.jsx'
import { loadSetDetail, loadView } from '../lib/loadView.js'
import { fmtPct, fmtUsd, settledOf } from '../lib/slice.js'
import { useTheme } from '../lib/theme.js'

const toneVar = (v) => (v == null ? 'var(--text-muted)' : v > 0.005 ? 'var(--pos)' : v < -0.005 ? 'var(--neg)' : 'var(--text-secondary)')
const P = ({ v, d = 1 }) => <span className="tabular-nums" style={{ color: toneVar(v) }}>{v == null ? '—' : fmtPct(v, d)}</span>

function Sparkline({ points, palette }) {
  if (!points || points.length < 2) return <span className="muted">—</span>
  const values = points.map((p) => p[1])
  const min = Math.min(...values), max = Math.max(...values)
  const w = 90, h = 24
  const path = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w
      const y = max === min ? h / 2 : h - ((v - min) / (max - min)) * (h - 3) - 1.5
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join('')
  const up = values.at(-1) >= values[0]
  return (
    <svg width={w} height={h} aria-label="90-day price trend">
      <path d={path} fill="none" stroke={up ? palette.pos : palette.neg} strokeWidth="1.5" />
    </svg>
  )
}

function ConfBadge({ conf }) {
  if (!conf || conf === 'high') return null
  return (
    <span title={`${conf}-confidence pack value — pack count or promo not fully confirmed`}
      style={{ color: 'var(--warn)' }}> {conf === 'low' ? '**' : '*'}</span>
  )
}

// Peak -> settled -> now for this set, split into launch unwind / normal decay /
// market / set-specific (pipeline/launch.py), for sealed and its top cards.
const PARTS = [['unwind', 'Launch unwind'], ['decay', 'Normal decay'], ['market', 'Market'], ['specific', 'Set-specific']]
function LaunchCard({ row }) {
  if (!row) return null
  const kinds = [['sealed', 'Sealed: median of its box, ETBs and bundle'], ['single', 'Top cards: its 10 most valuable at launch']]
    .filter(([k]) => row[k])
  return (
    <div className="card p-3">
      <h3 className="font-semibold text-sm">Launch hype vs the market</h3>
      <p className="muted text-[11px]">How the fall from the launch peak splits up. Settled = median price over days 30–59, once hype has worn off.</p>
      <table className="tbl text-xs w-full tabular-nums mt-2">
        <thead>
          <tr><th></th>{kinds.map(([k, label]) => <th key={k} className="text-right" title={label}>{k === 'sealed' ? 'Sealed' : 'Top cards'}</th>)}</tr>
        </thead>
        <tbody>
          {PARTS.map(([p, l]) => (
            <tr key={p}><td>{l}</td>{kinds.map(([k]) => <td key={k} className="text-right"><P v={row[k][p]} d={0} /></td>)}</tr>
          ))}
          <tr style={{ borderTop: '2px solid var(--border-strong)' }}>
            <td className="font-semibold">Peak → now</td>
            {kinds.map(([k]) => <td key={k} className="text-right font-semibold"><P v={row[k].total} d={0} /></td>)}
          </tr>
        </tbody>
      </table>
      <p className="muted text-[11px] mt-1.5">The parts add up to the total. A negative set-specific part means this set did worse than a typical one would have.</p>
    </div>
  )
}

export default function SetDetail({ meta, groupId }) {
  const [detail, setDetail] = useState(null)
  const [eraBands, setEraBands] = useState(null)
  const [launchRow, setLaunchRow] = useState(null)
  const [error, setError] = useState(null)
  const [metric, setMetric] = useState(null)   // null = pick the best available
  const [showAll, setShowAll] = useState(false)
  const { palette, themeTick } = useTheme()

  useEffect(() => {
    setDetail(null); setError(null); setMetric(null); setShowAll(false)
    loadSetDetail(groupId).then(setDetail).catch((e) => setError(e.message))
  }, [groupId])

  // Shared per-era median bands (loaded once, cached across sets).
  useEffect(() => { loadView('era_bands').then((d) => setEraBands(d.bands)).catch(() => setEraBands({})) }, [])
  useEffect(() => {
    loadView('market').then((m) => {
      const all = Object.values(m.games || {}).flatMap((g) => g.launch?.sets || [])
      setLaunchRow(all.find((s) => String(s.groupId) === String(groupId)) || null)
    }).catch(() => setLaunchRow(null))
  }, [groupId])

  const curveModel = useMemo(() => {
    if (!detail) return null
    const primary = ['Booster Box', 'ETB', 'Chase Singles', 'Collector Booster Box', 'Play Booster Box']
    const curves = detail.curves.filter((c) => primary.includes(c.seriesType))
      .map((c) => ({ ...c, settled: settledOf(c.points) }))
    const eraBand = (eraBands && eraBands[detail.set?.era]) || []
    const band = eraBand.filter((b) => b.seriesType === 'Booster Box')
    return { curves, band, hasSettled: curves.some((c) => c.settled) }
  }, [detail, eraBands])

  const mode = metric || (curveModel?.hasSettled ? 'settled' : 'idx')
  const COLORS = { 'Booster Box': 0, ETB: 2, 'Chase Singles': 4, 'Collector Booster Box': 0, 'Play Booster Box': 2 }

  const build = (width) => {
    if (!curveModel) return null
    const at = mode === 'prem' ? () => (pt) => pt[2]
      : mode === 'settled' ? (c) => (pt) => (c.settled && pt[3] != null ? (pt[3] / c.settled) * 100 : null)
      : () => (pt) => pt[1]
    const flat = curveModel.curves.flatMap((c) =>
      c.points.map((pt) => ({ age: pt[0], value: at(c)(pt), type: c.seriesType })).filter((d) => d.value != null))
    // A just-released set has no trajectory yet -- don't draw a degenerate axis.
    if (new Set(flat.map((d) => d.age)).size < 2) return null
    const band = mode === 'prem'
      ? curveModel.band.filter((b) => b.premP50 != null).map((b) => ({ age: b.ageDays, lo: b.premP25, mid: b.premP50, hi: b.premP75 }))
      : mode === 'settled'
      ? curveModel.band.filter((b) => b.sP50 != null).map((b) => ({ age: b.ageDays, lo: b.sP25, mid: b.sP50, hi: b.sP75 }))
      : curveModel.band.map((b) => ({ age: b.ageDays, lo: b.p25, mid: b.p50, hi: b.p75 }))
    const maxAge = Math.max(...flat.map((d) => d.age))
    const bandIn = band.filter((b) => b.age <= maxAge * 1.15)
    return Plot.plot({
      width, height: width < 640 ? 280 : 360,
      style: { background: 'transparent', color: palette.textSecondary, fontSize: '12px' },
      x: { label: 'days since release →' },
      y: {
        label: mode === 'prem' ? 'premium over pack value' : mode === 'settled' ? 'index (settled price = 100)' : 'index (release = 100)',
        grid: true, tickFormat: mode === 'prem' ? (d) => `${(d * 100).toFixed(0)}%` : undefined,
      },
      marks: [
        Plot.areaY(bandIn, { x: 'age', y1: 'lo', y2: 'hi', fill: palette.band, fillOpacity: 0.5 }),
        Plot.line(bandIn, { x: 'age', y: 'mid', stroke: palette.textSecondary, strokeWidth: 1.2, strokeDasharray: '3,3' }),
        mode !== 'prem' ? Plot.ruleY([100], { stroke: palette.textSecondary, strokeOpacity: 0.5 }) : Plot.ruleY([0], { stroke: palette.textSecondary, strokeOpacity: 0.5 }),
        Plot.line(flat, { x: 'age', y: 'value', z: 'type', stroke: (d) => palette.series[COLORS[d.type] ?? 1], strokeWidth: 2 }),
        Plot.tip(flat, Plot.pointer({
          x: 'age', y: 'value',
          title: (d) => `${d.type}\nday ${d.age}\n${mode === 'prem' ? fmtPct(d.value) : d.value?.toFixed(1)}`,
        })),
      ],
    })
  }

  if (error) return <p className="p-4" style={{ color: 'var(--neg)' }}>No detail view for set {groupId} ({error})</p>
  if (!detail) return <p className="muted p-4">Loading set…</p>

  const s = detail.set
  const years = detail.ageDays != null ? (detail.ageDays / 365).toFixed(1) : null
  // single-unit products first; cases, displays and multipacks are context
  const units = detail.sealed.filter((r) => r.isCanonical)
  const others = detail.sealed.filter((r) => !r.isCanonical)
  const sealedRows = showAll ? [...units, ...others] : units
  const types = (curveModel?.curves || []).map((c) => c.seriesType)

  return (
    <section>
      <a href="#/sets" className="text-xs hover:underline" style={{ color: 'var(--accent)' }}>← All sets</a>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pt-1">
        <h2 className="text-xl font-semibold">{s.name}</h2>
        <span className="subtle">{s.abbreviation}</span>
        <span className="chip" data-on="false">{s.era}</span>
        {!s.archiveComplete && <span className="chip" data-on="false" title="released before the price archive began (Feb 2024)">partial history</span>}
        {s.isHype && <span className="chip" data-on="false">🔥 hype ({s.hypeSource})</span>}
      </div>
      <p className="subtle text-sm pt-1">
        Released {s.releaseDate}{years != null && <> · {detail.ageDays} days old ({years}y)</>}
      </p>

      <div className="grid lg:grid-cols-3 gap-3 pt-4">
        <div className="lg:col-span-2 min-w-0">
          <div className="flex flex-wrap items-center gap-2 pb-2">
            <h3 className="font-semibold text-sm mr-1">Price path vs the {s.era} median</h3>
            {[['settled', 'vs settled'], ['idx', 'vs release'], ['prem', 'Premium']]
              .filter(([v]) => v !== 'settled' || curveModel?.hasSettled)
              .map(([v, t]) => (
                <button key={v} className="chip" data-on={String(mode === v)} onClick={() => setMetric(v)}>{t}</button>
              ))}
          </div>
          <div className="card p-3">
            <Legend items={[...types.map((t) => [t, palette.series[COLORS[t] ?? 1]]), [`${s.era} median (box)`, palette.textSecondary, true]]} />
            {curveModel && new Set(curveModel.curves.flatMap((c) => c.points.map((p) => p[0]))).size < 2 ? (
              <p className="muted text-sm py-8 text-center">Not enough history yet — this set is too new to chart a trajectory.</p>
            ) : (
              <PlotFigure build={build} deps={[curveModel, mode, themeTick]} />
            )}
            <p className="muted text-[11px] pt-1">
              {mode === 'settled' ? '100 = the settled price (median of days 30–59), once launch hype has mostly worn off.'
                : mode === 'idx' ? '100 = the first price on or after release day — this includes the launch hype.'
                : 'Sealed price vs the value of the packs inside it. Shaded: the middle half of the era.'}
            </p>
          </div>
        </div>
        <div className="min-w-0">
          {launchRow ? <LaunchCard row={launchRow} /> : (
            <div className="card p-3 text-xs muted">
              Launch breakdown appears once a set has full launch history (released after Mar 2024) and is at least 75 days old.
            </div>
          )}
        </div>
      </div>

      <h3 className="font-semibold pt-6 pb-2">Sealed products</h3>
      <div className="card p-3 overflow-x-auto">
        <table className="tbl text-sm w-full">
          <thead>
            <tr><th>Product</th><th>Type</th><th className="text-right">Price</th>
                <th className="text-right" title="Value of the packs inside (+ promo)">Pack value</th>
                <th className="text-right" title="Price vs pack value">Premium</th>
                <th className="text-right" title="Median price over days 30–59 after release">Settled</th>
                <th className="text-right" title="Today vs settled price">vs settled</th>
                <th className="text-right">High</th><th className="text-right">Off high</th><th>90d</th></tr>
          </thead>
          <tbody>
            {sealedRows.map((r) => (
              <tr key={r.productId} style={!r.isCanonical || r.conf === 'low' ? { opacity: 0.6 } : undefined}>
                <td className="max-w-72 truncate" title={r.name}>
                  <a href={r.url} target="_blank" rel="noreferrer" className="hover:underline">{r.name}</a>
                  <ConfBadge conf={r.conf} />
                </td>
                <td className="muted">{r.productType}</td>
                <td className="text-right tabular-nums">{fmtUsd(r.price)}</td>
                <td className="text-right tabular-nums">{r.intrinsicValue != null
                  ? <span title={`${r.packCount} packs × ${fmtUsd(r.packPrice)} + promo ${fmtUsd(r.promoPrice)} (${r.promoSource})`}>
                      {fmtUsd(r.intrinsicValue)}
                    </span>
                  : <span className="muted">—</span>}</td>
                <td className="text-right"><P v={r.premiumPct} /></td>
                <td className="text-right tabular-nums muted">{r.settledPrice != null ? fmtUsd(r.settledPrice) : '—'}</td>
                <td className="text-right"><P v={r.pctVsSettled} /></td>
                <td className="text-right tabular-nums muted">{fmtUsd(r.athPrice)}</td>
                <td className="text-right"><P v={r.pctOffPeak} /></td>
                <td><Sparkline points={r.sparkline} palette={palette} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          {others.length > 0 && (
            <button className="chip" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Hide' : 'Show'} cases, displays &amp; multipacks ({others.length})
            </button>
          )}
          {detail.sealed.some((r) => r.conf && r.conf !== 'high') && (
            <p className="muted text-xs">* medium / ** low confidence pack value — pack count or promo not fully confirmed.</p>
          )}
        </div>
      </div>

      {detail.chase.length > 0 && <>
        <h3 className="font-semibold pt-6 pb-2">Top cards <span className="muted text-sm font-normal">(the 5 most valuable over the last 90 days)</span></h3>
        <div className="card p-3 overflow-x-auto">
          <table className="tbl text-sm w-full">
            <thead>
              <tr><th>Card</th><th>#</th><th>Rarity</th><th className="text-right">Price</th>
                  <th className="text-right" title="Median price over days 30–59 after release — after prerelease hype">Settled</th>
                  <th className="text-right" title="Today vs settled price">vs settled</th>
                  <th className="text-right">High</th><th className="text-right">Off high</th><th>90d</th></tr>
            </thead>
            <tbody>
              {detail.chase.map((r) => (
                <tr key={r.productId}>
                  <td className="max-w-72 truncate" title={r.name}>
                    <a href={r.url} target="_blank" rel="noreferrer" className="hover:underline">{r.name}</a>
                  </td>
                  <td className="muted">{r.cardNumber}</td>
                  <td className="muted max-w-40 truncate">{r.rarity}</td>
                  <td className="text-right tabular-nums">{fmtUsd(r.price)}</td>
                  <td className="text-right tabular-nums muted">{r.settledPrice != null ? fmtUsd(r.settledPrice) : '—'}</td>
                  <td className="text-right"><P v={r.pctVsSettled} /></td>
                  <td className="text-right tabular-nums muted" title={r.peakDate ? `on ${r.peakDate}` : undefined}>{fmtUsd(r.peakPrice)}</td>
                  <td className="text-right"><P v={r.pctOffPeak} /></td>
                  <td><Sparkline points={r.sparkline} palette={palette} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted text-[11px] pt-2">A single card's high is usually set at prerelease, when few copies exist — "vs settled" is the fairer comparison.</p>
        </div>
      </>}
    </section>
  )
}

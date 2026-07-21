import * as Plot from '@observablehq/plot'
import { useEffect, useMemo, useState } from 'react'
import PlotFigure from '../components/PlotFigure.jsx'
import { loadSetDetail, loadView } from '../lib/loadView.js'
import { fmtPct, fmtUsd } from '../lib/slice.js'
import { useTheme } from '../lib/theme.js'

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
    <span title={`${conf}-confidence intrinsic value — see data quality report`}
      style={{ color: 'var(--warn)' }}> {conf === 'low' ? '**' : '*'}</span>
  )
}

export default function SetDetail({ meta, groupId }) {
  const [detail, setDetail] = useState(null)
  const [eraBands, setEraBands] = useState(null)
  const [error, setError] = useState(null)
  const [metric, setMetric] = useState('idx')
  const { palette, themeTick } = useTheme()

  useEffect(() => {
    setDetail(null); setError(null)
    loadSetDetail(groupId).then(setDetail).catch((e) => setError(e.message))
  }, [groupId])

  // Shared per-era median bands (loaded once, cached across sets).
  useEffect(() => { loadView('era_bands').then((d) => setEraBands(d.bands)).catch(() => setEraBands({})) }, [])

  const curveModel = useMemo(() => {
    if (!detail) return null
    const primary = ['Booster Box', 'ETB', 'Chase Singles']
    const curves = detail.curves.filter((c) => primary.includes(c.seriesType))
    const eraBand = (eraBands && eraBands[detail.set?.era]) || []
    const band = eraBand.filter((b) => b.seriesType === 'Booster Box')
    return { curves, band }
  }, [detail, eraBands])

  const build = (width) => {
    if (!curveModel) return null
    const isPrem = metric === 'prem'
    const at = isPrem ? (pt) => pt[2] : (pt) => pt[1]
    const flat = curveModel.curves.flatMap((c) =>
      c.points.filter((pt) => at(pt) != null).map((pt) => ({ age: pt[0], value: at(pt), type: c.seriesType })),
    )
    // A just-released set has no trajectory yet -- don't draw a degenerate axis.
    if (new Set(flat.map((d) => d.age)).size < 2) return null
    const colors = { 'Booster Box': palette.series[0], ETB: palette.series[2], 'Chase Singles': palette.series[4] }
    const band = isPrem
      ? curveModel.band.filter((b) => b.premP50 != null).map((b) => ({ age: b.ageDays, lo: b.premP25, mid: b.premP50, hi: b.premP75 }))
      : curveModel.band.map((b) => ({ age: b.ageDays, lo: b.p25, mid: b.p50, hi: b.p75 }))
    return Plot.plot({
      width, height: 380,
      style: { background: 'transparent', color: palette.textSecondary, fontSize: '12px' },
      x: { label: 'days since release' },
      y: {
        label: isPrem ? 'sealed premium' : 'indexed (release = 100)',
        grid: true, tickFormat: isPrem ? (d) => `${(d * 100).toFixed(0)}%` : undefined,
      },
      marks: [
        Plot.areaY(band, { x: 'age', y1: 'lo', y2: 'hi', fill: palette.band, fillOpacity: 0.5 }),
        Plot.line(band, { x: 'age', y: 'mid', stroke: palette.textSecondary, strokeWidth: 1.2, strokeDasharray: '3,3' }),
        Plot.line(flat, { x: 'age', y: 'value', z: 'type', stroke: (d) => colors[d.type], strokeWidth: 2 }),
        Plot.tip(flat, Plot.pointer({
          x: 'age', y: 'value',
          title: (d) => `${d.type}\nday ${d.age}\n${isPrem ? fmtPct(d.value) : d.value?.toFixed(1)}`,
        })),
      ],
    })
  }

  if (error) return <p className="p-4" style={{ color: 'var(--neg)' }}>No detail view for set {groupId} ({error})</p>
  if (!detail) return <p className="muted p-4">Loading set…</p>

  const s = detail.set
  const years = detail.ageDays != null ? (detail.ageDays / 365).toFixed(1) : null
  return (
    <section>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-xl font-semibold">{s.name}</h2>
        <span className="subtle">{s.abbreviation}</span>
        <span className="chip" data-on="false">{s.era}</span>
        <span className="chip" data-on="false">
          {s.archiveComplete ? 'complete history' : 'partial (pre-archive) history'}
        </span>
        {s.isHype && <span className="chip" data-on="false">🔥 hype ({s.hypeSource})</span>}
      </div>
      <p className="subtle text-sm pt-1">
        Released {s.releaseDate}{years != null && <> · {detail.ageDays} days old ({years}y)</>}
      </p>

      <h3 className="font-semibold pt-5 pb-1">Cohort curve vs {s.era} median band</h3>
      <div className="flex items-center gap-2 pb-2">
        {[['idx', 'Indexed price'], ['prem', 'Sealed premium %']].map(([v, t]) => (
          <button key={v} className="chip" data-on={String(metric === v)} onClick={() => setMetric(v)}>{t}</button>
        ))}
        <span className="muted text-xs">
          <span style={{ color: palette.series[0] }}>■</span> Booster Box&nbsp;
          <span style={{ color: palette.series[2] }}>■</span> ETB&nbsp;
          <span style={{ color: palette.series[4] }}>■</span> Chase singles&nbsp;
          <span style={{ color: palette.band }}>■</span> era p25–p75 (Booster Box)
        </span>
      </div>
      <div className="card p-3">
        {curveModel && new Set(curveModel.curves.flatMap((c) => c.points.map((p) => p[0]))).size < 2 ? (
          <p className="muted text-sm py-8 text-center">Not enough history yet — this set is too new to chart a trajectory.</p>
        ) : (
          <PlotFigure build={build} deps={[curveModel, metric, themeTick]} />
        )}
      </div>

      <h3 className="font-semibold pt-6 pb-2">Sealed products</h3>
      <div className="card p-3 overflow-x-auto">
        <table className="tbl text-sm w-full">
          <thead>
            <tr><th>Product</th><th>Type</th><th>Price</th><th>Intrinsic</th><th>Premium</th>
                <th>ATH</th><th>ATL</th><th>Off peak</th><th>90d</th></tr>
          </thead>
          <tbody>
            {detail.sealed.map((r) => (
              <tr key={r.productId} style={r.conf === 'low' ? { opacity: 0.55 } : undefined}>
                <td className="max-w-72 truncate" title={r.name}>
                  <a href={r.url} target="_blank" rel="noreferrer" className="hover:underline">{r.name}</a>
                  <ConfBadge conf={r.conf} />
                </td>
                <td className="muted">{r.productType}</td>
                <td>{fmtUsd(r.price)}</td>
                <td>{r.intrinsicValue != null
                  ? <span title={`${r.packCount} packs × ${fmtUsd(r.packPrice)} + promo ${fmtUsd(r.promoPrice)} (${r.promoSource})`}>
                      {fmtUsd(r.intrinsicValue)}
                    </span>
                  : <span className="muted">—</span>}</td>
                <td>{r.premiumPct != null ? fmtPct(r.premiumPct) : <span className="muted">—</span>}</td>
                <td className="muted">{fmtUsd(r.athPrice)}</td>
                <td className="muted">{fmtUsd(r.atlPrice)}</td>
                <td>{r.pctOffPeak != null
                  ? <span style={{ color: r.pctOffPeak < -0.001 ? 'var(--neg)' : 'var(--pos)' }}>{fmtPct(r.pctOffPeak)}</span>
                  : '—'}</td>
                <td><Sparkline points={r.sparkline} palette={palette} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {detail.sealed.some((r) => r.conf && r.conf !== 'high') && (
          <p className="muted text-xs pt-2">
            * medium / ** low confidence intrinsic value — pack count or promo not fully
            confirmed; see data/data_quality_report.json and the config override files.
          </p>
        )}
      </div>

      <h3 className="font-semibold pt-6 pb-2">Chase singles (top 5 by peak price)</h3>
      <div className="card p-3 overflow-x-auto">
        <table className="tbl text-sm w-full">
          <thead>
            <tr><th>Card</th><th>#</th><th>Rarity</th><th>Current</th><th>Peak</th>
                <th>Peak date</th><th>Launch</th><th>Off peak</th><th>90d</th></tr>
          </thead>
          <tbody>
            {detail.chase.map((r) => (
              <tr key={r.productId}>
                <td className="max-w-72 truncate" title={r.name}>
                  <a href={r.url} target="_blank" rel="noreferrer" className="hover:underline">{r.name}</a>
                </td>
                <td className="muted">{r.cardNumber}</td>
                <td className="muted max-w-40 truncate">{r.rarity}</td>
                <td>{fmtUsd(r.price)}</td>
                <td>{fmtUsd(r.peakPrice)}</td>
                <td className="muted">{r.peakDate ?? '—'}</td>
                <td className="muted">{fmtUsd(r.launchPrice)}</td>
                <td>{r.pctOffPeak != null
                  ? <span style={{ color: r.pctOffPeak < -0.001 ? 'var(--neg)' : 'var(--pos)' }}>{fmtPct(r.pctOffPeak)}</span>
                  : '—'}</td>
                <td><Sparkline points={r.sparkline} palette={palette} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

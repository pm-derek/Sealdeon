import * as Plot from '@observablehq/plot'
import { useEffect, useMemo, useState } from 'react'
import FilterBar from '../components/FilterBar.jsx'
import PlotFigure from '../components/PlotFigure.jsx'
import { loadView } from '../lib/loadView.js'
import { fmtPct, fmtUsd, eraMatch } from '../lib/slice.js'
import { useTheme } from '../lib/theme.js'
import PageHeader from '../components/PageHeader.jsx'

const MODERN = ['Mega Evolution', 'Scarlet & Violet', 'Sword & Shield']

export default function PremiumVsMedian({ meta, game = 'Pokemon' }) {
  const [data, setData] = useState(null)
  // modern eras by default: vintage spans 10,000+ days and squeezes the rest
  const [state, setState] = useState({ eras: game === 'Pokemon' ? MODERN : [], seriesType: 'All', hype: 'all' })
  const [end, setEnd] = useState('rich')   // which end of the ranking the table shows
  const [showImages, setShowImages] = useState(true)
  const { palette, themeTick } = useTheme()

  useEffect(() => { loadView('premium_vs_median').then(setData) }, [])

  // groupIds of the active game (meta is already game-scoped by App)
  const gameIds = useMemo(() => new Set(meta.sets.map((s) => s.groupId)), [meta])

  const rows = useMemo(() => {
    if (!data) return []
    return data.rows.filter((r) => {
      if (!gameIds.has(r.groupId)) return false
      if (!eraMatch(r.era, state.eras)) return false
      if (state.seriesType !== 'All' && r.productType !== state.seriesType) return false
      if (state.hype === 'hype' && !r.isHype) return false
      if (state.hype === 'clean' && r.isHype) return false
      return r.premiumPct != null
    })
  }, [data, state, gameIds])

  const build = (width) => {
    // Exclude unreliable points from the scatter: low-confidence intrinsic
    // (broken pack decomposition -> absurd premiums) and any |deviation|
    // over 300%, which is almost always an intrinsic error, not a real
    // market premium. They'd otherwise blow out the y-axis.
    const pts = rows
      .filter((r) => r.deviation != null && r.conf !== 'low' && Math.abs(r.deviation) <= 3)
      // draw most-expensive (largest) first so smaller markers land on top
      // and don't get buried under the big booster-box images.
      .sort((a, b) => (b.price || 0) - (a.price || 0))
    if (!pts.length) return null
    // Size (image height / bubble radius) scales with the product's $ value:
    // area ∝ price, so bigger = more expensive.
    const maxP = Math.max(...pts.map((d) => d.price || 0), 1)
    const imgH = (d) => 26 + 74 * Math.sqrt((d.price || 0) / maxP)
    const dotR = (d) => 7 + 28 * Math.sqrt((d.price || 0) / maxP)
    const title = (d) =>
      `${d.name}\n${d.setName} · ${d.productType} · ${fmtUsd(d.price)}\n` +
      `premium ${fmtPct(d.premiumPct)} vs usual ${fmtPct(d.cleanMedianPremium)}\n` +
      `gap ${fmtPct(d.deviation)}${d.conf === 'low' ? '\n⚠ low-confidence intrinsic' : ''}`
    return Plot.plot({
      width, height: width < 640 ? 380 : 460,
      style: { background: 'transparent', color: palette.textSecondary, fontSize: '12px' },
      x: { label: 'age (days since release)', grid: false },
      y: { label: 'premium gap vs usual', grid: true, tickFormat: (d) => `${(d * 100).toFixed(0)}%` },
      marks: [
        Plot.ruleY([0], { stroke: palette.textSecondary, strokeWidth: 1.5, strokeOpacity: 0.7 }),
        showImages
          ? Plot.image(pts, {
              x: 'ageDays', y: 'deviation', src: 'imageUrl',
              width: (d) => imgH(d) * 0.72, height: imgH, r: (d) => imgH(d), // r clips to rounded
              preserveAspectRatio: 'xMidYMid slice', imageRendering: 'auto',
              opacity: (d) => (d.conf === 'low' ? 0.5 : 1),
              title,
            })
          : Plot.dot(pts, {
              x: 'ageDays', y: 'deviation', r: dotR,
              fill: (d) => (d.conf === 'low' ? palette.context : d.isHype ? palette.series[1] : palette.series[0]),
              fillOpacity: (d) => (d.conf === 'low' ? 0.4 : 0.72),
              stroke: palette.surface, strokeWidth: 1, title,
            }),
        Plot.tip(pts, Plot.pointer({ x: 'ageDays', y: 'deviation', title })),
      ],
    })
  }

  if (!data) return <p className="muted p-4">Loading premium vs median…</p>
  const ranked = rows.filter((r) => r.deviation != null)
    .sort((a, b) => (end === 'rich' ? b.deviation - a.deviation : a.deviation - b.deviation))
  const metaForFilter = { ...meta, seriesTypes: ['All', ...(meta.seriesTypes || []).filter((t) => t !== 'Chase Singles')] }
  return (
    <section>
      <PageHeader title="Premium vs usual"
        question="Is this product priced above or below the premium its type normally carries at this age?">
        <p><b>Premium</b> = sealed price ÷ value of the packs inside − 1. <b>Usual</b> = the median premium for the same product
          type and age band across non-hype sets, over all history. <b>Gap</b> = premium − usual: above zero is pricier than
          normal, below is cheaper.</p>
        <p>Only single-unit products are scored — a case or display carries one box&apos;s pack count, so its “premium” is
          meaningless. Marker size = product price. The chart hides low-confidence pack values and gaps beyond ±300%
          (almost always a pack-count error); they stay in the table, dimmed.</p>
      </PageHeader>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 py-1">
        <FilterBar meta={metaForFilter} state={state} setState={setState} show={{ completeness: false }} />
        <div className="seg">
          <span className="seg-label">Markers</span>
          <button className="chip" data-on={String(showImages)} onClick={() => setShowImages(true)}>Card images</button>
          <button className="chip" data-on={String(!showImages)} onClick={() => setShowImages(false)}>Bubbles</button>
        </div>
      </div>
      <div className="card p-3">
        <PlotFigure build={build} deps={[rows, showImages, themeTick]} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 pt-4 pb-2">
        <h3 className="font-semibold text-sm">{end === 'rich' ? 'Priced furthest above usual' : 'Priced furthest below usual'}</h3>
        <div className="seg">
          <button className="chip" data-on={String(end === 'rich')} onClick={() => setEnd('rich')}>Above usual</button>
          <button className="chip" data-on={String(end === 'cheap')} onClick={() => setEnd('cheap')}>Below usual</button>
        </div>
      </div>
      <div className="card p-3 overflow-x-auto">
        <table className="tbl text-sm w-full">
          <thead>
            <tr><th>Product</th><th>Set</th><th>Type</th><th>Age</th><th className="text-right">Price</th>
                <th className="text-right">Pack value</th><th className="text-right">Premium</th>
                <th className="text-right">Usual</th><th className="text-right">Gap</th></tr>
          </thead>
          <tbody>
            {ranked.slice(0, 40).map((r) => (
              <tr key={r.productId} style={r.conf === 'low' ? { opacity: 0.55 } : undefined}>
                <td className="max-w-64 truncate" title={r.name}>
                  <a href={`#/set/${r.groupId}`} className="hover:underline">{r.name}</a>
                  {r.conf === 'low' && <span style={{ color: 'var(--warn)' }} title="low-confidence intrinsic value"> *</span>}
                </td>
                <td className="muted max-w-40 truncate">{r.setName}{r.isHype ? ' 🔥' : ''}</td>
                <td className="muted">{r.productType}</td>
                <td className="muted">{r.ageBand}</td>
                <td className="text-right tabular-nums">{fmtUsd(r.price)}</td>
                <td className="text-right tabular-nums">{fmtUsd(r.intrinsicValue)}</td>
                <td className="text-right tabular-nums">{fmtPct(r.premiumPct)}</td>
                <td className="text-right tabular-nums muted">{fmtPct(r.cleanMedianPremium)}</td>
                <td className="text-right tabular-nums">{r.deviation != null
                  ? <span style={{ color: r.deviation > 0 ? 'var(--neg)' : 'var(--pos)' }}>{fmtPct(r.deviation)}</span>
                  : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

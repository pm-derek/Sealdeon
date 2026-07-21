import * as Plot from '@observablehq/plot'
import { useEffect, useMemo, useState } from 'react'
import FilterBar from '../components/FilterBar.jsx'
import PlotFigure from '../components/PlotFigure.jsx'
import { loadView } from '../lib/loadView.js'
import { fmtPct, fmtUsd, eraMatch } from '../lib/slice.js'
import { useTheme } from '../lib/theme.js'

export default function PremiumVsMedian({ meta }) {
  const [data, setData] = useState(null)
  const [state, setState] = useState({ eras: [], seriesType: 'All', hype: 'all' })
  const [showImages, setShowImages] = useState(true)
  const { palette, themeTick } = useTheme()

  useEffect(() => { loadView('premium_vs_median').then(setData) }, [])

  const rows = useMemo(() => {
    if (!data) return []
    return data.rows.filter((r) => {
      if (!eraMatch(r.era, state.eras)) return false
      if (state.seriesType !== 'All' && r.productType !== state.seriesType) return false
      if (state.hype === 'hype' && !r.isHype) return false
      if (state.hype === 'clean' && r.isHype) return false
      return r.premiumPct != null
    })
  }, [data, state])

  const build = (width) => {
    // Exclude unreliable points from the scatter: low-confidence intrinsic
    // (broken pack decomposition -> absurd premiums) and any |deviation|
    // over 300%, which is almost always an intrinsic error, not a real
    // market premium. They'd otherwise blow out the y-axis.
    const pts = rows.filter((r) => r.deviation != null && r.conf !== 'low' && Math.abs(r.deviation) <= 3)
    if (!pts.length) return null
    // Size (image height / bubble radius) scales with the product's $ value:
    // area ∝ price, so bigger = more expensive.
    const maxP = Math.max(...pts.map((d) => d.price || 0), 1)
    const imgH = (d) => 14 + 46 * Math.sqrt((d.price || 0) / maxP)
    const dotR = (d) => 3 + 16 * Math.sqrt((d.price || 0) / maxP)
    const title = (d) =>
      `${d.name}\n${d.setName} · ${d.productType} · ${fmtUsd(d.price)}\n` +
      `premium ${fmtPct(d.premiumPct)} vs clean median ${fmtPct(d.cleanMedianPremium)}\n` +
      `deviation ${fmtPct(d.deviation)}${d.conf === 'low' ? '\n⚠ low-confidence intrinsic' : ''}`
    return Plot.plot({
      width, height: 460,
      style: { background: 'transparent', color: palette.textSecondary, fontSize: '12px' },
      x: { label: 'age (days since release)', grid: false },
      y: { label: 'premium deviation vs clean median', grid: true, tickFormat: (d) => `${(d * 100).toFixed(0)}%` },
      marks: [
        Plot.ruleY([0], { stroke: palette.grid }),
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
  const metaForFilter = { ...meta, seriesTypes: ['All', 'Booster Box', 'ETB', 'PKC ETB', 'Booster Bundle', 'UPC'] }
  return (
    <section>
      <h2 className="text-lg font-semibold">Premium vs clean median</h2>
      <p className="subtle text-sm">
        Each sealed product's current premium against the historical clean-median premium
        for its product type + age band. Above zero = pricier than the honest baseline.
        Marker <strong>size = product $ value</strong> (bigger = more expensive). The scatter hides
        low-confidence intrinsic values and &gt;300% deviations (usually pack-count errors); they remain
        in the table below, dimmed.
      </p>
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
      <div className="card p-3 mt-4 overflow-x-auto">
        <table className="tbl text-sm w-full">
          <thead>
            <tr><th>Product</th><th>Set</th><th>Type</th><th>Age band</th><th>Price</th>
                <th>Intrinsic</th><th>Premium</th><th>Clean median</th><th>Deviation</th></tr>
          </thead>
          <tbody>
            {rows.slice(0, 80).map((r) => (
              <tr key={r.productId} style={r.conf === 'low' ? { opacity: 0.55 } : undefined}>
                <td className="max-w-64 truncate" title={r.name}>
                  <a href={`#/set/${r.groupId}`} className="hover:underline">{r.name}</a>
                  {r.conf === 'low' && <span style={{ color: 'var(--warn)' }} title="low-confidence intrinsic value"> *</span>}
                </td>
                <td className="muted max-w-40 truncate">{r.setName}{r.isHype ? ' 🔥' : ''}</td>
                <td className="muted">{r.productType}</td>
                <td className="muted">{r.ageBand}</td>
                <td>{fmtUsd(r.price)}</td>
                <td>{fmtUsd(r.intrinsicValue)}</td>
                <td>{fmtPct(r.premiumPct)}</td>
                <td>{fmtPct(r.cleanMedianPremium)}</td>
                <td>{r.deviation != null
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

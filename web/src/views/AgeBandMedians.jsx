import * as Plot from '@observablehq/plot'
import { useEffect, useMemo, useState } from 'react'
import FilterBar from '../components/FilterBar.jsx'
import PlotFigure from '../components/PlotFigure.jsx'
import { loadView } from '../lib/loadView.js'
import { fmtPct, fmtUsd } from '../lib/slice.js'
import { useTheme } from '../lib/theme.js'

const BAND_ORDER = ['0-1mo', '1-3mo', '3-6mo', '6-12mo', '12mo+']

export default function AgeBandMedians({ meta }) {
  const [data, setData] = useState(null)
  const [state, setState] = useState({
    era: 'All', seriesType: 'Booster Box', hype: 'all', metric: 'price',
  })
  const { palette, themeTick } = useTheme()

  useEffect(() => { loadView('age_band_medians').then(setData) }, [])

  const rows = useMemo(() => {
    if (!data) return []
    return data.rows
      .filter((r) => r.era === state.era && r.seriesType === state.seriesType)
      .sort((a, b) => BAND_ORDER.indexOf(a.ageBand) - BAND_ORDER.indexOf(b.ageBand))
  }, [data, state])

  const buckets = state.hype === 'all' ? ['clean', 'hype'] : [state.hype]
  const bucketColor = { clean: palette.series[0], hype: palette.series[1], all: palette.series[0] }
  const isPrice = state.metric === 'price'

  const build = (width) => {
    const plotRows = rows
      .filter((r) => buckets.includes(r.hypeBucket))
      .map((r) => ({
        ...r,
        value: isPrice ? r.medianPrice : r.medianPremiumPct,
        bucket: r.hypeBucket,
      }))
      .filter((r) => r.value != null)
    if (!plotRows.length) return null
    return Plot.plot({
      width, height: 360,
      style: { background: 'transparent', color: palette.textSecondary, fontSize: '12px' },
      x: { domain: BAND_ORDER, label: 'age band' },
      y: {
        grid: true,
        label: isPrice ? 'median price' : 'median sealed premium',
        tickFormat: isPrice ? (d) => `$${d}` : (d) => `${(d * 100).toFixed(0)}%`,
      },
      fx: buckets.length > 1 ? { label: null } : undefined,
      marks: [
        Plot.barY(plotRows, {
          x: 'ageBand', y: 'value',
          ...(buckets.length > 1 ? { fx: 'bucket' } : {}),
          fill: (d) => bucketColor[d.bucket], rx: 4,
          insetLeft: 1, insetRight: 1,
        }),
        Plot.tip(plotRows, Plot.pointer({
          x: 'ageBand', y: 'value', ...(buckets.length > 1 ? { fx: 'bucket' } : {}),
          title: (d) =>
            `${d.bucket} · ${d.ageBand}\n` +
            (isPrice ? `median ${fmtUsd(d.medianPrice)} (p25 ${fmtUsd(d.p25Price)} / p75 ${fmtUsd(d.p75Price)})`
                     : `median premium ${fmtPct(d.medianPremiumPct)}`) +
            `\n${d.nSets} sets, ${d.n} obs`,
        })),
        Plot.ruleY([0], { stroke: palette.grid }),
      ],
    })
  }

  if (!data) return <p className="muted p-4">Loading age-band medians…</p>
  return (
    <section>
      <h2 className="text-lg font-semibold">Age-band median benchmarks</h2>
      <p className="subtle text-sm">
        Median price / sealed premium by age band. <strong>Clean median</strong> (hype sets
        excluded) is the honest baseline; the hype split enables hype-vs-hype and
        clean-vs-clean directly. Low-confidence premium rows are excluded from premium medians.
      </p>
      <FilterBar meta={meta} state={state} setState={setState}
        show={{ completeness: false }} />
      <div className="flex items-center gap-2 pb-2">
        <span className="muted text-xs uppercase tracking-wide">Metric</span>
        {[['price', 'Median price'], ['prem', 'Median premium %']].map(([v, t]) => (
          <button key={v} className="chip" data-on={String(state.metric === v)}
            onClick={() => setState((s) => ({ ...s, metric: v }))}>{t}</button>
        ))}
      </div>
      <div className="card p-3">
        {buckets.length > 1 && (
          <div className="flex gap-4 text-xs pb-1">
            <span><span style={{ color: bucketColor.clean }}>■</span> clean</span>
            <span><span style={{ color: bucketColor.hype }}>■</span> hype</span>
          </div>
        )}
        <PlotFigure build={build} deps={[rows, state, themeTick]} />
      </div>
      <div className="card p-3 mt-4 overflow-x-auto">
        <table className="tbl text-sm w-full">
          <thead>
            <tr><th>Bucket</th><th>Age band</th><th>Median price</th><th>p25–p75</th>
                <th>Median premium</th><th>Sets</th><th>Obs</th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{r.hypeBucket}</td><td>{r.ageBand}</td>
                <td>{fmtUsd(r.medianPrice)}</td>
                <td className="muted">{fmtUsd(r.p25Price)} – {fmtUsd(r.p75Price)}</td>
                <td>{fmtPct(r.medianPremiumPct)}</td>
                <td>{r.nSets}</td><td>{r.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

import * as Plot from '@observablehq/plot'
import { useEffect, useMemo, useState } from 'react'
import FilterBar from '../components/FilterBar.jsx'
import SetPicker from '../components/SetPicker.jsx'
import PlotFigure from '../components/PlotFigure.jsx'
import { loadView, loadSetDetail } from '../lib/loadView.js'
import { cohortBand, filterSeries, fmtPct, fmtUsd, MSRP } from '../lib/slice.js'
import { useTheme } from '../lib/theme.js'

const X_DIV = { days: 1, weeks: 7, months: 30.44 }
const MAX_COLORED = 8

// metric -> how to read a value from a [ageDays, idx, prem, price] point
const METRICS = {
  raw: { label: 'Raw $', axis: 'market price', baseline: null, isPct: false, isUsd: true },
  idx: { label: 'Index (release)', axis: 'indexed · release day = 100', baseline: 100, isPct: false },
  msrp: { label: 'Index (MSRP)', axis: 'indexed · MSRP = 100', baseline: 100, isPct: false },
  prem: { label: 'Premium %', axis: 'sealed premium', baseline: 0, isPct: true },
}

function priceAtDate(sparkline, targetIso) {
  if (!sparkline || !sparkline.length) return null
  let best = sparkline[0], bestGap = Infinity
  for (const pt of sparkline) {
    const gap = Math.abs(new Date(pt[0]) - new Date(targetIso))
    if (gap < bestGap) { bestGap = gap; best = pt }
  }
  return best[1]
}

export default function CohortCurves({ meta }) {
  const [curves, setCurves] = useState(null)
  const [state, setState] = useState({
    eras: [], seriesType: 'Booster Box', hype: 'all',
    completeness: 'complete', metric: 'idx', xUnit: 'days',
  })
  const [picked, setPicked] = useState(new Set())
  const [focus, setFocus] = useState(null)
  const [maxAge, setMaxAge] = useState(365)
  const [labels, setLabels] = useState('focus')
  const [focusChase, setFocusChase] = useState(null)
  const [zoom, setZoom] = useState(null) // {x:[a,b], y:[a,b]} in data coords
  const { palette, themeTick } = useTheme()

  useEffect(() => { loadView('cohort_curves').then(setCurves) }, [])
  useEffect(() => {
    if (focus == null || state.seriesType !== 'Chase Singles') { setFocusChase(null); return }
    let live = true
    loadSetDetail(focus).then((d) => { if (live) setFocusChase(d) }).catch(() => setFocusChase(null))
    return () => { live = false }
  }, [focus, state.seriesType])
  // Reset any zoom when the underlying data selection changes.
  useEffect(() => { setZoom(null) }, [state.metric, state.seriesType, state.xUnit, maxAge])

  const bySet = useMemo(() => new Map(meta.sets.map((s) => [s.groupId, s])), [meta])
  const metricDef = METRICS[state.metric]
  const msrpUnavailable = state.metric === 'msrp' && !MSRP[state.seriesType]

  const valueAt = useMemo(() => {
    switch (state.metric) {
      case 'raw': return (pt) => pt[3]
      case 'prem': return (pt) => pt[2]
      case 'msrp': {
        const m = MSRP[state.seriesType]
        return m ? (pt) => (pt[3] != null ? (100 * pt[3]) / m : null) : () => null
      }
      default: return (pt) => pt[1]
    }
  }, [state.metric, state.seriesType])

  const model = useMemo(() => {
    if (!curves) return null
    const opts = { ...state, picked: picked.size ? picked : null }
    const series = filterSeries(curves, meta, opts)
    const band = cohortBand(series, valueAt, maxAge)
    const lines = series.map((s) => {
      const set = bySet.get(s.groupId)
      return {
        groupId: s.groupId,
        name: set?.name ?? String(s.groupId),
        abbr: set?.abbreviation ?? String(s.groupId),
        partial: !set?.archiveComplete,
        lowConfidence: s.lowConfidence && state.metric === 'prem',
        points: s.points
          .filter((pt) => pt[0] <= maxAge && valueAt(pt) != null)
          .map((pt) => ({ age: pt[0], value: valueAt(pt), price: pt[3] })),
      }
    }).filter((l) => l.points.length > 1)
    const colored = new Map()
    const coloredIds = picked.size ? [...picked].slice(0, MAX_COLORED) : focus != null ? [focus] : []
    coloredIds.forEach((gid, i) => colored.set(gid, palette.series[i % palette.series.length]))
    return { lines, band, colored }
  }, [curves, meta, state, picked, focus, maxAge, valueAt, themeTick])

  const chaseTitle = (gid, ageDays) => {
    if (!focusChase || gid !== focus || state.seriesType !== 'Chase Singles') return null
    const set = bySet.get(gid)
    if (!set?.releaseDate) return null
    const date = new Date(new Date(set.releaseDate).getTime() + ageDays * 86400000).toISOString().slice(0, 10)
    const rows = (focusChase.chase || []).map((c) => {
      const p = priceAtDate(c.sparkline, date) ?? c.price
      return `  ${(c.name.replace(set.name, '').trim()) || c.name} — ${fmtUsd(p)}`
    })
    return rows.length ? `\nChase cards @ ${date}:\n${rows.join('\n')}` : null
  }

  const build = (width) => {
    if (!model || msrpUnavailable) return null
    const div = X_DIV[state.xUnit]
    const flat = model.lines.flatMap((l) =>
      l.points.map((p) => ({
        x: p.age / div, ageDays: p.age, value: p.value, name: l.name, abbr: l.abbr,
        groupId: l.groupId, partial: l.partial, price: p.price,
      })),
    )
    const context = flat.filter((d) => !model.colored.has(d.groupId))
    const highlighted = flat.filter((d) => model.colored.has(d.groupId))
    const lastPoints = (rows) => rows.filter((d, i, arr) => d === arr.filter((x) => x.groupId === d.groupId).at(-1))

    const title = (d) => {
      const head = `${d.name}${d.partial ? ' (partial)' : ''}\nage ${Math.round(d.x)} ${state.xUnit}`
      let line
      if (metricDef.isPct) line = `premium ${fmtPct(d.value)}`
      else if (metricDef.isUsd) line = fmtUsd(d.value)
      else line = `${d.value?.toFixed(1)}  ·  ${fmtUsd(d.price)}`
      return head + '\n' + line + (chaseTitle(d.groupId, d.ageDays) || '')
    }

    const labelMarks = []
    if (labels === 'all') {
      labelMarks.push(Plot.text(lastPoints(flat), {
        x: 'x', y: 'value', text: 'abbr', dx: 5, textAnchor: 'start', fontSize: 9,
        fill: (d) => model.colored.get(d.groupId) || palette.textSecondary,
      }))
    } else if (labels === 'focus') {
      labelMarks.push(Plot.text(lastPoints(highlighted), {
        x: 'x', y: 'value', text: 'name', dx: 6, textAnchor: 'start', fontSize: 11, fill: palette.text,
      }))
    }

    const xDomain = zoom ? zoom.x : undefined
    const yDomain = zoom ? zoom.y : undefined
    const tickFmt = metricDef.isPct ? (d) => `${(d * 100).toFixed(0)}%`
      : metricDef.isUsd ? (d) => `$${d}` : undefined

    return Plot.plot({
      width, height: 470,
      marginRight: labels === 'all' ? 62 : labels === 'focus' ? 158 : 24,
      marginLeft: 52,
      style: { background: 'transparent', color: palette.textSecondary, fontSize: '12px' },
      x: { label: `${state.xUnit} since release →`, grid: false, domain: xDomain },
      y: { label: `↑ ${metricDef.axis}`, grid: true, tickFormat: tickFmt, domain: yDomain },
      marks: [
        Plot.areaY(model.band, { x: (d) => d.age / div, y1: 'p25', y2: 'p75', fill: palette.band, fillOpacity: 0.5 }),
        Plot.line(model.band, { x: (d) => d.age / div, y: 'p50', stroke: palette.textSecondary, strokeWidth: 1.5, strokeDasharray: '3,3' }),
        Plot.line(context, {
          x: 'x', y: 'value', z: 'groupId', stroke: palette.context, strokeWidth: 1, strokeOpacity: 0.75,
          strokeDasharray: (d) => (d.partial ? '2,3' : null),
        }),
        Plot.line(highlighted, {
          x: 'x', y: 'value', z: 'groupId', stroke: (d) => model.colored.get(d.groupId), strokeWidth: 2.5,
          strokeDasharray: (d) => (d.partial ? '4,3' : null),
        }),
        ...labelMarks,
        Plot.tip(flat, Plot.pointer({ x: 'x', y: 'value', title })),
        metricDef.baseline != null ? Plot.ruleY([metricDef.baseline], { stroke: palette.grid }) : null,
      ].filter(Boolean),
    })
  }

  if (!curves || !model) return <p className="muted p-6">Loading cohort curves…</p>

  const onPick = (d) => { if (d?.groupId != null) setFocus(d.groupId) }
  const bandN = model.band.length ? model.band[Math.floor(model.band.length / 2)].n : 0

  const Seg = ({ label, options, value, onChange }) => (
    <div className="seg">
      <span className="seg-label">{label}</span>
      {options.map(([v, t]) => (
        <button key={v} className="chip" data-on={String(value === v)} onClick={() => onChange(v)}>{t}</button>
      ))}
    </div>
  )

  return (
    <section>
      <h2 className="text-lg font-semibold">Cohort curves</h2>
      <p className="subtle text-sm max-w-4xl">
        Compare sets by <em>age</em>, not calendar date. <strong>Index</strong> normalizes each set to 100 at a
        baseline (release-day market price, or retail MSRP — release day is hype-inflated, MSRP shows gain over
        retail); <strong>Raw $</strong> shows absolute price. Shaded band = p25–p75 of the shown cohort
        ({bandN} sets). <em>Click a line to focus · drag a box to zoom · double-click to reset.</em>
      </p>
      <FilterBar meta={meta} state={state} setState={setState} />
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5 pb-1">
        <Seg label="Metric" value={state.metric} onChange={(v) => setState((s) => ({ ...s, metric: v }))}
          options={Object.entries(METRICS).map(([k, m]) => [k, m.label])} />
        <Seg label="X axis" value={state.xUnit} onChange={(v) => setState((s) => ({ ...s, xUnit: v }))}
          options={[['days', 'Days'], ['weeks', 'Weeks'], ['months', 'Months']]} />
      </div>
      <SetPicker meta={meta} picked={picked} setPicked={setPicked} focus={focus} setFocus={setFocus} />
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5 pb-2">
        <Seg label="Window" value={maxAge} onChange={setMaxAge}
          options={[[90, '90d'], [180, '180d'], [365, '1y'], [730, '2y'], [10000, 'All']]} />
        <Seg label="Labels" value={labels} onChange={setLabels}
          options={[['focus', 'Focus only'], ['all', 'All lines'], ['off', 'Off']]} />
        {zoom && <button className="chip" data-on="true" onClick={() => setZoom(null)}>✕ Reset zoom</button>}
      </div>
      {model.lines.some((l) => l.lowConfidence) && state.metric === 'prem' && (
        <p className="text-xs" style={{ color: 'var(--warn)' }}>
          ⚠ some premium series include low-confidence intrinsic values (see data quality report)
        </p>
      )}
      <div className="card p-3">
        {msrpUnavailable ? (
          <p className="muted text-sm py-10 text-center">
            No MSRP baseline for {state.seriesType} — pick a sealed product type, or switch metric.
          </p>
        ) : (
          <PlotFigure build={build} onPick={onPick} onZoom={setZoom}
            deps={[model, state.xUnit, state.metric, labels, focusChase, zoom, themeTick]} />
        )}
      </div>
      {state.seriesType === 'Chase Singles' && focus != null && focusChase?.chase?.length > 0 && (
        <div className="card p-3 mt-3">
          <div className="flex items-baseline justify-between pb-1">
            <h3 className="font-semibold text-sm">{bySet.get(focus)?.name} — chase basket (drives the focused line)</h3>
            <span className="muted text-xs">hover the focused line for prices at a given age</span>
          </div>
          <table className="tbl text-sm w-full">
            <thead><tr><th>Card</th><th>#</th><th>Current</th><th>Peak</th><th>Off peak</th></tr></thead>
            <tbody>
              {focusChase.chase.map((c) => (
                <tr key={c.productId}>
                  <td className="max-w-96 truncate" title={c.name}>
                    <a href={c.url} target="_blank" rel="noreferrer" className="hover:underline">{c.name}</a>
                  </td>
                  <td className="muted">{c.cardNumber}</td>
                  <td>{fmtUsd(c.price)}</td>
                  <td className="muted">{fmtUsd(c.peakPrice)}</td>
                  <td>{c.pctOffPeak != null
                    ? <span style={{ color: c.pctOffPeak < -0.001 ? 'var(--neg)' : 'var(--pos)' }}>{fmtPct(c.pctOffPeak)}</span>
                    : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

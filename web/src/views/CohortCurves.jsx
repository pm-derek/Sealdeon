import * as Plot from '@observablehq/plot'
import { useEffect, useMemo, useState } from 'react'
import FilterBar, { Dropdown } from '../components/FilterBar.jsx'
import SetPicker from '../components/SetPicker.jsx'
import PlotFigure from '../components/PlotFigure.jsx'
import { loadView, loadSetDetail } from '../lib/loadView.js'
import { cohortBand, filterSeries, fmtPct, fmtUsd } from '../lib/slice.js'
import { useTheme } from '../lib/theme.js'

const X_DIV = { days: 1, weeks: 7, months: 30.44 }
const MAX_COLORED = 8

const METRICS = {
  raw: { label: 'Raw $', axis: 'market price', isPct: false, isUsd: true },
  prem: { label: 'Premium %', axis: 'sealed premium', isPct: true, baseline: 0 },
}

// A short, readable line label from a set name: drop the "SWSH07:" / "SM -"
// style prefix and trim. e.g. "SWSH07: Evolving Skies" -> "Evolving Skies".
function shortLabel(set) {
  const raw = (set?.name || String(set?.groupId || '')).replace(/^[A-Za-z0-9]+\s*[:\-–]\s*/, '')
  return raw.length > 18 ? raw.slice(0, 17) + '…' : raw
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
    eras: [], seriesType: 'Booster Box', hype: 'all', completeness: 'complete',
    metric: 'raw', xUnit: 'days',
  })
  const [picked, setPicked] = useState(new Set())
  const [focus, setFocus] = useState(null)
  const [labels, setLabels] = useState('all')
  const [yLog, setYLog] = useState(true)
  const [focusChase, setFocusChase] = useState(null)
  const [view, setView] = useState(null) // { x?:[min,max], y?:[min,max] } | null
  const { palette, themeTick } = useTheme()
  // Merge x/y zoom patches; null resets both.
  const applyView = (patch) => setView((v) => (patch === null ? null : { ...(v || {}), ...patch }))

  useEffect(() => { loadView('cohort_curves').then(setCurves) }, [])
  useEffect(() => {
    if (focus == null || state.seriesType !== 'Chase Singles') { setFocusChase(null); return }
    let live = true
    loadSetDetail(focus).then((d) => { if (live) setFocusChase(d) }).catch(() => setFocusChase(null))
    return () => { live = false }
  }, [focus, state.seriesType])
  useEffect(() => { setView(null) }, [state.metric, state.seriesType, state.xUnit])

  const bySet = useMemo(() => new Map(meta.sets.map((s) => [s.groupId, s])), [meta])
  const metricDef = METRICS[state.metric]
  const isPct = metricDef.isPct
  const useLog = state.metric === 'raw' && yLog
  const valueAt = state.metric === 'prem' ? (pt) => pt[2] : (pt) => pt[3]

  const model = useMemo(() => {
    if (!curves) return null
    const opts = { ...state, picked: picked.size ? picked : null }
    const series = filterSeries(curves, meta, opts)
    const band = cohortBand(series, valueAt)
    const lines = series.map((s) => {
      const set = bySet.get(s.groupId)
      return {
        groupId: s.groupId, name: set?.name ?? String(s.groupId), abbr: shortLabel(set),
        partial: !set?.archiveComplete, lowConfidence: s.lowConfidence && state.metric === 'prem',
        points: s.points.filter((pt) => valueAt(pt) != null && (!useLog || valueAt(pt) > 0))
          .map((pt) => ({ age: pt[0], value: valueAt(pt), price: pt[3] })),
      }
    }).filter((l) => l.points.length > 1)
    const colored = new Map()
    const ids = picked.size ? [...picked].slice(0, MAX_COLORED) : focus != null ? [focus] : []
    ids.forEach((gid, i) => colored.set(gid, palette.series[i % palette.series.length]))
    return { lines, band, colored }
  }, [curves, meta, state, picked, focus, valueAt, useLog, themeTick])

  const chaseTitle = (gid, ageDays) => {
    if (!focusChase || gid !== focus || state.seriesType !== 'Chase Singles') return null
    const set = bySet.get(gid); if (!set?.releaseDate) return null
    const date = new Date(new Date(set.releaseDate).getTime() + ageDays * 86400000).toISOString().slice(0, 10)
    const rows = (focusChase.chase || []).map((c) => {
      const p = priceAtDate(c.sparkline, date) ?? c.price
      return `  ${(c.name.replace(set.name, '').trim()) || c.name} — ${fmtUsd(p)}`
    })
    return rows.length ? `\nChase cards @ ${date}:\n${rows.join('\n')}` : null
  }

  const build = (width) => {
    if (!model) return null
    const div = X_DIV[state.xUnit]
    const flat = model.lines.flatMap((l) =>
      l.points.map((p) => ({ x: p.age / div, ageDays: p.age, value: p.value, name: l.name, abbr: l.abbr, groupId: l.groupId, partial: l.partial, price: p.price })))
    const context = flat.filter((d) => !model.colored.has(d.groupId))
    const highlighted = flat.filter((d) => model.colored.has(d.groupId))
    const lastVisible = (rows) => {
      const xv = view?.x || null
      const hi = xv ? xv[1] : Infinity, lo = xv ? xv[0] : -Infinity
      const inv = rows.filter((d) => d.x >= lo && d.x <= hi)
      return inv.filter((d) => d === inv.filter((x) => x.groupId === d.groupId).at(-1))
    }

    const xView = view?.x || null
    const lo = xView ? xView[0] : -Infinity, hi = xView ? xView[1] : Infinity
    const vis = flat.filter((d) => d.x >= lo && d.x <= hi).map((d) => d.value)
    let yDomain = view?.y || undefined // manual y-zoom overrides auto-fit
    if (!yDomain && vis.length) {
      let loY = Math.min(...vis), hiY = Math.max(...vis)
      if (useLog) { loY = Math.max(loY, 0.01); yDomain = [loY / 1.15, hiY * 1.15] }
      else { const pad = (hiY - loY) * 0.06 || 1; yDomain = [isPct ? Math.min(loY - pad, 0) : loY - pad, hiY + pad] }
    }

    const title = (d) => {
      const head = `${d.name}${d.partial ? ' (partial)' : ''}\nage ${Math.round(d.x)} ${state.xUnit}`
      const line = isPct ? `premium ${fmtPct(d.value)}` : fmtUsd(d.value)
      return head + '\n' + line + (chaseTitle(d.groupId, d.ageDays) || '')
    }

    const labelMarks = []
    if (labels === 'all') {
      labelMarks.push(Plot.text(lastVisible(flat), {
        x: 'x', y: 'value', text: 'abbr', dx: 5, textAnchor: 'start', fontSize: 9.5,
        fill: (d) => model.colored.get(d.groupId) || palette.textSecondary,
        stroke: palette.surface, strokeWidth: 2, paintOrder: 'stroke',
      }))
    } else if (labels === 'focus') {
      labelMarks.push(Plot.text(lastVisible(highlighted), {
        x: 'x', y: 'value', text: 'name', dx: 6, textAnchor: 'start', fontSize: 11, fill: palette.text,
        stroke: palette.surface, strokeWidth: 3, paintOrder: 'stroke',
      }))
    }

    return Plot.plot({
      width, height: 540,
      marginRight: labels === 'all' ? 74 : labels === 'focus' ? 150 : 24,
      marginLeft: 56,
      style: { background: 'transparent', color: palette.textSecondary, fontSize: '12px' },
      x: { label: `${state.xUnit} since release →`, grid: false, domain: view?.x || undefined },
      y: {
        label: `↑ ${metricDef.axis}${useLog ? ' (log)' : ''}`, grid: true, domain: yDomain,
        type: useLog ? 'log' : 'linear',
        tickFormat: isPct ? ((d) => `${(d * 100).toFixed(0)}%`) : ((d) => `$${d >= 1000 ? (d / 1000) + 'k' : d}`),
      },
      marks: [
        // clip:true keeps marks inside the frame when zoomed (no bleed past the axes).
        Plot.areaY(model.band, { x: (d) => d.age / div, y1: 'p25', y2: 'p75', fill: palette.band, fillOpacity: 0.5, clip: true }),
        Plot.line(model.band, { x: (d) => d.age / div, y: 'p50', stroke: palette.textSecondary, strokeWidth: 1.5, strokeDasharray: '3,3', clip: true }),
        Plot.line(context, { x: 'x', y: 'value', z: 'groupId', stroke: palette.context, strokeWidth: 1, strokeOpacity: 0.8, strokeDasharray: (d) => (d.partial ? '2,3' : null), clip: true }),
        Plot.line(highlighted, { x: 'x', y: 'value', z: 'groupId', stroke: (d) => model.colored.get(d.groupId), strokeWidth: 2.5, strokeDasharray: (d) => (d.partial ? '4,3' : null), clip: true }),
        ...labelMarks,
        Plot.tip(flat, Plot.pointer({ x: 'x', y: 'value', title })),
        metricDef.baseline != null ? Plot.ruleY([metricDef.baseline], { stroke: palette.grid }) : null,
      ].filter(Boolean),
    })
  }

  if (!curves || !model) return <p className="muted p-6">Loading cohort curves…</p>

  const onPick = (d) => { if (d?.groupId != null) setFocus(d.groupId) }
  const setK = (k) => (v) => setState((s) => ({ ...s, [k]: v }))

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Cohort curves</h2>
        <p className="muted text-xs">scroll = zoom X · shift-scroll / over-axis = zoom Y · drag = pan · double-click = reset · click a line = focus</p>
      </div>

      {/* Compact control toolbar (single-selects as dropdowns; era multi-chips) */}
      <FilterBar meta={meta} state={state} setState={setState} />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 py-2">
        <Dropdown label="Metric" value={state.metric} onChange={setK('metric')}
          options={Object.entries(METRICS).map(([k, m]) => [k, m.label])} />
        <Dropdown label="X axis" value={state.xUnit} onChange={setK('xUnit')}
          options={[['days', 'Days'], ['weeks', 'Weeks'], ['months', 'Months']]} />
        {state.metric === 'raw' && (
          <Dropdown label="Y scale" value={yLog ? 'log' : 'lin'} onChange={(v) => setYLog(v === 'log')}
            options={[['log', 'Log'], ['lin', 'Linear']]} />
        )}
        <Dropdown label="Labels" value={labels} onChange={setLabels}
          options={[['all', 'All lines'], ['focus', 'Focus only'], ['off', 'Off']]} />
        <SetPicker meta={meta} picked={picked} setPicked={setPicked} focus={focus} setFocus={setFocus} eras={state.eras} />
        {view && <button className="chip" data-on="true" onClick={() => setView(null)}>✕ Reset view</button>}
      </div>
      {model.lines.some((l) => l.lowConfidence) && state.metric === 'prem' && (
        <p className="text-xs pb-1" style={{ color: 'var(--warn)' }}>
          ⚠ some premium series include low-confidence intrinsic values (see data quality report)
        </p>
      )}
      <div className="card p-3">
        <PlotFigure build={build} onPick={onPick} onView={applyView}
          deps={[model, state.xUnit, state.metric, labels, useLog, focusChase, view, themeTick]} />
      </div>
      {state.seriesType === 'Chase Singles' && focus != null && focusChase?.chase?.length > 0 && (
        <div className="card p-3 mt-3">
          <div className="flex items-baseline justify-between pb-2">
            <h3 className="font-semibold text-sm">{bySet.get(focus)?.name} — chase basket (drives the focused line)</h3>
            <span className="muted text-xs">hover the focused line for prices at a given age</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            {focusChase.chase.map((c) => (
              <a key={c.productId} href={c.url} target="_blank" rel="noreferrer"
                className="card p-2 flex gap-2 items-center hover:brightness-110" style={{ boxShadow: 'none' }}>
                {c.imageUrl && <img src={c.imageUrl} alt="" loading="lazy"
                  className="rounded" style={{ width: 44, height: 61, objectFit: 'cover', flex: '0 0 auto' }} />}
                <div className="min-w-0">
                  <div className="text-xs truncate" title={c.name}>{(c.name.replace(bySet.get(focus)?.name || '', '').trim()) || c.name}</div>
                  <div className="text-sm font-semibold">{fmtUsd(c.price)}</div>
                  <div className="text-xs muted">peak {fmtUsd(c.peakPrice)}
                    {c.pctOffPeak != null && <span style={{ color: c.pctOffPeak < -0.001 ? 'var(--neg)' : 'var(--pos)' }}> · {fmtPct(c.pctOffPeak)}</span>}
                  </div>
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

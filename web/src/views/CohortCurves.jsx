import * as Plot from '@observablehq/plot'
import { useEffect, useMemo, useState } from 'react'
import FilterBar from '../components/FilterBar.jsx'
import SetPicker from '../components/SetPicker.jsx'
import PlotFigure from '../components/PlotFigure.jsx'
import { loadView, loadSetDetail } from '../lib/loadView.js'
import { cohortBand, filterSeries, fmtPct, fmtUsd } from '../lib/slice.js'
import { useTheme } from '../lib/theme.js'

const X_DIV = { days: 1, weeks: 7, months: 30.44 }
const MAX_COLORED = 8 // categorical slots; beyond this, extra picks stay context-gray

// Nearest sparkline price to a target ISO date (sparkline: [[date, price], ...]).
function priceAtDate(sparkline, targetIso) {
  if (!sparkline || !sparkline.length) return null
  let best = sparkline[0]
  let bestGap = Infinity
  for (const pt of sparkline) {
    const gap = Math.abs(new Date(pt[0]) - new Date(targetIso))
    if (gap < bestGap) { bestGap = gap; best = pt }
  }
  return best[1]
}

export default function CohortCurves({ meta }) {
  const [curves, setCurves] = useState(null)
  const [state, setState] = useState({
    era: 'All', seriesType: 'Booster Box', hype: 'all',
    completeness: 'complete', metric: 'idx', xUnit: 'days',
  })
  const [picked, setPicked] = useState(new Set())
  const [focus, setFocus] = useState(null)
  const [maxAge, setMaxAge] = useState(365)
  const [labels, setLabels] = useState('focus') // focus | all | off
  const [focusChase, setFocusChase] = useState(null) // {chase:[...]} for the focused set
  const { palette, themeTick } = useTheme()

  useEffect(() => { loadView('cohort_curves').then(setCurves) }, [])

  // When a set is focused and we're viewing chase singles, load its 5
  // constituent chase cards so hover can break the median line down.
  useEffect(() => {
    if (focus == null || state.seriesType !== 'Chase Singles') { setFocusChase(null); return }
    let live = true
    loadSetDetail(focus).then((d) => { if (live) setFocusChase(d) }).catch(() => setFocusChase(null))
    return () => { live = false }
  }, [focus, state.seriesType])

  const bySet = useMemo(() => new Map(meta.sets.map((s) => [s.groupId, s])), [meta])

  const model = useMemo(() => {
    if (!curves) return null
    const opts = { ...state, picked: picked.size ? picked : null }
    const series = filterSeries(curves, meta, opts)
    const valueAt = state.metric === 'idx' ? (pt) => pt[1] : (pt) => pt[2]
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
          .map((pt) => ({ age: pt[0], value: valueAt(pt), price: pt[3], idx: pt[1], prem: pt[2] })),
      }
    }).filter((l) => l.points.length > 1)

    const colored = new Map()
    const coloredIds = picked.size
      ? [...picked].slice(0, MAX_COLORED)
      : focus != null ? [focus] : []
    coloredIds.forEach((gid, i) => colored.set(gid, palette.series[i % palette.series.length]))
    return { lines, band, colored }
  }, [curves, meta, state, picked, focus, maxAge, themeTick])

  const chaseTitle = (gid, ageDays) => {
    if (!focusChase || gid !== focus || state.seriesType !== 'Chase Singles') return null
    const set = bySet.get(gid)
    if (!set?.releaseDate) return null
    const date = new Date(new Date(set.releaseDate).getTime() + ageDays * 86400000)
      .toISOString().slice(0, 10)
    const lines = (focusChase.chase || []).map((c) => {
      const p = priceAtDate(c.sparkline, date) ?? c.price
      return `  ${c.name.replace(set.name, '').trim() || c.name} — ${fmtUsd(p)}`
    })
    return lines.length ? `\nChase cards @ ${date}:\n${lines.join('\n')}` : null
  }

  const build = (width) => {
    if (!model) return null
    const div = X_DIV[state.xUnit]
    const isPrem = state.metric === 'prem'
    const flat = model.lines.flatMap((l) =>
      l.points.map((p) => ({
        x: p.age / div, ageDays: p.age, value: p.value, name: l.name, abbr: l.abbr,
        groupId: l.groupId, partial: l.partial, price: p.price,
      })),
    )
    const context = flat.filter((d) => !model.colored.has(d.groupId))
    const highlighted = flat.filter((d) => model.colored.has(d.groupId))
    const lastPoints = (rows) =>
      rows.filter((d, i, arr) => d === arr.filter((x) => x.groupId === d.groupId).at(-1))

    const normalTitle = (d) => {
      const head = `${d.name}${d.partial ? ' (partial)' : ''}\nage ${Math.round(d.x)} ${state.xUnit}`
      const metricLine = isPrem
        ? `premium ${fmtPct(d.value)}`
        : `index ${d.value?.toFixed(1)}  ·  ${fmtUsd(d.price)}`
      return head + '\n' + metricLine + (chaseTitle(d.groupId, d.ageDays) || '')
    }
    const tipMarks = [Plot.tip(flat, Plot.pointer({ x: 'x', y: 'value', title: normalTitle }))]

    const labelMarks = []
    if (labels === 'all') {
      labelMarks.push(Plot.text(lastPoints(flat), {
        x: 'x', y: 'value', text: 'abbr', dx: 5, textAnchor: 'start', fontSize: 9,
        fill: (d) => model.colored.get(d.groupId) || palette.textSecondary,
      }))
    } else if (labels === 'focus') {
      labelMarks.push(Plot.text(lastPoints(highlighted), {
        x: 'x', y: 'value', text: 'name', dx: 6, textAnchor: 'start', fontSize: 11,
        fill: palette.text,
      }))
    }

    return Plot.plot({
      width, height: 460,
      marginRight: labels === 'all' ? 54 : 90,
      style: { background: 'transparent', color: palette.textSecondary, fontSize: '12px' },
      x: { label: `${state.xUnit} since release`, grid: false },
      y: {
        label: isPrem ? 'sealed premium' : 'indexed price (release day = 100)',
        grid: true, tickFormat: isPrem ? (d) => `${(d * 100).toFixed(0)}%` : undefined,
      },
      marks: [
        Plot.areaY(model.band, {
          x: (d) => d.age / div, y1: 'p25', y2: 'p75',
          fill: palette.band, fillOpacity: 0.55,
        }),
        Plot.line(model.band, {
          x: (d) => d.age / div, y: 'p50',
          stroke: palette.textSecondary, strokeWidth: 1.5, strokeDasharray: '3,3',
        }),
        Plot.line(context, {
          x: 'x', y: 'value', z: 'groupId',
          stroke: palette.context, strokeWidth: 1, strokeOpacity: 0.7,
          strokeDasharray: (d) => (d.partial ? '2,3' : null),
        }),
        Plot.line(highlighted, {
          x: 'x', y: 'value', z: 'groupId',
          stroke: (d) => model.colored.get(d.groupId), strokeWidth: 2.5,
          strokeDasharray: (d) => (d.partial ? '4,3' : null),
        }),
        ...labelMarks,
        ...tipMarks,
        isPrem ? Plot.ruleY([0], { stroke: palette.grid }) : Plot.ruleY([100], { stroke: palette.grid }),
      ],
    })
  }

  if (!curves || !model) return <p className="muted p-4">Loading cohort curves…</p>

  const onPick = (datum) => { if (datum?.groupId != null) setFocus(datum.groupId) }
  const bandN = model.band.length ? model.band[Math.floor(model.band.length / 2)].n : 0
  return (
    <section>
      <h2 className="text-lg font-semibold">Cohort curves</h2>
      <p className="subtle text-sm">
        Compare sets by <em>age</em>, not calendar date. <strong>Indexed price = release day = 100</strong>
        {' '}(80 means −20% vs launch, not $80; hover shows the real $). Shaded band = p25–p75 of the
        displayed cohort ({bandN} sets at median age); dashed = partial history. <em>Click any line to focus it.</em>
      </p>
      <FilterBar meta={meta} state={state} setState={setState} show={{ metric: true, xUnit: true }} />
      <SetPicker meta={meta} picked={picked} setPicked={setPicked} focus={focus} setFocus={setFocus} />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pb-2">
        <div className="flex items-center gap-2">
          <span className="muted text-xs uppercase tracking-wide">Window</span>
          {[90, 180, 365, 730, 10000].map((d) => (
            <button key={d} className="chip" data-on={String(maxAge === d)} onClick={() => setMaxAge(d)}>
              {d === 10000 ? 'All' : d >= 365 ? `${Math.round(d / 365)}y` : `${d}d`}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="muted text-xs uppercase tracking-wide">Labels</span>
          {[['focus', 'Focus only'], ['all', 'All lines'], ['off', 'Off']].map(([v, t]) => (
            <button key={v} className="chip" data-on={String(labels === v)} onClick={() => setLabels(v)}>{t}</button>
          ))}
        </div>
      </div>
      {model.lines.some((l) => l.lowConfidence) && state.metric === 'prem' && (
        <p className="text-xs" style={{ color: 'var(--warn)' }}>
          ⚠ some premium series include low-confidence intrinsic values (see data quality report)
        </p>
      )}
      <div className="card p-3">
        <PlotFigure build={build} onPick={onPick}
          deps={[model, state.xUnit, state.metric, labels, focusChase, themeTick]} />
      </div>
      {state.seriesType === 'Chase Singles' && focus != null && focusChase?.chase?.length > 0 && (
        <div className="card p-3 mt-3">
          <div className="flex items-baseline justify-between pb-1">
            <h3 className="font-semibold text-sm">{bySet.get(focus)?.name} — chase basket (drives the focused line)</h3>
            <span className="muted text-xs">hover the focused line for prices at a given age</span>
          </div>
          <table className="tbl text-sm w-full">
            <thead>
              <tr><th>Card</th><th>#</th><th>Current</th><th>Peak</th><th>Off peak</th></tr>
            </thead>
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

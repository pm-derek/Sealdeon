import * as Plot from '@observablehq/plot'
import { useEffect, useMemo, useState } from 'react'
import FilterBar from '../components/FilterBar.jsx'
import SetPicker from '../components/SetPicker.jsx'
import PlotFigure from '../components/PlotFigure.jsx'
import { loadView } from '../lib/loadView.js'
import { cohortBand, filterSeries, fmtPct } from '../lib/slice.js'
import { useTheme } from '../lib/theme.js'

const X_DIV = { days: 1, weeks: 7, months: 30.44 }
const MAX_COLORED = 8 // categorical slots; beyond this, extra picks stay context-gray

export default function CohortCurves({ meta }) {
  const [curves, setCurves] = useState(null)
  const [state, setState] = useState({
    era: 'All', seriesType: 'Booster Box', hype: 'all',
    completeness: 'complete', metric: 'idx', xUnit: 'days',
  })
  const [picked, setPicked] = useState(new Set())
  const [focus, setFocus] = useState(null)
  const [maxAge, setMaxAge] = useState(365)
  const { palette, themeTick } = useTheme()

  useEffect(() => { loadView('cohort_curves').then(setCurves) }, [])

  const model = useMemo(() => {
    if (!curves) return null
    const opts = { ...state, picked: picked.size ? picked : null }
    const series = filterSeries(curves, meta, opts)
    const bySet = new Map(meta.sets.map((s) => [s.groupId, s]))
    const valueAt = state.metric === 'idx' ? (pt) => pt[1] : (pt) => pt[2]
    const band = cohortBand(series, valueAt, maxAge)

    const lines = series.map((s) => {
      const set = bySet.get(s.groupId)
      return {
        groupId: s.groupId,
        name: set?.name ?? String(s.groupId),
        partial: !set?.archiveComplete,
        lowConfidence: s.lowConfidence && state.metric === 'prem',
        points: s.points
          .filter((pt) => pt[0] <= maxAge && valueAt(pt) != null)
          .map((pt) => ({ age: pt[0], value: valueAt(pt) })),
      }
    }).filter((l) => l.points.length > 1)

    const colored = new Map()
    const coloredIds = picked.size
      ? [...picked].slice(0, MAX_COLORED)
      : focus != null ? [focus] : []
    coloredIds.forEach((gid, i) => colored.set(gid, palette.series[i % palette.series.length]))
    return { lines, band, colored }
  }, [curves, meta, state, picked, focus, maxAge, themeTick])

  const build = (width) => {
    if (!model) return null
    const div = X_DIV[state.xUnit]
    const isPrem = state.metric === 'prem'
    const flat = model.lines.flatMap((l) =>
      l.points.map((p) => ({
        x: p.age / div, value: p.value, name: l.name,
        groupId: l.groupId, partial: l.partial,
      })),
    )
    const context = flat.filter((d) => !model.colored.has(d.groupId))
    const highlighted = flat.filter((d) => model.colored.has(d.groupId))
    return Plot.plot({
      width, height: 440,
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
          stroke: (d) => model.colored.get(d.groupId), strokeWidth: 2,
          strokeDasharray: (d) => (d.partial ? '4,3' : null),
        }),
        Plot.text(
          highlighted.filter((d, i, arr) => {
            const last = arr.filter((x) => x.groupId === d.groupId).at(-1)
            return d === last
          }),
          {
            x: 'x', y: 'value', text: 'name', dx: 6, textAnchor: 'start',
            fill: palette.text, fontSize: 11,
          },
        ),
        Plot.tip(flat, Plot.pointer({
          x: 'x', y: 'value',
          title: (d) =>
            `${d.name}${d.partial ? ' (partial)' : ''}\nage ${Math.round(d.x)} ${state.xUnit}\n` +
            (isPrem ? `premium ${fmtPct(d.value)}` : `index ${d.value?.toFixed(1)}`),
        })),
        isPrem ? Plot.ruleY([0], { stroke: palette.grid }) : Plot.ruleY([100], { stroke: palette.grid }),
      ],
    })
  }

  if (!curves || !model) return <p className="muted p-4">Loading cohort curves…</p>

  const bandN = model.band.length ? model.band[Math.floor(model.band.length / 2)].n : 0
  return (
    <section>
      <h2 className="text-lg font-semibold">Cohort curves</h2>
      <p className="subtle text-sm">
        Compare sets by <em>age</em>, not calendar date. Shaded band = p25–p75 of the
        displayed cohort ({bandN} sets at median age); dashed = partial history
        (released before the 2024-02-08 archive floor, indexed to first observation).
      </p>
      <FilterBar meta={meta} state={state} setState={setState} show={{ metric: true, xUnit: true }} />
      <SetPicker meta={meta} picked={picked} setPicked={setPicked} focus={focus} setFocus={setFocus} />
      <div className="flex items-center gap-2 pb-2">
        <span className="muted text-xs uppercase tracking-wide">Window</span>
        {[90, 180, 365, 730, 10000].map((d) => (
          <button key={d} className="chip" data-on={String(maxAge === d)} onClick={() => setMaxAge(d)}>
            {d === 10000 ? 'All' : d >= 365 ? `${Math.round(d / 365)}y` : `${d}d`}
          </button>
        ))}
      </div>
      {model.lines.some((l) => l.lowConfidence) && state.metric === 'prem' && (
        <p className="text-xs" style={{ color: 'var(--warn)' }}>
          ⚠ some premium series include low-confidence intrinsic values (see data quality report)
        </p>
      )}
      <div className="card p-3">
        <PlotFigure build={build} deps={[model, state.xUnit, state.metric, themeTick]} />
      </div>
    </section>
  )
}

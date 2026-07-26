import * as Plot from '@observablehq/plot'
import { useEffect, useMemo, useState } from 'react'
import FilterBar, { Dropdown } from '../components/FilterBar.jsx'
import SetPicker from '../components/SetPicker.jsx'
import PlotFigure from '../components/PlotFigure.jsx'
import { loadView, loadSetDetail } from '../lib/loadView.js'
import { cohortBand, filterSeries, fmtPct, fmtUsd } from '../lib/slice.js'
import { useTheme } from '../lib/theme.js'

const X_DIV = { days: 1, weeks: 7, months: 30.44 }
const MAX_EMPH = 8
const EPOCH_DAY = 86400000

const METRICS = {
  raw: { label: 'Raw $', axis: 'market price', isPct: false, isUsd: true },
  prem: { label: 'Premium %', axis: 'sealed premium', isPct: true, baseline: 0 },
}

// Compact on-chart segmented toggle.
function Seg({ label, value, onChange, options }) {
  return (
    <div className="seg">
      {label && <span className="seg-label">{label}</span>}
      {options.map(([v, t]) => (
        <button key={v} className="chip" data-on={String(value === v)} onClick={() => onChange(v)}>{t}</button>
      ))}
    </div>
  )
}

function LinkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.8 }} aria-hidden="true">
      <path d="M14 3h7v7" /><path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  )
}

function shortLabel(set) {
  const raw = (set?.name || String(set?.groupId || '')).replace(/^[A-Za-z0-9]+\s*[:\-–]\s*/, '')
  return raw.length > 18 ? raw.slice(0, 17) + '…' : raw
}
// Evenly-spaced light hues for the "color all lines" mode.
function hueColor(i, n) {
  const hue = Math.round((i * 360) / Math.max(n, 1) + 25) % 360
  return `oklch(0.74 0.15 ${hue})`
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
const fmtDate = (epochDay) => new Date(epochDay * EPOCH_DAY).toISOString().slice(0, 7)

export default function CohortCurves({ meta }) {
  const [curves, setCurves] = useState(null)
  const [state, setState] = useState(() => ({
    eras: [], seriesType: meta.seriesTypes?.[0] || 'Booster Box', hype: 'all', completeness: 'complete',
    metric: 'raw', xUnit: 'days',
  }))
  const [picked, setPicked] = useState(new Set())
  const [focus, setFocus] = useState(null)
  const [labels, setLabels] = useState('all')
  const [colorMode, setColorMode] = useState('mono')
  const [xMode, setXMode] = useState('cohort') // cohort (age) | calendar (date)
  const [yLog, setYLog] = useState(false)
  const [showFilters, setShowFilters] = useState(false) // mobile: collapsed by default
  const [focusDetail, setFocusDetail] = useState(null)
  const [sigEvents, setSigEvents] = useState(null)
  const [view, setView] = useState(null)
  const { palette, themeTick } = useTheme()

  const latestEpoch = useMemo(
    () => Math.floor(new Date(meta.latestDate || Date.now()).getTime() / EPOCH_DAY), [meta.latestDate])

  useEffect(() => { loadView('cohort_curves').then(setCurves) }, [])
  useEffect(() => { loadView('signals_events').then((d) => setSigEvents(d.byGroup || {})).catch(() => setSigEvents({})) }, [])
  useEffect(() => {
    if (focus == null) { setFocusDetail(null); return }
    let live = true
    loadSetDetail(focus).then((d) => { if (live) setFocusDetail(d) }).catch(() => setFocusDetail(null))
    return () => { live = false }
  }, [focus])
  useEffect(() => { setView(null) }, [state.metric, state.seriesType, state.xUnit])
  // Calendar mode opens on the last ~15 months of real dates.
  useEffect(() => {
    setView(xMode === 'calendar' ? { x: [latestEpoch - 460, latestEpoch + 8] } : null)
  }, [xMode, latestEpoch])

  const bySet = useMemo(() => new Map(meta.sets.map((s) => [s.groupId, s])), [meta])
  const metricDef = METRICS[state.metric]
  const isPct = metricDef.isPct
  const useLog = state.metric === 'raw' && yLog
  const isCal = xMode === 'calendar'
  const div = X_DIV[state.xUnit]
  const valueAt = state.metric === 'prem' ? (pt) => pt[2] : (pt) => pt[3]

  const model = useMemo(() => {
    if (!curves) return null
    const opts = { ...state, picked: picked.size ? picked : null }
    const series = filterSeries(curves, meta, opts)
    const rel = (gid) => {
      const d = bySet.get(gid)?.releaseDate
      return d ? Math.floor(new Date(d).getTime() / EPOCH_DAY) : null
    }
    const lines = series.map((s) => {
      const set = bySet.get(s.groupId)
      return {
        groupId: s.groupId, name: set?.name ?? String(s.groupId), abbr: shortLabel(set),
        partial: !set?.archiveComplete, releaseEpoch: rel(s.groupId),
        lowConfidence: s.lowConfidence && state.metric === 'prem',
        points: s.points.filter((pt) => valueAt(pt) != null && (!useLog || valueAt(pt) > 0))
          .map((pt) => ({ age: pt[0], value: valueAt(pt), price: pt[3] })),
      }
    }).filter((l) => l.points.length > 1 && (!isCal || l.releaseEpoch != null))

    // emphasized = picked (or focus) -> strong series colors
    const emph = new Map()
    const ids = picked.size ? [...picked].slice(0, MAX_EMPH) : focus != null ? [focus] : []
    ids.forEach((gid, i) => emph.set(gid, palette.series[i % palette.series.length]))
    const colorOf = (gid, i) =>
      emph.get(gid) || (colorMode === 'multi' ? hueColor(i, lines.length) : palette.context)
    const band = isCal ? [] : cohortBand(series, valueAt)
    return { lines, band, emph, colorOf }
  }, [curves, meta, state, picked, focus, valueAt, useLog, colorMode, isCal, themeTick])

  const xOf = (line, age) => (isCal ? line.releaseEpoch + age : age / div)

  const labelData = useMemo(() => {
    if (!model || labels === 'off') return null
    const chosen = labels === 'focus'
      ? model.lines.filter((l) => model.emph.has(l.groupId))
      : model.lines
    return chosen.map((l, i) => ({
      groupId: l.groupId, text: l.abbr,
      color: model.emph.get(l.groupId) || model.colorOf(l.groupId, model.lines.indexOf(l)),
      points: l.points.map((p) => ({ x: xOf(l, p.age), value: p.value })),
    }))
  }, [model, labels, isCal, div])

  // All lines in data coords, for touch tap-to-select hit-testing (works
  // regardless of the label setting).
  const hitData = useMemo(() => {
    if (!model) return null
    return model.lines.map((l) => ({
      groupId: l.groupId,
      points: l.points.map((p) => ({ x: xOf(l, p.age), value: p.value })),
    }))
  }, [model, isCal, div])

  // TCGplayer listing for the focused line: the canonical product of the
  // current product type in the focused set. (Chase Singles is a basket, no
  // single listing.)
  const focusLink = useMemo(() => {
    if (!focusDetail || focus == null || state.seriesType === 'Chase Singles') return null
    const sealed = focusDetail.sealed || []
    const canon = sealed.find((s) => s.productType === state.seriesType && s.isCanonical)
      || sealed.find((s) => s.productType === state.seriesType)
    return canon?.url ? { url: canon.url, name: canon.name, price: canon.price } : null
  }, [focusDetail, focus, state.seriesType])

  const chaseTitle = (gid, ageDays) => {
    if (!focusDetail || gid !== focus || state.seriesType !== 'Chase Singles') return null
    const set = bySet.get(gid); if (!set?.releaseDate) return null
    const date = new Date(new Date(set.releaseDate).getTime() + ageDays * EPOCH_DAY).toISOString().slice(0, 10)
    const rows = (focusDetail.chase || []).map((c) => {
      const p = priceAtDate(c.sparkline, date) ?? c.price
      return `  ${(c.name.replace(set.name, '').trim()) || c.name} — ${fmtUsd(p)}`
    })
    return rows.length ? `\nChase cards @ ${date}:\n${rows.join('\n')}` : null
  }

  const build = (width) => {
    if (!model) return null
    const idxOf = new Map(model.lines.map((l, i) => [l.groupId, i]))
    const flat = model.lines.flatMap((l) =>
      l.points.map((p) => ({
        x: xOf(l, p.age), age: p.age, value: p.value, name: l.name,
        groupId: l.groupId, partial: l.partial, price: p.price,
      })))

    const lo = view?.x ? view.x[0] : -Infinity, hi = view?.x ? view.x[1] : Infinity
    const vis = flat.filter((d) => d.x >= lo && d.x <= hi).map((d) => d.value)
    let yDomain = view?.y || undefined
    if (!yDomain && vis.length) {
      let loY = Math.min(...vis), hiY = Math.max(...vis)
      if (useLog) { loY = Math.max(loY, 0.01); yDomain = [loY / 1.15, hiY * 1.15] }
      else { const pad = (hiY - loY) * 0.06 || 1; yDomain = [isPct ? Math.min(loY - pad, 0) : loY - pad, hiY + pad] }
    }

    const title = (d) => {
      const when = isCal ? new Date(d.x * EPOCH_DAY).toISOString().slice(0, 10) : `age ${Math.round(d.x)} ${state.xUnit}`
      const line = isPct ? `premium ${fmtPct(d.value)}` : fmtUsd(d.value)
      return `${d.name}${d.partial ? ' (partial)' : ''}\n${when}\n${line}` + (chaseTitle(d.groupId, d.age) || '')
    }

    // Buy-signal markers for the focused set (raw $ mode only; markers sit
    // on the price line). Conviction = the rare high-edge combo; value_rebound
    // = its looser, more frequent cousin.
    const SIG_LABEL = { conviction: 'conviction 🎯', value_rebound: 'value + turning up', below_peers: 'below peers' }
    const buyMarks = []
    if (!isPct && focus != null && sigEvents) {
      const set = bySet.get(focus)
      const relE = set?.releaseDate ? Math.floor(new Date(set.releaseDate).getTime() / EPOCH_DAY) : null
      // Snap each marker onto the focused line (nearest point by age) so the
      // triangle sits ON the curve rather than floating at the raw signal
      // price of a possibly-different SKU of the same product type.
      const fLine = model.lines.find((l) => l.groupId === focus)
      const snapY = (ageDays) => {
        if (!fLine || !fLine.points.length) return null
        let best = fLine.points[0], gap = Infinity
        for (const p of fLine.points) { const g = Math.abs(p.age - ageDays); if (g < gap) { gap = g; best = p } }
        return gap <= 14 ? best.value : null   // only mark if the line has data near that date
      }
      const pts = (sigEvents[focus] || [])
        .filter((e) => e.productType === state.seriesType && SIG_LABEL[e.signal])
        .map((e) => {
          const ed = Math.floor(new Date(e.date).getTime() / EPOCH_DAY)
          if (relE == null) return null
          const ageDays = ed - relE
          return { x: isCal ? ed : ageDays / div, value: snapY(ageDays), signalPrice: e.price, signal: e.signal, date: e.date, ret30: e.ret30 }
        }).filter((p) => p && p.value != null && p.value > 0 && (isCal || p.x >= 0))
      if (pts.length) {
        buyMarks.push(Plot.dot(pts, {
          x: 'x', y: 'value', symbol: 'triangle',
          r: (d) => (d.signal === 'conviction' ? 9 : 6),
          fill: (d) => (d.signal === 'conviction' ? 'var(--accent)' : 'var(--pos)'),
          stroke: palette.surface, strokeWidth: 1.2, clip: true,
          title: (d) => `▲ BUY signal — ${SIG_LABEL[d.signal]}\n${d.date} · ${fmtUsd(d.signalPrice)}` +
            (d.ret30 != null ? `\n30d after: ${fmtPct(d.ret30)}` : ''),
        }))
      }
    }

    return Plot.plot({
      width, height: width < 640 ? 430 : 540,
      marginRight: labels !== 'off' ? 70 : 24,
      marginLeft: 56,
      style: { background: 'transparent', color: palette.textSecondary, fontSize: '12px' },
      x: {
        label: isCal ? 'date →' : `${state.xUnit} since release →`, grid: false, domain: view?.x || undefined,
        tickFormat: isCal ? fmtDate : undefined,
      },
      y: {
        label: `↑ ${metricDef.axis}${useLog ? ' (log)' : ''}`, grid: true, domain: yDomain,
        type: useLog ? 'log' : 'linear',
        tickFormat: isPct ? ((d) => `${(d * 100).toFixed(0)}%`) : ((d) => `$${d >= 1000 ? (d / 1000) + 'k' : d}`),
      },
      marks: [
        model.band.length ? Plot.areaY(model.band, { x: (d) => d.age / div, y1: 'p25', y2: 'p75', fill: palette.band, fillOpacity: 0.5, clip: true }) : null,
        model.band.length ? Plot.line(model.band, { x: (d) => d.age / div, y: 'p50', stroke: palette.textSecondary, strokeWidth: 1.5, strokeDasharray: '3,3', clip: true }) : null,
        // halo: a thick background-colored underlay beneath focused lines so
        // they cut a clear channel out of the multi-color crowd.
        model.emph.size ? Plot.line(flat.filter((d) => model.emph.has(d.groupId)), {
          x: 'x', y: 'value', z: 'groupId', stroke: palette.surface,
          strokeWidth: 6.5, strokeOpacity: 0.9, strokeLinejoin: 'round', strokeLinecap: 'round', clip: true,
        }) : null,
        Plot.line(flat, {
          x: 'x', y: 'value', z: 'groupId',
          stroke: (d) => model.colorOf(d.groupId, idxOf.get(d.groupId)),
          strokeWidth: (d) => (model.emph.has(d.groupId) ? 3.6 : colorMode === 'multi' ? 1.5 : 1),
          // when something is focused, fade the rest hard so the focus pops
          strokeOpacity: (d) => (model.emph.has(d.groupId) ? 1 : model.emph.size ? 0.22 : colorMode === 'multi' ? 0.9 : 0.8),
          strokeDasharray: (d) => (d.partial ? '3,3' : null), clip: true,
        }),
        ...buyMarks,
        Plot.tip(flat, Plot.pointer({ x: 'x', y: 'value', title })),
        metricDef.baseline != null ? Plot.ruleY([metricDef.baseline], { stroke: palette.textSecondary, strokeWidth: 1.5, strokeOpacity: 0.7 }) : null,
      ].filter(Boolean),
    })
  }

  if (!curves || !model) return <p className="muted p-6">Loading cohort curves…</p>

  // tap/click a line toggles it in and out of focus
  const toggleFocus = (gid) => setFocus((f) => (f === gid ? null : gid))
  const onPick = (d) => { if (d?.groupId != null) toggleFocus(d.groupId) }
  const applyView = (patch) => setView((v) => (patch === null ? (isCal ? { x: [latestEpoch - 460, latestEpoch + 8] } : null) : { ...(v || {}), ...patch }))
  const setK = (k) => (v) => setState((s) => ({ ...s, [k]: v }))

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Cohort curves</h2>
        <p className="muted text-xs hidden sm:block">scroll = zoom · shift-scroll = zoom Y · drag = pan · double-click = reset · click line/label = focus (again to clear)</p>
        <button className="chip sm:hidden" onClick={() => setShowFilters((v) => !v)}>
          {showFilters ? '✕ Hide filters' : '⚙ Filters'}
        </button>
      </div>
      <p className="muted text-xs sm:hidden pb-1">drag = pan · pinch = zoom · drag an axis = stretch it · tap = focus/unfocus line · double-tap = reset</p>

      <div className={`${showFilters ? 'block' : 'hidden'} sm:block`}>
        <FilterBar meta={meta} state={state} setState={setState} />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 py-2">
          <Dropdown label="Labels" value={labels} onChange={setLabels}
            options={[['all', 'All'], ['focus', 'Focus'], ['off', 'Off']]} />
          <SetPicker meta={meta} picked={picked} setPicked={setPicked} focus={focus} setFocus={setFocus} eras={state.eras} />
        </div>
      </div>
      {model.lines.some((l) => l.lowConfidence) && state.metric === 'prem' && (
        <p className="text-xs pb-1" style={{ color: 'var(--warn)' }}>
          ⚠ some premium series include low-confidence intrinsic values (see data quality report)
        </p>
      )}
      <div className="card p-3">
        {/* On-chart toolbar (top / near Y axis): metric, Y scale, color */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pb-2">
          <Seg value={state.metric} onChange={setK('metric')}
            options={Object.entries(METRICS).map(([k, m]) => [k, m.label])} />
          {state.metric === 'raw' && (
            <Seg value={yLog ? 'log' : 'lin'} onChange={(v) => setYLog(v === 'log')}
              options={[['lin', 'Linear'], ['log', 'Log']]} />
          )}
          <Seg value={colorMode} onChange={setColorMode}
            options={[['mono', 'Mono'], ['multi', 'Multi-color']]} />
          {view && !isCal && <button className="chip ml-auto" data-on="true" onClick={() => setView(null)}>✕ Reset zoom</button>}
        </div>
        {/* Focus bar: shown when a line is focused — link out + clear */}
        {focus != null && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pb-2 text-sm">
            <span className="font-medium truncate max-w-[16rem]" style={{ color: 'var(--accent)' }}>
              ◉ {bySet.get(focus)?.name}
            </span>
            {focusLink
              ? <a href={focusLink.url} target="_blank" rel="noopener noreferrer"
                   className="inline-flex items-center gap-1 hover:underline" style={{ color: 'var(--accent)' }}>
                  View {state.seriesType} on TCGplayer{focusLink.price != null ? ` · ${fmtUsd(focusLink.price)}` : ''}<LinkIcon />
                </a>
              : state.seriesType === 'Chase Singles'
                ? <span className="muted text-xs">chase basket — see cards below</span>
                : <span className="muted text-xs">no TCGplayer listing for this type</span>}
            <button className="chip ml-auto" onClick={() => setFocus(null)}>✕ Clear focus</button>
          </div>
        )}
        <PlotFigure build={build} onPick={onPick} onView={applyView}
          labelData={labelData} onLabelClick={toggleFocus} hitData={hitData}
          deps={[model, state.xUnit, state.metric, labels, colorMode, useLog, isCal, focus, focusDetail, sigEvents, view, themeTick]} />
        {/* On-chart toolbar (bottom / near X axis): X mode + unit */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-2">
          <Seg value={xMode} onChange={setXMode}
            options={[['cohort', 'Cohort (age)'], ['calendar', 'Daily (date)']]} />
          {!isCal && (
            <Seg value={state.xUnit} onChange={setK('xUnit')}
              options={[['days', 'Days'], ['weeks', 'Weeks'], ['months', 'Months']]} />
          )}
        </div>
      </div>
      {state.seriesType === 'Chase Singles' && focus != null && focusDetail?.chase?.length > 0 && (
        <div className="card p-3 mt-3">
          <div className="flex items-baseline justify-between pb-2">
            <h3 className="font-semibold text-sm">{bySet.get(focus)?.name} — chase basket (drives the focused line)</h3>
            <span className="muted text-xs">hover the focused line for prices at a given age</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            {focusDetail.chase.map((c) => (
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

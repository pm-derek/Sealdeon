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
  index: { label: 'Index', axis: 'index', isPct: false, isIndex: true, baseline: 100 },
  prem: { label: 'Premium %', axis: 'sealed premium', isPct: true, baseline: 0 },
}

// Index baselines. MSRP = 100 answers "what is it worth vs retail"; release
// = 100 answers "how has it moved since launch" and always works (MSRP is a
// curated approximation and is absent for e.g. Chase Singles).
const BASES = { msrp: 'vs MSRP', release: 'vs release' }

// Range shortcuts. In Daily mode these are the last N calendar days; in
// Cohort mode they are the first N days of a set's life.
const RANGES = [['7', '1W'], ['30', '1M'], ['90', '3M'], ['365', '1Y'], ['all', 'All']]

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
  const [basis, setBasis] = useState('msrp')   // index baseline
  const [range, setRange] = useState('all')
  const [axisSlice, setAxisSlice] = useState(null)  // axis tap -> cross-section
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
  // Switching metric changes the Y units entirely, so drop the Y zoom -- but
  // keep the X window (and any active range shortcut) the user chose.
  useEffect(() => {
    setView((v) => (v && v.x ? { x: v.x } : null))
  }, [state.metric, state.seriesType, basis])
  // Range shortcut -> x window. Daily mode = last N calendar days; cohort
  // mode = the first N days of a set's life. 'all' resets to the default view
  // (calendar opens on the last ~15 months).
  useEffect(() => {
    const n = range === 'all' ? null : Number(range)
    if (xMode === 'calendar') {
      setView({ x: n ? [latestEpoch - n, latestEpoch + 2] : [latestEpoch - 460, latestEpoch + 8] })
    } else {
      setView(n ? { x: [0, n / X_DIV[state.xUnit]] } : null)
    }
  }, [xMode, range, latestEpoch, state.xUnit])

  const bySet = useMemo(() => new Map(meta.sets.map((s) => [s.groupId, s])), [meta])
  const metricDef = METRICS[state.metric]
  const isPct = metricDef.isPct
  const isIndex = !!metricDef.isIndex
  const useLog = (state.metric === 'raw' || isIndex) && yLog
  const isCal = xMode === 'calendar'
  const div = X_DIV[state.xUnit]
  // Index is per-series (needs that series' MSRP), so valueAt is built per line.
  const valueFor = (s) => {
    if (state.metric === 'prem') return (pt) => pt[2]
    if (!isIndex) return (pt) => pt[3]
    // MSRP basis when we have a curated MSRP for this series; otherwise fall
    // back to the release-day index so the line still renders.
    if (basis === 'msrp' && s?.msrp) return (pt) => (pt[3] == null ? null : (pt[3] / s.msrp) * 100)
    return (pt) => pt[1]
  }
  const valueAt = valueFor(null)

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
      const vAt = valueFor(s)
      return {
        groupId: s.groupId, name: set?.name ?? String(s.groupId), abbr: shortLabel(set),
        partial: !set?.archiveComplete, releaseEpoch: rel(s.groupId),
        lowConfidence: s.lowConfidence && state.metric === 'prem',
        // index falls back to release-basis when this series has no MSRP
        approxBase: isIndex && basis === 'msrp' && !s.msrp,
        points: s.points.filter((pt) => vAt(pt) != null && (!useLog || vAt(pt) > 0))
          .map((pt) => ({ age: pt[0], value: vAt(pt), price: pt[3] })),
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
  }, [curves, meta, state, picked, focus, isIndex, basis, useLog, colorMode, isCal, themeTick])

  const xOf = (line, age) => (isCal ? line.releaseEpoch + age : age / div)

  const labelData = useMemo(() => {
    if (!model || labels === 'off') return null
    const chosen = labels === 'focus'
      ? model.lines.filter((l) => model.emph.has(l.groupId))
      : model.lines
    const fmt = isPct ? fmtPct : isIndex ? ((v) => v.toFixed(1)) : fmtUsd
    return chosen.map((l, i) => ({
      groupId: l.groupId, text: l.abbr, fmt,
      color: model.emph.get(l.groupId) || model.colorOf(l.groupId, model.lines.indexOf(l)),
      points: l.points.map((p) => ({ x: xOf(l, p.age), value: p.value })),
    }))
  }, [model, labels, isCal, div, isPct, isIndex])

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
      const line = isPct ? `premium ${fmtPct(d.value)}`
        : isIndex ? `index ${d.value.toFixed(1)} (${fmtUsd(d.price)})`
        : fmtUsd(d.value)
      return `${d.name}${d.partial ? ' (partial)' : ''}\n${when}\n${line}` + (chaseTitle(d.groupId, d.age) || '')
    }

    // Buy-signal markers for the focused set (raw $ mode only; markers sit
    // on the price line). Conviction = the rare high-edge combo; value_rebound
    // = its looser, more frequent cousin.
    const SIG_LABEL = { conviction: 'conviction 🎯', value_rebound: 'value + turning up', below_peers: 'below peers' }
    const buyMarks = []
    if (!isPct && !isIndex && focus != null && sigEvents) {
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
      width,
      // phones: fill the viewport below the sticky chrome instead of leaving
      // ~200px of dead space under the chart
      height: width < 640
        ? Math.min(620, Math.max(400, (typeof window !== 'undefined' ? window.innerHeight : 800) - 265))
        : 540,
      marginRight: labels !== 'off' ? 70 : 24,
      marginLeft: 56,
      style: { background: 'transparent', color: palette.textSecondary, fontSize: '12px' },
      x: {
        label: isCal ? 'date →' : `${state.xUnit} since release →`, grid: false, domain: view?.x || undefined,
        tickFormat: isCal ? fmtDate : undefined,
      },
      y: {
        label: `↑ ${isIndex ? `index (${basis === 'msrp' ? 'MSRP' : 'release'} = 100)` : metricDef.axis}${useLog ? ' (log)' : ''}`,
        grid: true, domain: yDomain,
        type: useLog ? 'log' : 'linear',
        tickFormat: isPct ? ((d) => `${(d * 100).toFixed(0)}%`)
          : isIndex ? ((d) => `${d}`)
          : ((d) => `$${d >= 1000 ? (d / 1000) + 'k' : d}`),
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

  // Tapping an axis asks a cross-sectional question of every visible line:
  //   Y axis -> "when did each set FIRST reach this price, and did it HOLD?"
  //   X axis -> "what was every set worth at this age / date?"
  //
  // "First reached" means the first observation AT OR ABOVE the value -- not
  // the first upward crossing. Crossing logic wrongly excluded sets that were
  // already above on day 0 (Ascended Heroes) and, for sets that started above,
  // dipped and recovered (Prismatic), reported the recovery as if it were the
  // first time. A set already above at its first point reports "from day 0".
  const onAxisPick = (axis, value) => {
    if (!model) return
    const out = []
    for (const l of model.lines) {
      const pts = l.points
      if (!pts.length) continue
      if (axis === 'y') {
        let firstIdx = -1, daysAbove = 0, totalDays = 0
        for (let i = 0; i < pts.length; i++) {
          // age-weighted so the daily-then-weekly sampling doesn't skew the share
          const span = i < pts.length - 1 ? Math.max(0, pts[i + 1].age - pts[i].age) : 0
          totalDays += span
          if (pts[i].value >= value) {
            daysAbove += span
            if (firstIdx < 0) firstIdx = i
          }
        }
        if (firstIdx < 0) continue          // never reached it
        const f = pts[firstIdx]
        out.push({
          groupId: l.groupId, name: l.name,
          at: xOf(l, f.age), age: f.age, value: f.value,
          fromStart: firstIdx === 0,        // already above at its first observation
          partial: l.partial,               // ...and we may not have its true day 0
          daysAbove, totalDays,
          now: pts[pts.length - 1].value,
        })
      } else {
        let best = null, gap = Infinity
        for (const p of pts) {
          const g = Math.abs(xOf(l, p.age) - value)
          if (g < gap) { gap = g; best = p }
        }
        const tol = isCal ? 10 : 20 / div
        if (best && gap <= tol) {
          out.push({
            groupId: l.groupId, name: l.name,
            at: xOf(l, best.age), age: best.age, value: best.value,
            now: pts[pts.length - 1].value,
          })
        }
      }
    }
    // Y: who got there first (ties at day 0 broken by who held it longest).
    // X: biggest first.
    out.sort((a, b) => (axis === 'y'
      ? (a.age - b.age) || (b.daysAbove - a.daysAbove)
      : b.value - a.value))
    setAxisSlice({ axis, value, rows: out })
  }

  // tap/click a line toggles it in and out of focus
  const toggleFocus = (gid) => setFocus((f) => (f === gid ? null : gid))
  const onPick = (d) => { if (d?.groupId != null) toggleFocus(d.groupId) }
  // Manual pan/zoom invalidates the range chip, so it can't claim a window
  // the chart is no longer showing.
  const applyView = (patch) => {
    if (patch === null) { setRange('all'); setView(isCal ? { x: [latestEpoch - 460, latestEpoch + 8] } : null); return }
    if (patch.x && range !== 'all') setRange('all')
    setView((v) => ({ ...(v || {}), ...patch }))
  }
  const setK = (k) => (v) => setState((s) => ({ ...s, [k]: v }))
  // Format an axis-slice value / x-position in the units currently on screen.
  const fmtAxisVal = (v) =>
    v == null ? '—' : isPct ? fmtPct(v) : isIndex ? v.toFixed(1) : fmtUsd(v)
  const fmtAxisX = (x) =>
    x == null ? '—'
      : isCal ? new Date(x * EPOCH_DAY).toISOString().slice(0, 10)
      : `${Math.round(x)} ${state.xUnit}`

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold hidden sm:block">Cohort curves</h2>
        <p className="muted text-xs hidden sm:block">scroll = zoom · shift-scroll = zoom Y · drag = pan · double-click = reset · click line/label = focus (again to clear) · <strong>click an axis = cross-section</strong></p>
      </div>

      {/* Mobile: one compact strip pinned under the header, so the controls
          you change most never require scrolling back up. Native selects keep
          it to a single ~36px row and open the OS picker. */}
      <div className="sm:hidden sticky z-10 -mx-3 px-3 py-1.5 flex items-center gap-1"
        style={{ top: 'var(--header-h, 52px)', borderBottom: '1px solid var(--border)',
                 background: 'color-mix(in oklab, var(--surface-0) 94%, transparent)',
                 backdropFilter: 'blur(8px)' }}>
        {/* selects scroll; the filters button stays pinned so it is never cut off */}
        <div className="flex items-center gap-1 overflow-x-auto min-w-0 flex-1">
        <select className="field-xs shrink-0" value={state.seriesType} onChange={(e) => setK('seriesType')(e.target.value)}>
          {(meta.seriesTypes || []).map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="field-xs shrink-0" value={state.metric} onChange={(e) => setK('metric')(e.target.value)}>
          {Object.entries(METRICS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </select>
        {isIndex && (
          <select className="field-xs shrink-0" value={basis} onChange={(e) => setBasis(e.target.value)}>
            {Object.entries(BASES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        )}
        <select className="field-xs shrink-0" value={xMode} onChange={(e) => setXMode(e.target.value)}>
          <option value="cohort">Age</option>
          <option value="calendar">Date</option>
        </select>
        <select className="field-xs shrink-0" value={range} onChange={(e) => setRange(e.target.value)}>
          {RANGES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
        </select>
        </div>
        <button className="chip shrink-0" data-on={String(showFilters)} onClick={() => setShowFilters((v) => !v)}>
          {showFilters ? '✕' : '⚙'}
        </button>
      </div>
      <p className="muted sm:hidden pt-1 pb-0.5 truncate" style={{ fontSize: '10px' }}>
        ↕ scroll · ↔ pan · pinch zoom · tap line = focus · tap axis = slice
      </p>

      <div className={`${showFilters ? 'block' : 'hidden'} sm:block`}>
        <FilterBar meta={meta} state={state} setState={setState} />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 py-2">
          <SetPicker meta={meta} picked={picked} setPicked={setPicked} focus={focus} setFocus={setFocus} eras={state.eras} />
        </div>
      </div>
      {model.lines.some((l) => l.lowConfidence) && state.metric === 'prem' && (
        <p className="text-xs pb-1" style={{ color: 'var(--warn)' }}>
          ⚠ some premium series include low-confidence intrinsic values (see data quality report)
        </p>
      )}
      <div className="card p-3">
        {/* Top toolbar (near Y axis): what's plotted. The index-basis toggle
            only appears while Index is active, so the bar stays quiet. */}
        <div className="hidden sm:flex flex-wrap items-center gap-x-3 gap-y-2 pb-2">
          <Seg value={state.metric} onChange={setK('metric')}
            options={Object.entries(METRICS).map(([k, m]) => [k, m.label])} />
          {isIndex && (
            <Seg value={basis} onChange={setBasis} options={Object.entries(BASES)} />
          )}
          {(state.metric === 'raw' || isIndex) && (
            <Seg value={yLog ? 'log' : 'lin'} onChange={(v) => setYLog(v === 'log')}
              options={[['lin', 'Linear'], ['log', 'Log']]} />
          )}
          <Seg value={colorMode} onChange={setColorMode}
            options={[['mono', 'Mono'], ['multi', 'Color']]} />
          <div className="ml-auto flex items-center gap-2">
            <Dropdown label="Labels" value={labels} onChange={setLabels}
              options={[['all', 'All'], ['focus', 'Focus'], ['off', 'Off']]} />
            {view && <button className="chip" data-on="true" onClick={() => applyView(null)}>✕ Reset</button>}
          </div>
        </div>
        {isIndex && (
          <p className="muted text-xs pb-2">
            {basis === 'msrp'
              ? <>100 = approximate US retail (MSRP). MSRP isn’t published by the data source — it’s a curated table in
                  <code className="mx-1">config/msrp.json</code>, editable per type, set, or item.
                  {model.lines.some((l) => l.approxBase) && <strong> Series without an MSRP fall back to release = 100.</strong>}</>
              : <>100 = the set’s price on release day (or first observation for partial history).</>}
          </p>
        )}
        {/* Axis cross-section: tap an axis tick to slice every line there */}
        {axisSlice && (
          <div className="card p-2.5 mb-2" style={{ background: 'var(--surface-2)' }}>
            <div className="flex flex-wrap items-baseline gap-x-2 pb-1.5">
              <strong className="text-sm">
                {axisSlice.axis === 'y'
                  ? `Reached ${fmtAxisVal(axisSlice.value)} — who, when, and did it hold?`
                  : `Every set at ${fmtAxisX(axisSlice.value)}`}
              </strong>
              <span className="muted text-xs">
                {axisSlice.axis === 'y' ? 'earliest first' : 'highest first'} · {axisSlice.rows.length} of {model.lines.length} lines
              </span>
              <button className="chip ml-auto" onClick={() => setAxisSlice(null)}>✕</button>
            </div>
            {axisSlice.rows.length === 0
              ? <p className="muted text-xs">
                  No line {axisSlice.axis === 'y' ? 'ever reaches that value' : 'has data at that point'} in the current view.
                </p>
              : (
                <div className="overflow-x-auto" style={{ maxHeight: '11rem' }}>
                  <table className="tbl text-sm w-full">
                    <thead>
                      <tr>
                        <th>Set</th>
                        <th title={axisSlice.axis === 'y'
                          ? 'First observation at or above the value. “from day 0” = it was already above when its history starts.'
                          : undefined}>{axisSlice.axis === 'y' ? 'First reached' : 'At'}</th>
                        {axisSlice.axis === 'y' && (
                          <th title="Share of its tracked life spent at or above this value — separates a set that merely touched the level from one that has lived above it.">Held above</th>
                        )}
                        <th>{axisSlice.axis === 'y' ? 'Value there' : metricDef.label}</th>
                        <th title="Latest value, so you can see whether it is still there.">Now</th>
                      </tr>
                    </thead>
                    <tbody>
                      {axisSlice.rows.map((r) => {
                        const pct = r.totalDays > 0 ? Math.round((r.daysAbove / r.totalDays) * 100) : null
                        return (
                          <tr key={r.groupId} style={{ cursor: 'pointer' }} onClick={() => toggleFocus(r.groupId)}>
                            <td className="max-w-56 truncate"
                              style={focus === r.groupId ? { color: 'var(--accent)', fontWeight: 600 } : undefined}>{r.name}</td>
                            <td className="muted whitespace-nowrap">
                              {r.fromStart
                                ? <span title={r.partial
                                    ? 'Already above when our history for this set begins (archive does not cover its release).'
                                    : 'Already above on release day.'}>
                                    from day 0{r.partial ? ' *' : ''}
                                  </span>
                                : fmtAxisX(r.at)}
                            </td>
                            {axisSlice.axis === 'y' && (
                              <td className="whitespace-nowrap muted">
                                {pct == null ? '—' : `${Math.round(r.daysAbove)}d · ${pct}%`}
                              </td>
                            )}
                            <td className="whitespace-nowrap">{fmtAxisVal(r.value)}</td>
                            <td className="whitespace-nowrap"
                              style={{ color: r.now >= axisSlice.value ? 'var(--pos)' : 'var(--text-muted)' }}>
                              {fmtAxisVal(r.now)}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  {axisSlice.axis === 'y' && axisSlice.rows.some((r) => r.fromStart && r.partial) && (
                    <p className="muted text-xs pt-1">
                      * already above where our archive for that set begins — its true release day isn’t covered.
                    </p>
                  )}
                </div>
              )}
          </div>
        )}
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
          labelData={labelData} onLabelClick={toggleFocus} hitData={hitData} onAxisPick={onAxisPick}
          deps={[model, state.xUnit, state.metric, labels, colorMode, useLog, isCal, focus, focusDetail, sigEvents, view, themeTick]} />
        {/* Bottom toolbar (near X axis): the time axis. Range shortcuts mean
            "last N days" on a calendar axis and "first N days of life" on a
            cohort axis -- both useful, same control. */}
        <div className="hidden sm:flex flex-wrap items-center gap-x-3 gap-y-2 pt-2">
          <Seg value={xMode} onChange={setXMode}
            options={[['cohort', 'Cohort (age)'], ['calendar', 'Daily (date)']]} />
          <Seg label={isCal ? 'Last' : 'First'} value={range} onChange={setRange} options={RANGES} />
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

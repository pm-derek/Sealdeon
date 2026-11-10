import * as Plot from '@observablehq/plot'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { loadView } from '../lib/loadView.js'
import { fmtPct, fmtUsd } from '../lib/slice.js'
import { useTheme } from '../lib/theme.js'
import PageHeader from '../components/PageHeader.jsx'

const H = [30, 60, 90]

// [sortKey, header, hover-definition]
const COLS = [
  ['date', 'Date', 'Date the signal first fired (uses only data available up to that day)'],
  ['setName', 'Set', 'Pokémon set — opens the set detail page'],
  ['productName', 'Item', 'The specific sealed product — click to open its TCGplayer page'],
  ['price', 'Price @ signal', 'Market price on the day the signal fired'],
  ['priceNow', 'Price now', 'Latest market price'],
  ['priceChgPct', 'Δ price', 'Price change from @-signal to now (sortable)'],
  ['prem', 'Prem @ signal', 'Sealed premium when it fired = box price ÷ value of the packs inside − 1. Negative = box is cheaper than its own contents.'],
  ['premNow', 'Prem now', 'Latest sealed premium'],
  ['premChgPp', 'Δ prem', 'Premium change in percentage points from @-signal to now (sortable)'],
  ['dev', 'vs peers', 'Premium minus the same-day median premium of non-hype sets of the same product type. More negative = cheaper than its peers.'],
  ['mom30', 'Before 30d', 'How the price moved in the 30 days BEFORE the signal fired (the “turning up” check that the price was already rising).'],
  ['ret30', 'After 30d', 'Outcome: how the price moved in the 30 days AFTER the signal fired (* = window not fully elapsed yet).'],
  ['ret60', 'After 60d', 'Outcome: price move in the 60 days AFTER the signal (* = window not fully elapsed).'],
  ['ret90', 'After 90d', 'Outcome: price move in the 90 days AFTER the signal (* = window not fully elapsed).'],
]

function LinkIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.75 }}
      aria-hidden="true">
      <path d="M14 3h7v7" /><path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  )
}

function retColor(v) {
  if (v == null) return 'var(--text-muted)'
  return v > 0.001 ? 'var(--pos)' : v < -0.001 ? 'var(--neg)' : 'var(--text-muted)'
}

// The -30 .. +90 day price window around a signal, with the buy pip at day 0
// and the +30/+60/+90 outcome boundaries annotated.
function SignalWindow({ path, priceAtSignal }) {
  const ref = useRef(null)
  const { palette, themeTick } = useTheme()
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.innerHTML = ''
    if (!path || path.length < 2) { el.textContent = 'no price window available'; return }
    const pts = path.map(([rel, price]) => ({ rel, price }))
    const before = pts.filter((p) => p.rel <= 0)
    const after = pts.filter((p) => p.rel >= 0)
    const buy = pts.reduce((a, b) => (Math.abs(b.rel) < Math.abs(a.rel) ? b : a), pts[0])
    const maxRel = Math.max(90, ...pts.map((p) => p.rel))
    const marks = [-30, 0, 30, 60, 90].filter((m) => m <= maxRel)
    const fig = Plot.plot({
      width: Math.min(el.clientWidth || 620, 680), height: 168,
      marginLeft: 48, marginRight: 14, marginTop: 18, marginBottom: 26,
      style: { background: 'transparent', color: palette.textSecondary, fontSize: '11px' },
      x: {
        domain: [-30, maxRel], label: 'days from signal →',
        ticks: marks, tickFormat: (d) => (d > 0 ? `+${d}` : `${d}`),
      },
      y: { label: null, grid: true, tickFormat: (d) => `$${d >= 1000 ? (d / 1000) + 'k' : d}` },
      marks: [
        Plot.ruleX(marks.filter((m) => m > 0), { stroke: palette.grid, strokeDasharray: '2,3' }),
        Plot.ruleX([0], { stroke: 'var(--accent)', strokeWidth: 1.6 }),
        // before-signal path is muted; after-signal path is the outcome
        Plot.line(before, { x: 'rel', y: 'price', stroke: palette.textSecondary, strokeWidth: 1.4, strokeOpacity: 0.6 }),
        Plot.line(after, { x: 'rel', y: 'price', stroke: 'var(--accent)', strokeWidth: 1.8 }),
        Plot.dot([buy], { x: 'rel', y: 'price', r: 5, symbol: 'triangle', fill: 'var(--pos)', stroke: palette.surface, strokeWidth: 1.2 }),
        Plot.text(marks.map((m) => ({ rel: m, t: m === 0 ? '▲ buy' : m < 0 ? 'before' : `+${m}d` })),
          { x: 'rel', text: 't', frameAnchor: 'top', dy: -6, fill: palette.textSecondary, fontSize: 10 }),
        Plot.tip(pts, Plot.pointer({ x: 'rel', y: 'price', title: (d) => `${d.rel > 0 ? '+' : ''}${d.rel}d\n${fmtUsd(d.price)}` })),
      ],
    })
    el.append(fig)
    return () => fig.remove()
  }, [path, priceAtSignal, palette, themeTick])
  return <div ref={ref} className="w-full overflow-hidden" />
}

// Common sealed types first, then whatever else the data contains.
const TYPE_ORDER = ['Booster Box', 'Elite Trainer Box', 'ETB', 'PKC ETB', 'Booster Bundle', 'UPC', 'Booster Case', 'ETB Case']

// Backtest leaderboard: each signal's win rate + median forward return vs
// the unconditional baseline (the market drift to beat).
// One row per rule, sorted by how far its 90-day result beat buying anything.
// 90 days is the headline (a sealed position is a months-long hold); 30/60-day
// edges stay visible as small print so the shape over time is not lost.
function edgesOf(bt) {
  const base = Object.fromEntries((bt.baseline || []).map((b) => [b.horizon, b]))
  const bySig = {}
  for (const r of bt.rows) (bySig[r.signal] ||= {})[r.horizon] = r
  const labelOf = Object.fromEntries(bt.signals.map((s) => [s.key, s.label]))
  return Object.entries(bySig).map(([k, hs]) => ({
    key: k, label: labelOf[k] || k, hs,
    edge: Object.fromEntries(H.map((h) => [h, hs[h] && base[h] ? hs[h].medianReturn - base[h].medianReturn : null])),
  })).sort((a, b) => (b.edge[90] ?? -9) - (a.edge[90] ?? -9))
}

const fmtPpt = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)} pts`)

function Leaderboard({ bt }) {
  const base = Object.fromEntries((bt.baseline || []).map((b) => [b.horizon, b]))
  const rows = edgesOf(bt)
  const ext = Math.max(0.02, ...rows.map((r) => Math.abs(r.edge[90] || 0)))
  return (
    <div className="card p-3 overflow-x-auto">
      <table className="tbl text-sm w-full">
        <thead>
          <tr>
            <th className="min-w-[14rem]">Rule</th>
            <th className="text-right" title="Matured firings measured at 90 days">Times fired</th>
            <th className="text-right" title="Share of firings that were up after 90 days">Won (90d)</th>
            <th className="text-right" title="Median price change 90 days after firing">Median (90d)</th>
            <th className="min-w-[11rem]" title="Median 90-day return minus the market's (buying any sealed at random)">vs market (90d)</th>
            <th className="text-right muted" title="Same gap at 30 and 60 days">30d · 60d</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const h = r.hs[90]
            const e = r.edge[90]
            return (
              <tr key={r.key}>
                <td className="whitespace-normal leading-snug">{r.label}</td>
                <td className="text-right tabular-nums muted">{h?.n ?? '—'}</td>
                <td className="text-right tabular-nums">{h ? `${Math.round(h.winRate * 100)}%` : '—'}</td>
                <td className="text-right tabular-nums" style={{ color: retColor(h?.medianReturn) }}>{h ? fmtPct(h.medianReturn) : '—'}</td>
                <td>
                  <div className="flex items-center gap-2">
                    <div className="relative h-2 w-24 shrink-0 rounded-full" style={{ background: 'var(--surface-2)' }}>
                      <div className="absolute top-0 h-2 rounded-full" style={{
                        left: e >= 0 ? '50%' : `${50 - (Math.abs(e) / ext) * 50}%`,
                        width: `${(Math.abs(e || 0) / ext) * 50}%`,
                        background: e >= 0 ? 'var(--pos)' : 'var(--neg)' }} />
                      <div className="absolute top-[-2px] h-3 w-px left-1/2" style={{ background: 'var(--text-muted)' }} />
                    </div>
                    <span className="tabular-nums font-medium" style={{ color: retColor(e) }}>{fmtPpt(e)}</span>
                  </div>
                </td>
                <td className="text-right tabular-nums muted text-xs whitespace-nowrap">{fmtPpt(r.edge[30])} · {fmtPpt(r.edge[60])}</td>
              </tr>
            )
          })}
          <tr style={{ borderTop: '2px solid var(--border-strong)' }}>
            <td className="muted italic">Market — buy any sealed at random</td>
            <td className="text-right muted tabular-nums">{base[90]?.n ?? '—'}</td>
            <td className="text-right muted tabular-nums">{base[90] ? `${Math.round(base[90].winRate * 100)}%` : '—'}</td>
            <td className="text-right muted tabular-nums">{base[90] ? fmtPct(base[90].medianReturn) : '—'}</td>
            <td className="muted text-xs">the bar to beat</td><td />
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// The headline, computed from the backtest file -- never hard-coded, so it
// cannot drift from the table under it.
function Findings({ bt, recent }) {
  const rows = edgesOf(bt).filter((r) => r.edge[90] != null)
  if (!rows.length) return null
  const conv = rows.find((r) => r.key === 'conviction')
  // conviction gets its own card, so the middle card is the best of the rest
  const best = rows.find((r) => r.key !== 'conviction') || rows[0], worst = rows[rows.length - 1]
  const base = (bt.baseline || []).find((b) => b.horizon === 90)
  const convSets = new Set((recent?.rows || []).filter((r) => r.signal === 'conviction').map((r) => r.groupId)).size
  return (
    <div className="grid sm:grid-cols-3 gap-2">
      {conv && (
        <div className="card p-3" style={{ borderColor: 'var(--accent)' }}>
          <div className="muted text-[11px] uppercase tracking-wide">Sharpest rule · 🎯 conviction</div>
          <div className="text-2xl font-semibold tabular-nums mt-0.5" style={{ color: retColor(conv.edge[90]) }}>{fmtPpt(conv.edge[90])}</div>
          <div className="muted text-xs">vs market at 90 days · won {Math.round(conv.hs[90].winRate * 100)}% · median {fmtPct(conv.hs[90].medianReturn)}</div>
          <p className="text-xs mt-1.5" style={{ color: 'var(--text-secondary)' }}>A box at or below the value of its packs, already rising over 30 and 60 days, 1–3 years old.
            Fired on {convSets} {convSets === 1 ? 'set' : 'sets'} in the last 180 days.</p>
        </div>
      )}
      <div className="card p-3">
        <div className="muted text-[11px] uppercase tracking-wide">{conv ? 'Next-best rule' : 'Best rule'}</div>
        <div className="text-2xl font-semibold tabular-nums mt-0.5" style={{ color: retColor(best.edge[90]) }}>{fmtPpt(best.edge[90])}</div>
        <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{best.label}</p>
      </div>
      <div className="card p-3">
        <div className="muted text-[11px] uppercase tracking-wide">Worst rule</div>
        <div className="text-2xl font-semibold tabular-nums mt-0.5" style={{ color: retColor(worst.edge[90]) }}>{fmtPpt(worst.edge[90])}</div>
        <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{worst.label}</p>
        {base && <p className="muted text-[11px] mt-1">Market itself: {fmtPct(base.medianReturn)} median over 90 days, {Math.round(base.winRate * 100)}% won.</p>}
      </div>
    </div>
  )
}

export default function Signals({ meta, game = 'Pokemon' }) {
  const [bt, setBt] = useState(null)
  const [recent, setRecent] = useState(null)
  const [sig, setSig] = useState('conviction')
  const [collapse, setCollapse] = useState(true)
  const [types, setTypes] = useState(new Set()) // empty = all types
  const [openKey, setOpenKey] = useState(null)  // expanded row
  const [sort, setSort] = useState({ key: 'date', dir: 'desc' })

  useEffect(() => {
    loadView('signals_backtest').then(setBt).catch(() => setBt({ rows: [], signals: [], baseline: [] }))
    loadView('signals_recent').then(setRecent).catch(() => setRecent({ rows: [], signals: [] }))
  }, [])

  // product types present in the data, common ones first
  const typeOptions = useMemo(() => {
    if (!recent) return []
    const present = new Set(recent.rows.map((x) => x.productType || 'Other'))
    const ordered = TYPE_ORDER.filter((t) => present.has(t))
    const extra = [...present].filter((t) => !TYPE_ORDER.includes(t)).sort()
    return [...ordered, ...extra]
  }, [recent])

  const rows = useMemo(() => {
    if (!recent) return []
    let r = recent.rows.filter((x) => sig === 'all' || x.signal === sig)
    if (types.size) r = r.filter((x) => types.has(x.productType || 'Other'))
    if (collapse) {
      // one row per set+product: the latest firing (a current watchlist,
      // not every re-fire), so the list stays short and actionable.
      const latest = new Map()
      for (const x of r) {
        const k = `${x.signal}|${x.productId}`
        const cur = latest.get(k)
        if (!cur || x.date > cur.date) latest.set(k, x)
      }
      r = [...latest.values()]
    }
    // derived, sortable change columns
    r = r.map((x) => ({
      ...x,
      priceChgPct: x.priceNow != null && x.price ? x.priceNow / x.price - 1 : null,
      premChgPp: x.premNow != null && x.prem != null ? x.premNow - x.prem : null,
    }))
    const { key, dir } = sort
    r = [...r].sort((a, b) => {
      const va = a[key], vb = b[key]
      if (va == null) return 1
      if (vb == null) return -1
      if (va < vb) return dir === 'desc' ? 1 : -1
      if (va > vb) return dir === 'desc' ? -1 : 1
      return 0
    })
    return r
  }, [recent, sig, sort, collapse, types])

  if (!bt || !recent) return <p className="muted p-4">Loading signals…</p>
  const labelOf = Object.fromEntries((bt.signals || []).map((s) => [s.key, s.label]))
  const clickSort = (k) => setSort((s) => s.key === k ? { key: k, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key: k, dir: 'desc' })
  const arrow = (k) => (sort.key === k ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : '')
  const toggleType = (t) => setTypes((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n })

  return (
    <section>
      <PageHeader title="Signals"
        question="Rules that flag a sealed product as a buy, tested on every past date — and which are firing right now.">
        <p>Each rule is checked on every historical date using only the data available that day, then scored on how the
          price moved over the next 30, 60 and 90 days. <b>vs market</b> is the gap to buying any sealed product at random
          over the same windows, which is the number that matters: in a rising market almost everything wins.</p>
        <p>Firings only count once their window has fully passed. Results cover 2024 onward, mostly a rising market;
          the Market tab&apos;s “What has worked” shows how the underlying patterns held up in the latest six months.</p>
        <p><b>Reprint window</b> and <b>long out of print</b> may be understated: sets already old when the price archive
          begins (Feb 2024) re-rated before we can see it.</p>
      </PageHeader>
      {game === 'Magic' && (
        <p className="text-xs mb-2 p-2 rounded" style={{ background: 'var(--surface-1)', color: 'var(--warn)' }}>
          ⚠ Signals cover <strong>Pokémon</strong> only — everything below is Pokémon sealed.
        </p>
      )}
      <Findings bt={bt} recent={recent} />

      <h3 className="font-semibold text-sm pt-4 pb-1">How each rule held up</h3>
      <Leaderboard bt={bt} />

      <h3 className="font-semibold text-sm pt-5 pb-1">
        {collapse ? 'Flashing now — current watchlist' : 'Recent firings (last 180 days)'}
      </h3>
      <div className="flex flex-wrap items-center gap-2 pb-2">
        <span className="seg-label">Signal</span>
        {[['conviction', 'Conviction 🎯'], ['value_rebound', 'Value + turning'], ['below_peers', 'Below peers'], ['cheap_premium', 'Cheap premium'], ['off_peak', 'Deep dip'], ['reprint_window', 'Reprint window'], ['deep_oop', 'Long OOP'], ['momentum_high', 'New high'], ['all', 'All']].map(([v, t]) => (
          <button key={v} className="chip" data-on={String(sig === v)} onClick={() => setSig(v)}>{t}</button>
        ))}
        <span className="seg-label ml-2">View</span>
        <button className="chip" data-on={String(collapse)} onClick={() => setCollapse(true)}>Latest per set</button>
        <button className="chip" data-on={String(!collapse)} onClick={() => setCollapse(false)}>All firings</button>
      </div>
      {typeOptions.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 pb-2">
          <span className="seg-label">Item type</span>
          <button className="chip" data-on={String(types.size === 0)} onClick={() => setTypes(new Set())}>All</button>
          {typeOptions.map((t) => (
            <button key={t} className="chip" data-on={String(types.has(t))} onClick={() => toggleType(t)}>{t}</button>
          ))}
        </div>
      )}
      <p className="muted text-xs max-w-4xl pb-2">
        <b>Before 30d</b> is how the price had moved before it fired; <b>After</b> columns are the outcome
        (* = window still open). Tap a row for its price chart; hover a header for its definition.
      </p>
      <div className="card p-3 overflow-x-auto">
        <table className="tbl text-sm w-full">
          <thead>
            <tr>
              {COLS.map(([k, l, t]) => (
                <th key={k} onClick={() => clickSort(k)} style={{ cursor: 'pointer' }} title={t}>{l}{arrow(k)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 200).map((r) => {
              const itemText = r.productName || r.productType || 'item'
              const rowKey = `${r.signal}|${r.productId}|${r.date}`
              const isOpen = openKey === rowKey
              const stop = (e) => e.stopPropagation()
              return (
              <Fragment key={rowKey}>
              <tr onClick={() => setOpenKey(isOpen ? null : rowKey)} style={{ cursor: 'pointer' }}
                  title="click to see the price window around this signal">
                <td className="muted whitespace-nowrap">
                  <span className="inline-block w-3" style={{ color: 'var(--accent)' }}>{isOpen ? '▾' : '▸'}</span>{r.date}
                </td>
                <td className="max-w-44 truncate">
                  <a href={`#/set/${r.groupId}`} onClick={stop} className="hover:underline" style={{ color: 'var(--accent)' }}>{r.setName}</a>
                  {sig === 'all' && <span className="muted text-xs"> · {labelOf[r.signal]?.split(' (')[0]}</span>}
                </td>
                <td className="max-w-52 truncate" title={itemText}>
                  {r.url
                    ? <a href={r.url} target="_blank" rel="noopener noreferrer" onClick={stop}
                         className="inline-flex items-center gap-1 hover:underline" style={{ color: 'var(--accent)' }}>
                        {itemText}<LinkIcon />
                      </a>
                    : <span>{itemText}</span>}
                </td>
                <td className="whitespace-nowrap">{fmtUsd(r.price)}</td>
                <td className="whitespace-nowrap">{r.priceNow != null ? fmtUsd(r.priceNow) : '—'}</td>
                <td className="whitespace-nowrap" style={{ color: retColor(r.priceChgPct) }}>
                  {r.priceChgPct != null ? fmtPct(r.priceChgPct) : '—'}
                </td>
                <td className="whitespace-nowrap">{r.prem != null ? fmtPct(r.prem) : '—'}</td>
                <td className="whitespace-nowrap">{r.premNow != null ? fmtPct(r.premNow) : '—'}</td>
                <td className="whitespace-nowrap muted">
                  {r.premChgPp != null ? `${r.premChgPp >= 0 ? '+' : ''}${(r.premChgPp * 100).toFixed(1)}pp` : '—'}
                </td>
                <td style={{ color: retColor(r.dev) }}>{r.dev != null ? fmtPct(r.dev) : '—'}</td>
                <td style={{ color: retColor(r.mom30) }}>{r.mom30 != null ? fmtPct(r.mom30) : '—'}</td>
                {H.map((h) => (
                  <td key={h} style={{ color: retColor(r[`ret${h}`]) }}>
                    {r[`ret${h}`] != null ? fmtPct(r[`ret${h}`]) : '—'}
                    {r[`mat${h}`] === false && <span className="muted text-xs" title="outcome window not elapsed">*</span>}
                  </td>
                ))}
              </tr>
              {isOpen && (
                <tr>
                  <td colSpan={COLS.length} className="p-0">
                    <div className="p-3" style={{ background: 'var(--surface-1)' }}>
                      <div className="text-xs muted pb-1">
                        {itemText} · price window around the {labelOf[r.signal]?.split(' (')[0]} signal —
                        {' '}<span style={{ color: 'var(--pos)' }}>▲</span> buy day, dashed lines = +30 / +60 / +90 outcome marks
                        (before the pip is muted, after is the outcome).
                      </div>
                      <SignalWindow path={r.path} priceAtSignal={r.price} />
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
              )
            })}
          </tbody>
        </table>
        <p className="muted text-xs pt-2">
          * forward window hasn't fully elapsed yet — return shown is “so far”. These recent, not-yet-matured
          firings are the current candidates worth a look (relative-value screens, not guaranteed wins).
        </p>
      </div>
    </section>
  )
}

import { useEffect, useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader.jsx'
import FilterBar from '../components/FilterBar.jsx'
import { loadView } from '../lib/loadView.js'
import { fmtPct, fmtUsd, eraMatch } from '../lib/slice.js'

// Default to the modern eras: legacy/vintage sets carry price-manipulation
// artifacts (e.g. a "-99%" print) that aren't real market moves.
const MODERN_ERAS = ['Sword & Shield', 'Scarlet & Violet', 'Mega Evolution']

function heatBg(v, max) {
  if (v == null || Math.abs(v) < 0.002) return 'transparent'
  const base = v > 0 ? 'var(--pos)' : 'var(--neg)'
  const pct = Math.min(Math.abs(v) / max, 1) * 58
  return `color-mix(in oklab, ${base} ${pct.toFixed(0)}%, transparent)`
}
function HeatCell({ v, max, fmt = fmtPct }) {
  if (v == null) return <td className="muted">—</td>
  return (
    <td style={{ background: heatBg(v, max), color: 'var(--text-primary)', fontWeight: Math.abs(v) > max * 0.5 ? 600 : 400 }}>
      {fmt(v)}
    </td>
  )
}
const HEAT_MAX = { chg1: 0.08, chg7: 0.18, chg30: 0.35, chg90: 0.7, premChg30: 0.3, premChg7: 0.2, askFloorChg30: 0.35 }
// askFloor is a ratio (1.05 = cheapest ask 5% ABOVE market), not a percentage.
const fmtRatio = (v) => (v == null ? '—' : v.toFixed(2))
const fmtRatioDelta = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}`)

// Sortable columns. `abs` sorts by magnitude (biggest move either way);
// `dir` is the default direction on first click.
const COLS = [
  { key: 'name', label: 'Product', num: false },
  { key: 'setName', label: 'Set', num: false },
  { key: 'productType', label: 'Type', num: false },
  { key: 'ageDays', label: 'Age', num: true, dir: 'desc', fmt: (v) => (v != null ? `${v}d` : '—') },
  { key: 'price', label: 'Price', num: true, dir: 'desc', fmt: fmtUsd },
  { key: 'chg1', label: '1d', num: true, dir: 'desc', abs: true, heat: 'chg1' },
  { key: 'chg7', label: '7d', num: true, dir: 'desc', abs: true, heat: 'chg7' },
  { key: 'chg30', label: '30d', num: true, dir: 'desc', abs: true, heat: 'chg30' },
  { key: 'chg90', label: '90d', num: true, dir: 'desc', abs: true, heat: 'chg90' },
  { key: 'premiumPct', label: 'Premium', num: true, dir: 'desc', fmt: (v) => (v != null ? fmtPct(v) : '—') },
  { key: 'premChg30', label: 'Δ30d prem', num: true, dir: 'desc', abs: true, heat: 'premChg30' },
  { key: 'askFloor', label: 'Ask floor', num: true, dir: 'desc', fmt: fmtRatio,
    title: 'Cheapest ask ÷ market price. Above 1.00 = nobody undercutting (thin supply); below 0.85 = sellers undercutting each other (glut). A proxy, not a listing count.' },
  { key: 'askFloorChg30', label: 'Δ30d supply', num: true, dir: 'desc', abs: true, heat: 'askFloorChg30', heatFmt: fmtRatioDelta,
    title: '30-day change in ask floor. Positive = supply tightening (undercutting drying up); negative = supply building.' },
]

export default function Screener({ meta, game = 'Pokemon' }) {
  const [data, setData] = useState(null)
  const [state, setState] = useState(() => ({
    eras: game === 'Pokemon' ? MODERN_ERAS : [],
    seriesType: meta.seriesTypes?.[0] || 'Booster Box', hype: 'all',
  }))
  const [mode, setMode] = useState('movers') // movers | shelf
  const [kind, setKind] = useState('sealed') // sealed | chase
  const [sort, setSort] = useState({ key: 'chg7', dir: 'desc', abs: true })

  useEffect(() => { loadView('movers').then(setData) }, [])

  // groupIds of the active game (meta is already game-scoped by App)
  const gameIds = useMemo(() => new Set(meta.sets.map((s) => s.groupId)), [meta])

  // Preset the default sort when switching mode.
  useEffect(() => {
    if (mode === 'shelf') setSort({ key: 'chg90', dir: 'asc', abs: false })
    else setSort({ key: 'chg7', dir: 'desc', abs: true })
  }, [mode])

  const clickSort = (col) => {
    if (!col.num && col.key !== 'name' && col.key !== 'setName' && col.key !== 'productType') return
    setSort((s) => s.key === col.key
      ? { ...s, dir: s.dir === 'desc' ? 'asc' : 'desc' }
      : { key: col.key, dir: col.dir || 'asc', abs: !!col.abs })
  }

  const rows = useMemo(() => {
    if (!data) return []
    let rows = data.rows.filter((r) => {
      if (!gameIds.has(r.groupId)) return false
      if (kind === 'sealed' ? r.isChase : !r.isChase) return false
      if (!eraMatch(r.era, state.eras)) return false
      if (state.hype === 'hype' && !r.isHype) return false
      if (state.hype === 'clean' && r.isHype) return false
      if (kind === 'sealed' && state.seriesType !== 'All' && state.seriesType !== 'Chase Singles'
          && r.productType !== state.seriesType) return false
      return true
    })
    if (mode === 'shelf') {
      // "Sitting on shelves": aging sealed product, flat/declining price.
      rows = rows.filter((r) => (r.ageDays ?? 0) > 90 && r.chg30 != null && r.chg30 <= 0.005)
    }
    const { key, dir, abs } = sort
    const val = (r) => {
      const v = r[key]
      if (v == null) return dir === 'desc' ? -Infinity : Infinity
      if (typeof v === 'string') return v.toLowerCase()
      return abs ? Math.abs(v) : v
    }
    rows = [...rows].sort((a, b) => {
      const va = val(a), vb = val(b)
      if (va < vb) return dir === 'desc' ? 1 : -1
      if (va > vb) return dir === 'desc' ? -1 : 1
      return 0
    })
    return rows.slice(0, 150)
  }, [data, state, mode, kind, sort, gameIds])

  const arrow = (k) => (sort.key === k ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : '')

  if (!data) return <p className="muted p-4">Loading movers…</p>
  return (
    <section>
      <PageHeader title="Screener"
        question="Every product's recent price and premium moves — click a column to sort; change columns sort by the biggest move either way.">
        <p><b>Sitting on shelves</b> = 90+ days old with a flat or falling price.</p>
        <p><b>Ask floor</b> = cheapest listing ÷ market price, a proxy for supply (TCGplayer publishes no listing counts).
          Below <b>0.90</b>, sellers are undercutting and you can usually buy under the market price. Above <b>1.00</b>, nobody
          is undercutting — but you pay that ask, and the market price tends to catch up to it rather than run past it,
          so a high ask floor is not a buy signal by itself. <b>Δ30d supply</b> rising = undercutting drying up.</p>
        <p>Ask floors outside 0.2–2.5× market are hidden: those mean the market price is stale (common on illiquid vintage).</p>
      </PageHeader>
      <div className="flex flex-wrap items-center gap-2 py-2">
        {[['movers', 'All movers'], ['shelf', 'Sitting on shelves']].map(([v, t]) => (
          <button key={v} className="chip" data-on={String(mode === v)} onClick={() => setMode(v)}>{t}</button>
        ))}
        <span className="mx-1 muted">·</span>
        {[['sealed', 'Sealed'], ['chase', 'Chase singles']].map(([v, t]) => (
          <button key={v} className="chip" data-on={String(kind === v)} onClick={() => setKind(v)}>{t}</button>
        ))}
      </div>
      <FilterBar meta={meta} state={state} setState={setState}
        show={{ completeness: false, seriesType: kind === 'sealed' }} />
      <div className="card p-3 overflow-x-auto">
        <table className="tbl text-sm w-full">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.key} onClick={() => clickSort(c)} style={{ cursor: 'pointer', userSelect: 'none' }}
                  title={c.title ? `${c.title}\n\n(click to sort)` : 'click to sort'}>{c.label}{arrow(c.key)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.productId}>
                <td className="max-w-64 truncate" title={r.name}>
                  <a href={`#/set/${r.groupId}`} className="hover:underline" style={{ color: 'var(--accent)' }}>{r.name}</a>
                  {r.conf === 'low' && <span title="low-confidence intrinsic value" style={{ color: 'var(--warn)' }}> *</span>}
                </td>
                <td className="max-w-40 truncate">
                  <a href={`#/set/${r.groupId}`} className="hover:underline muted">{r.setName}</a>{r.isHype ? ' 🔥' : ''}
                </td>
                <td className="muted">{r.isChase ? 'Chase' : r.productType}</td>
                <td className="muted">{r.ageDays != null ? `${r.ageDays}d` : '—'}</td>
                <td>{fmtUsd(r.price)}</td>
                <HeatCell v={r.chg1} max={HEAT_MAX.chg1} />
                <HeatCell v={r.chg7} max={HEAT_MAX.chg7} />
                <HeatCell v={r.chg30} max={HEAT_MAX.chg30} />
                <HeatCell v={r.chg90} max={HEAT_MAX.chg90} />
                <td>{r.premiumPct != null ? fmtPct(r.premiumPct) : <span className="muted">—</span>}</td>
                <HeatCell v={r.premChg30} max={HEAT_MAX.premChg30} />
                <td>{fmtRatio(r.askFloor)}</td>
                <HeatCell v={r.askFloorChg30} max={HEAT_MAX.askFloorChg30} fmt={fmtRatioDelta} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { loadView } from '../lib/loadView.js'
import { fmtPct, fmtUsd } from '../lib/slice.js'

const H = [30, 60, 90]

// [sortKey, header, hover-definition]
const COLS = [
  ['date', 'Date', 'Date the signal first fired (uses only data available up to that day)'],
  ['setName', 'Set', 'Pokémon set — opens the set detail page'],
  ['productName', 'Item', 'The specific sealed product — click to open its TCGplayer page'],
  ['price', 'Price @ signal', 'Market price on the day the signal fired'],
  ['priceNow', 'Price now', 'Latest market price, with % change since the signal fired'],
  ['prem', 'Premium @ signal', 'Sealed premium when it fired = box price ÷ value of the packs inside − 1. Negative = box is cheaper than its own contents.'],
  ['premNow', 'Premium now', 'Latest sealed premium, with its change in percentage points since the signal'],
  ['dev', 'vs peers', 'Premium minus the same-day median premium of non-hype sets of the same product type. More negative = cheaper than its peers.'],
  ['mom30', '30d trend', 'Price momentum over the 30 days before the signal — the “turning up” part of the conviction rule'],
  ['ret30', '30d', 'Forward price return 30 days after the signal (* = outcome window not fully elapsed yet)'],
  ['ret60', '60d', 'Forward price return 60 days after the signal (* = window not fully elapsed)'],
  ['ret90', '90d', 'Forward price return 90 days after the signal (* = window not fully elapsed)'],
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

// Backtest leaderboard: each signal's win rate + median forward return vs
// the unconditional baseline (the market drift to beat).
function Leaderboard({ bt }) {
  const base = Object.fromEntries((bt.baseline || []).map((b) => [b.horizon, b]))
  const bySig = {}
  for (const r of bt.rows) (bySig[r.signal] ||= {})[r.horizon] = r
  const labelOf = Object.fromEntries(bt.signals.map((s) => [s.key, s.label]))
  const order = ['conviction', 'value_rebound', 'below_peers', 'cheap_premium', 'off_peak',
                 'reprint_window', 'deep_oop', 'momentum_high']
  return (
    <div className="card p-3 overflow-x-auto">
      <table className="tbl text-sm w-full">
        <thead>
          <tr>
            <th>Signal</th>
            {H.map((h) => <th key={h} colSpan={2} style={{ textAlign: 'center' }}>{h}-day forward</th>)}
          </tr>
          <tr>
            <th></th>
            {H.map((h) => [
              <th key={`${h}w`}>win%</th>,
              <th key={`${h}m`}>median · vs mkt</th>,
            ])}
          </tr>
        </thead>
        <tbody>
          {order.filter((k) => bySig[k]).map((k) => (
            <tr key={k}>
              <td className="max-w-72 whitespace-normal">{labelOf[k]}</td>
              {H.map((h) => {
                const r = bySig[k][h], b = base[h]
                if (!r) return [<td key={h} className="muted">—</td>, <td key={h + 'x'} className="muted">—</td>]
                const edge = b ? r.medianReturn - b.medianReturn : null
                return [
                  <td key={`${h}w`}>{(r.winRate * 100).toFixed(0)}%</td>,
                  <td key={`${h}m`}>
                    <span style={{ color: retColor(r.medianReturn) }}>{fmtPct(r.medianReturn)}</span>
                    {edge != null && (
                      <span className="muted"> · <span style={{ color: retColor(edge) }}>{fmtPct(edge)}</span></span>
                    )}
                    <span className="muted text-xs"> ({r.n})</span>
                  </td>,
                ]
              })}
            </tr>
          ))}
          <tr style={{ borderTop: '2px solid var(--border-strong)' }}>
            <td className="muted italic">Baseline — buy any sealed at random</td>
            {H.map((h) => {
              const b = base[h]
              return b
                ? [<td key={h} className="muted">{(b.winRate * 100).toFixed(0)}%</td>,
                   <td key={h + 'm'} className="muted">{fmtPct(b.medianReturn)}</td>]
                : [<td key={h} className="muted">—</td>, <td key={h + 'x'} className="muted">—</td>]
            })}
          </tr>
        </tbody>
      </table>
    </div>
  )
}

export default function Signals({ meta }) {
  const [bt, setBt] = useState(null)
  const [recent, setRecent] = useState(null)
  const [sig, setSig] = useState('conviction')
  const [collapse, setCollapse] = useState(true)
  const [sort, setSort] = useState({ key: 'date', dir: 'desc' })

  useEffect(() => {
    loadView('signals_backtest').then(setBt).catch(() => setBt({ rows: [], signals: [], baseline: [] }))
    loadView('signals_recent').then(setRecent).catch(() => setRecent({ rows: [], signals: [] }))
  }, [])

  const rows = useMemo(() => {
    if (!recent) return []
    let r = recent.rows.filter((x) => sig === 'all' || x.signal === sig)
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
  }, [recent, sig, sort, collapse])

  if (!bt || !recent) return <p className="muted p-4">Loading signals…</p>
  const labelOf = Object.fromEntries((bt.signals || []).map((s) => [s.key, s.label]))
  const clickSort = (k) => setSort((s) => s.key === k ? { key: k, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key: k, dir: 'desc' })
  const arrow = (k) => (sort.key === k ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : '')

  return (
    <section>
      <h2 className="text-lg font-semibold">Buy signals — backtested</h2>
      <p className="subtle text-sm max-w-4xl">
        Each rule is fired at every historical date (using only data available then), and the
        forward <strong>price return</strong> at 30/60/90 days is measured. “vs mkt” is the edge over
        the <em>baseline</em> — buying any sealed at random over the same period.
      </p>
      <div className="card p-3 mt-2 max-w-4xl" style={{ borderColor: 'var(--accent)' }}>
        <p className="text-sm">
          🎯 <strong>The conviction signal.</strong> I profiled what the biggest 90-day winners looked like
          <em> before</em> they ran. The rare, repeatable pattern: a box priced <strong>at or below the pack value
          inside it</strong> (absolute cheapness — stronger than cheap-vs-peers), whose price is <strong>already
          turning up over both 30 and 60 days</strong> (not still falling), in the <strong>1–3 year</strong> window
          where launch supply has cleared and printing is winding down. It fires rarely
          (~{recent?.rows ? new Set(recent.rows.filter((r) => r.signal === 'conviction').map((r) => r.groupId)).size : 8} sets
          in the last 180 days) and, in backtest, hit <strong>96% win / +25% median at 90 days — a +14pp edge</strong> over
          buy-anything, with 23% turning into +44%+ winners.
        </p>
      </div>

      <h3 className="font-semibold text-sm pt-3 pb-1">How the hypotheses held up</h3>
      <Leaderboard bt={bt} />
      <div className="text-xs muted max-w-4xl pt-2 space-y-1.5">
        <p>
          ⚠ <strong>Read this honestly:</strong> 2024–2026 was a strong bull market for sealed, so the baseline itself
          won ~77% at 90 days — nearly everything went up. What matters is the <em>edge over that baseline</em> (“vs mkt”).
        </p>
        <p>
          • <strong>“Conviction”</strong> is the sharpest rule (box ≤ pack value + 30/60d momentum up + 1–3yr): 96% win,
          +25% median at 90d, +14pp edge — and it fires rarely. <strong>“Value + turning up”</strong> is its looser cousin
          (cheap-vs-peers instead of ≤ pack value — your Stellar Crown pattern): a smaller but consistent +1–2pp edge that
          fires far more often.
        </p>
        <p>
          • <strong>Cheap-vs-peers / cheap-premium</strong> roughly matched the market (≈0 edge); <strong>buying deep price
          dips actively lost</strong> ~9pp at 90d — those corrections kept correcting. <strong>Buying new highs (momentum)</strong>
          didn’t beat the market but, unlike dips, didn’t lose — strength ≥ weakness.
        </p>
        <p>
          • <strong>The reprint-window hypothesis didn’t pay here.</strong> Buying a set purely because it crossed
          ~18 months (<em>reprint window</em>) slightly <em>underperformed</em> buy-anything (−1 to −2pp); ~24-month
          “long out of print” only matched it. Two honest reasons: the scarcity premium looks largely priced in already,
          and this lake starts Feb 2024 — sets already old by then had their out-of-print re-rating <em>before</em> we can
          observe it, so we may be catching them late. The reprint edge, if it exists, needs the run-up captured live.
        </p>
        <p className="pt-0.5">The true test of all of these is a flat/down market, which this data doesn’t yet contain.</p>
      </div>

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
            {rows.slice(0, 200).map((r, i) => {
              const priceChg = r.priceNow != null && r.price ? r.priceNow / r.price - 1 : null
              const premChg = r.premNow != null && r.prem != null ? r.premNow - r.prem : null // percentage points
              const itemText = r.productName || r.productType || 'item'
              return (
              <tr key={i}>
                <td className="muted whitespace-nowrap">{r.date}</td>
                <td className="max-w-44 truncate">
                  <a href={`#/set/${r.groupId}`} className="hover:underline" style={{ color: 'var(--accent)' }}>{r.setName}</a>
                  {sig === 'all' && <span className="muted text-xs"> · {labelOf[r.signal]?.split(' (')[0]}</span>}
                </td>
                <td className="max-w-52 truncate" title={itemText}>
                  {r.url
                    ? <a href={r.url} target="_blank" rel="noopener noreferrer"
                         className="inline-flex items-center gap-1 hover:underline" style={{ color: 'var(--accent)' }}>
                        {itemText}<LinkIcon />
                      </a>
                    : <span>{itemText}</span>}
                </td>
                <td className="whitespace-nowrap">{fmtUsd(r.price)}</td>
                <td className="whitespace-nowrap">
                  {r.priceNow != null ? fmtUsd(r.priceNow) : '—'}
                  {priceChg != null && <span className="text-xs" style={{ color: retColor(priceChg) }}> {fmtPct(priceChg)}</span>}
                </td>
                <td className="whitespace-nowrap">{r.prem != null ? fmtPct(r.prem) : '—'}</td>
                <td className="whitespace-nowrap">
                  {r.premNow != null ? fmtPct(r.premNow) : '—'}
                  {premChg != null && <span className="text-xs muted"> {premChg >= 0 ? '+' : ''}{(premChg * 100).toFixed(1)}pp</span>}
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

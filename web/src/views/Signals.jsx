import { useEffect, useMemo, useState } from 'react'
import { loadView } from '../lib/loadView.js'
import { fmtPct, fmtUsd } from '../lib/slice.js'

const H = [30, 60, 90]

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
  const order = ['value_rebound', 'below_peers', 'cheap_premium', 'off_peak']
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
  const [sig, setSig] = useState('value_rebound')
  const [sort, setSort] = useState({ key: 'date', dir: 'desc' })

  useEffect(() => {
    loadView('signals_backtest').then(setBt).catch(() => setBt({ rows: [], signals: [], baseline: [] }))
    loadView('signals_recent').then(setRecent).catch(() => setRecent({ rows: [], signals: [] }))
  }, [])

  const rows = useMemo(() => {
    if (!recent) return []
    let r = recent.rows.filter((x) => sig === 'all' || x.signal === sig)
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
  }, [recent, sig, sort])

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

      <h3 className="font-semibold text-sm pt-3 pb-1">How the hypotheses held up</h3>
      <Leaderboard bt={bt} />
      <p className="text-xs muted max-w-4xl pt-2">
        ⚠ <strong>Read this honestly:</strong> 2024–2026 was a strong bull market for sealed, so the baseline itself
        won ~77% at 90 days — nearly everything went up. <strong>Cheap-vs-peers alone barely beat the market</strong>;
        <strong> buying price dips (“deep dip”) actively lost</strong> ~9pp — those corrections kept correcting.
        Only <strong>“value + turning up”</strong> (cheap <em>and</em> premium already recovering — your Stellar Crown
        pattern) showed a real edge (+5pp win rate). The true test is a flat/down market, which this data doesn't yet contain.
      </p>

      <h3 className="font-semibold text-sm pt-5 pb-1">Recent firings (last 180 days)</h3>
      <div className="flex flex-wrap items-center gap-2 pb-2">
        <span className="seg-label">Signal</span>
        {[['value_rebound', 'Value + turning'], ['below_peers', 'Below peers'], ['cheap_premium', 'Cheap premium'], ['off_peak', 'Deep dip'], ['all', 'All']].map(([v, t]) => (
          <button key={v} className="chip" data-on={String(sig === v)} onClick={() => setSig(v)}>{t}</button>
        ))}
      </div>
      <div className="card p-3 overflow-x-auto">
        <table className="tbl text-sm w-full">
          <thead>
            <tr>
              {[['date', 'Date'], ['setName', 'Set'], ['productType', 'Type'], ['price', 'Price @ signal'],
                ['prem', 'Premium'], ['dev', 'vs peers'], ['ret30', '30d'], ['ret60', '60d'], ['ret90', '90d']].map(([k, l]) => (
                <th key={k} onClick={() => clickSort(k)} style={{ cursor: 'pointer' }}>{l}{arrow(k)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 200).map((r, i) => (
              <tr key={i}>
                <td className="muted">{r.date}</td>
                <td className="max-w-52 truncate">
                  <a href={`#/set/${r.groupId}`} className="hover:underline" style={{ color: 'var(--accent)' }}>{r.setName}</a>
                  {sig === 'all' && <span className="muted text-xs"> · {labelOf[r.signal]?.split(' (')[0]}</span>}
                </td>
                <td className="muted">{r.productType}</td>
                <td>{fmtUsd(r.price)}</td>
                <td>{r.prem != null ? fmtPct(r.prem) : '—'}</td>
                <td style={{ color: retColor(r.dev) }}>{r.dev != null ? fmtPct(r.dev) : '—'}</td>
                {H.map((h) => (
                  <td key={h} style={{ color: retColor(r[`ret${h}`]) }}>
                    {r[`ret${h}`] != null ? fmtPct(r[`ret${h}`]) : '—'}
                    {r[`mat${h}`] === false && <span className="muted text-xs" title="outcome window not elapsed">*</span>}
                  </td>
                ))}
              </tr>
            ))}
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

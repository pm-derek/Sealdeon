import { useEffect, useMemo, useState } from 'react'
import FilterBar from '../components/FilterBar.jsx'
import { loadView } from '../lib/loadView.js'
import { fmtPct, fmtUsd } from '../lib/slice.js'

const HORIZONS = [['chg1', '1d'], ['chg7', '7d'], ['chg30', '30d'], ['chg90', '90d']]

function Chg({ v }) {
  if (v == null) return <span className="muted">—</span>
  const color = v > 0.001 ? 'var(--pos)' : v < -0.001 ? 'var(--neg)' : 'var(--text-muted)'
  return <span style={{ color }}>{fmtPct(v)}</span>
}

export default function Screener({ meta }) {
  const [data, setData] = useState(null)
  const [state, setState] = useState({ era: 'All', seriesType: 'Booster Box', hype: 'all', completeness: 'all' })
  const [horizon, setHorizon] = useState('chg7')
  const [mode, setMode] = useState('movers') // movers | premium | shelf
  const [kind, setKind] = useState('sealed') // sealed | chase

  useEffect(() => { loadView('movers').then(setData) }, [])

  const rows = useMemo(() => {
    if (!data) return []
    let rows = data.rows.filter((r) => {
      if (kind === 'sealed' ? r.isChase : !r.isChase) return false
      if (state.era !== 'All' && r.era !== state.era) return false
      if (state.hype === 'hype' && !r.isHype) return false
      if (state.hype === 'clean' && r.isHype) return false
      if (state.completeness === 'complete' && !r.archiveComplete) return false
      if (kind === 'sealed' && state.seriesType !== 'All' && state.seriesType !== 'Chase Singles'
          && r.productType !== state.seriesType) return false
      return true
    })
    if (mode === 'shelf') {
      // "Sitting on shelves": aging sealed product whose price is flat or
      // declining -- overproduction / soft-demand detector.
      rows = rows.filter((r) => (r.ageDays ?? 0) > 90 && r.chg30 != null && r.chg30 <= 0.005)
      rows.sort((a, b) => (a.chg90 ?? 0) - (b.chg90 ?? 0))
    } else if (mode === 'premium') {
      rows = rows.filter((r) => r.premChg30 != null)
      rows.sort((a, b) => Math.abs(b.premChg30 ?? 0) - Math.abs(a.premChg30 ?? 0))
    } else {
      rows = rows.filter((r) => r[horizon] != null)
      rows.sort((a, b) => Math.abs(b[horizon]) - Math.abs(a[horizon]))
    }
    return rows.slice(0, 100)
  }, [data, state, horizon, mode, kind])

  if (!data) return <p className="muted p-4">Loading movers…</p>
  return (
    <section>
      <h2 className="text-lg font-semibold">Screener — movers &amp; notable changes</h2>
      <p className="subtle text-sm">
        Biggest price and sealed-premium swings off the daily snapshot cadence.
        Listing/sales volume is <span title={data.volumeMetrics.reason}>pending a data source</span>
        {' '}— price fluctuation covers spot-deviation needs in v1.
      </p>
      <div className="flex items-center gap-2 py-2">
        {[['movers', 'Price movers'], ['premium', 'Premium swings'], ['shelf', 'Sitting on shelves']].map(([v, t]) => (
          <button key={v} className="chip" data-on={String(mode === v)} onClick={() => setMode(v)}>{t}</button>
        ))}
        <span className="mx-2 muted">·</span>
        {[['sealed', 'Sealed'], ['chase', 'Chase singles']].map(([v, t]) => (
          <button key={v} className="chip" data-on={String(kind === v)} onClick={() => setKind(v)}>{t}</button>
        ))}
        {mode === 'movers' && (
          <>
            <span className="mx-2 muted">·</span>
            {HORIZONS.map(([v, t]) => (
              <button key={v} className="chip" data-on={String(horizon === v)} onClick={() => setHorizon(v)}>{t}</button>
            ))}
          </>
        )}
      </div>
      <FilterBar meta={meta} state={state} setState={setState}
        show={{ metric: false, xUnit: false, seriesType: kind === 'sealed' }} />
      <div className="card p-3 overflow-x-auto">
        <table className="tbl text-sm w-full">
          <thead>
            <tr>
              <th>Product</th><th>Set</th><th>Type</th><th>Age</th><th>Price</th>
              <th>1d</th><th>7d</th><th>30d</th><th>90d</th>
              <th>Premium</th><th>Δ30d prem</th>
              <th className="muted" title={data.volumeMetrics.reason}>Listed*</th>
              <th className="muted" title={data.volumeMetrics.reason}>Sold*</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.productId}>
                <td className="max-w-64 truncate" title={r.name}>
                  <a href={`#/set/${r.groupId}`} className="hover:underline">{r.name}</a>
                  {r.conf === 'low' && <span title="low-confidence intrinsic value" style={{ color: 'var(--warn)' }}> *</span>}
                </td>
                <td className="muted max-w-40 truncate">{r.setName}{r.isHype ? ' 🔥' : ''}</td>
                <td className="muted">{r.isChase ? 'Chase' : r.productType}</td>
                <td className="muted">{r.ageDays != null ? `${r.ageDays}d` : '—'}</td>
                <td>{fmtUsd(r.price)}</td>
                <td><Chg v={r.chg1} /></td><td><Chg v={r.chg7} /></td>
                <td><Chg v={r.chg30} /></td><td><Chg v={r.chg90} /></td>
                <td>{r.premiumPct != null ? fmtPct(r.premiumPct) : <span className="muted">—</span>}</td>
                <td><Chg v={r.premChg30} /></td>
                <td className="muted">—</td><td className="muted">—</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted text-xs pt-2">
          * qtyListed / qtySold are schema-ready but unpopulated: no free, ToS-compliant
          source exists. They light up if a paid feed (TCGplayer API / TCGAPIs) is added.
        </p>
      </div>
    </section>
  )
}

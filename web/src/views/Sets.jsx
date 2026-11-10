import { useEffect, useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader.jsx'
import { loadView } from '../lib/loadView.js'
import { fmtPct, seriesStats } from '../lib/slice.js'

// Every set at a glance: what its headline products cost now, how they have
// moved, and how far they sit from their settled (days 30-59) price. Rows open
// the set's own page.

const MODERN_POKEMON = ['Mega Evolution', 'Scarlet & Violet', 'Sword & Shield']
const fmtPx = (v) => (v == null ? '—' : `$${v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(0)}`)
const tone = (v) => (v == null ? 'var(--text-muted)' : v > 0.005 ? 'var(--pos)' : v < -0.005 ? 'var(--neg)' : 'var(--text-secondary)')

function Pct({ v, digits = 0 }) {
  return <span className="tabular-nums" style={{ color: tone(v) }}>{v == null ? '—' : fmtPct(v, digits)}</span>
}

export default function Sets({ meta, game = 'Pokemon' }) {
  const [curves, setCurves] = useState(null)
  const [query, setQuery] = useState('')
  const [eras, setEras] = useState(game === 'Pokemon' ? MODERN_POKEMON : [])
  const [showSpecial, setShowSpecial] = useState(false)
  const [sort, setSort] = useState({ key: 'releaseDate', dir: -1 })

  useEffect(() => { loadView('cohort_curves').then(setCurves) }, [])

  // the two headline product types for this game (Booster Box + ETB, or the
  // two main Magic boxes), plus the chase basket where the game has one
  const [t1, t2] = meta.seriesTypes || []
  const hasChase = (meta.seriesTypes || []).includes('Chase Singles')
  const allEras = useMemo(() => {
    const e = [...new Set(meta.sets.map((s) => s.era).filter(Boolean))]
    return game === 'Pokemon' ? e.filter((x) => x !== 'Special/Promo') : e.sort().reverse()
  }, [meta, game])

  const rows = useMemo(() => {
    if (!curves) return []
    const byKey = new Map(curves.series.map((s) => [`${s.groupId}|${s.seriesType}`, s]))
    const q = query.trim().toLowerCase()
    return meta.sets
      .filter((s) => (showSpecial || s.era !== 'Special/Promo'))
      .filter((s) => q ? (s.name?.toLowerCase().includes(q) || s.abbreviation?.toLowerCase().includes(q))
                       : (eras.length === 0 || eras.includes(s.era)))
      .map((s) => {
        const a = seriesStats(byKey.get(`${s.groupId}|${t1}`))
        const b = seriesStats(byKey.get(`${s.groupId}|${t2}`))
        const c = hasChase ? seriesStats(byKey.get(`${s.groupId}|Chase Singles`)) : null
        return { ...s, a, b, c, aNow: a?.now, a90: a?.chg90, aSet: a?.vsSettled, aPrem: a?.prem, bNow: b?.now, b90: b?.chg90, cNow: c?.now, c90: c?.chg90 }
      })
      // a set with nothing priced has nothing to show unless it was searched
      // for; nor does a card-only set whose best cards are pocket change
      // (basic-energy sets)
      .filter((r) => q || r.a || r.b || (r.c && r.cNow >= 20))
  }, [curves, meta, query, eras, showSpecial, t1, t2, hasChase])

  const sorted = useMemo(() => {
    const k = sort.key
    return [...rows].sort((x, y) => {
      const a = x[k], b = y[k]
      if (a == null && b == null) return 0
      if (a == null) return 1
      if (b == null) return -1
      return (a > b ? 1 : a < b ? -1 : 0) * sort.dir
    })
  }, [rows, sort])

  const toggleEra = (e) => setEras((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]))
  const Th = ({ k, children, title, right = true }) => (
    <th className={`whitespace-nowrap cursor-pointer select-none ${right ? 'text-right' : ''}`} title={title}
      onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? -s.dir : k === 'name' ? 1 : -1 }))}
      aria-sort={sort.key === k ? (sort.dir > 0 ? 'ascending' : 'descending') : undefined}>
      {children}{sort.key === k ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''}
    </th>
  )

  return (
    <section>
      <PageHeader title="Sets"
        question={`Every set's headline products: price now, recent moves, and where they sit against their settled price. Tap a set for its page.`}>
        <p><b>vs settled</b> compares today's price with the median over days 30–59 after release — the point where launch hype has
          mostly worn off. It is blank for sets released before the price archive begins (Feb 2024).</p>
        <p><b>Premium</b> is the sealed price versus the value of the packs inside it.</p>
        <p>Click any column header to sort. Promo and special collections are hidden by default; searching shows everything.</p>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-3">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search all sets…"
          className="field w-56" aria-label="Search sets" />
        <div className="seg">
          <span className="seg-label">Era</span>
          <button className="chip" data-on={String(eras.length === 0)} onClick={() => setEras([])}>All</button>
          {allEras.map((e) => (
            <button key={e} className="chip" data-on={String(eras.includes(e))} onClick={() => toggleEra(e)}>{e}</button>
          ))}
        </div>
        {game === 'Pokemon' && (
          <label className="inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={showSpecial} onChange={(e) => setShowSpecial(e.target.checked)} />
            Include promos &amp; specials
          </label>
        )}
        <span className="muted text-xs ml-auto">{sorted.length} sets</span>
      </div>

      {!curves ? <p className="muted">Loading…</p> : (
        <div className="card overflow-x-auto">
          <table className="tbl text-sm w-full">
            <thead>
              <tr>
                <Th k="name" right={false}>Set</Th>
                <Th k="releaseDate" right={false}>Released</Th>
                <Th k="aNow" title={`${t1} price now`}>{t1}</Th>
                <Th k="a90" title={`${t1}: change over 90 days`}>90d</Th>
                <Th k="aSet" title={`${t1}: today vs its settled price (median of days 30–59)`}>vs settled</Th>
                <Th k="aPrem" title={`${t1}: price vs the value of its packs`}>Premium</Th>
                {t2 && <Th k="bNow" title={`${t2} price now`}>{t2}</Th>}
                {t2 && <Th k="b90" title={`${t2}: change over 90 days`}>90d</Th>}
                {hasChase && <Th k="cNow" title="Total value of the set's top 5 singles">Top 5 cards</Th>}
                {hasChase && <Th k="c90" title="Top 5 cards: change over 90 days">90d</Th>}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.groupId}>
                  <td className="max-w-80">
                    <a href={`#/set/${r.groupId}`} className="hover:underline font-medium" style={{ color: 'var(--accent)' }}>{r.name}</a>
                    {r.isHype && <span title={`hype set (${r.hypeSource})`}> 🔥</span>}
                    {!r.archiveComplete && <span className="muted text-xs" title="released before the price archive began"> · partial history</span>}
                  </td>
                  <td className="muted whitespace-nowrap">{r.releaseDate ?? '—'}</td>
                  <td className="text-right tabular-nums">{fmtPx(r.aNow)}</td>
                  <td className="text-right"><Pct v={r.a90} /></td>
                  <td className="text-right"><Pct v={r.aSet} /></td>
                  <td className="text-right"><Pct v={r.aPrem} /></td>
                  {t2 && <td className="text-right tabular-nums">{fmtPx(r.bNow)}</td>}
                  {t2 && <td className="text-right"><Pct v={r.b90} /></td>}
                  {hasChase && <td className="text-right tabular-nums">{fmtPx(r.cNow)}</td>}
                  {hasChase && <td className="text-right"><Pct v={r.c90} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
          {sorted.length === 0 && <p className="muted p-4 text-sm">No sets match. Try another era, or search by name.</p>}
        </div>
      )}
    </section>
  )
}

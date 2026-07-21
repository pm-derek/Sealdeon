import { useEffect, useState } from 'react'
import { loadMeta } from './lib/loadView.js'
import CohortCurves from './views/CohortCurves.jsx'
import AgeBandMedians from './views/AgeBandMedians.jsx'
import SetDetail from './views/SetDetail.jsx'
import Screener from './views/Screener.jsx'
import PremiumVsMedian from './views/PremiumVsMedian.jsx'

// Tiny hash router: #/cohort, #/bands, #/screener, #/premium, #/sets, #/set/{groupId}
function useRoute() {
  const [hash, setHash] = useState(window.location.hash || '#/cohort')
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || '#/cohort')
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  const parts = hash.replace(/^#\//, '').split('/')
  return { page: parts[0] || 'cohort', param: parts[1] }
}

const NAV = [
  ['cohort', 'Cohort Curves'],
  ['bands', 'Age-Band Medians'],
  ['screener', 'Screener'],
  ['premium', 'Premium vs Median'],
  ['sets', 'Sets'],
]

function SetList({ meta }) {
  const [query, setQuery] = useState('')
  const q = query.toLowerCase()
  const rows = meta.sets.filter(
    (s) => !q || s.name?.toLowerCase().includes(q) || s.abbreviation?.toLowerCase().includes(q),
  )
  return (
    <section>
      <h2 className="text-lg font-semibold pb-2">Sets</h2>
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="filter sets…"
        className="card px-2 py-1 text-sm w-64 mb-3" />
      <div className="card p-3 overflow-x-auto">
        <table className="tbl text-sm w-full">
          <thead>
            <tr><th>Set</th><th>Abbr</th><th>Released</th><th>Era</th><th>History</th><th>Hype</th></tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.groupId}>
                <td><a href={`#/set/${s.groupId}`} className="hover:underline">{s.name}</a></td>
                <td className="muted">{s.abbreviation}</td>
                <td className="muted">{s.releaseDate ?? '—'}</td>
                <td className="muted">{s.era}</td>
                <td className="muted">{s.archiveComplete ? 'complete' : 'partial'}</td>
                <td>{s.isHype ? `🔥 (${s.hypeSource})` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default function App() {
  const [meta, setMeta] = useState(null)
  const [error, setError] = useState(null)
  const { page, param } = useRoute()

  useEffect(() => { loadMeta().then(setMeta).catch((e) => setError(e.message)) }, [])

  if (error) {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <h1 className="text-xl font-semibold">Sealdeon</h1>
        <p className="mt-4" style={{ color: 'var(--neg)' }}>
          Could not load view data ({error}). The pipeline hasn't published
          <code className="mx-1">web/public/views/</code> yet — run the backfill workflow first.
        </p>
      </div>
    )
  }
  if (!meta) return <p className="muted p-8">Loading…</p>

  return (
    <div className="max-w-7xl mx-auto px-4 pb-16">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-4">
        <h1 className="text-2xl font-bold tracking-tight">Sealdeon</h1>
        <span className="subtle text-sm">Pokemon sealed-market intelligence</span>
        <span className="muted text-xs ml-auto">data through {meta.latestDate}</span>
      </header>
      <nav className="flex flex-wrap gap-1.5 pb-4">
        {NAV.map(([key, label]) => (
          <a key={key} href={`#/${key}`} className="chip" data-on={String(page === key || (page === 'set' && key === 'sets'))}>
            {label}
          </a>
        ))}
      </nav>
      {page === 'cohort' && <CohortCurves meta={meta} />}
      {page === 'bands' && <AgeBandMedians meta={meta} />}
      {page === 'screener' && <Screener meta={meta} />}
      {page === 'premium' && <PremiumVsMedian meta={meta} />}
      {page === 'sets' && <SetList meta={meta} />}
      {page === 'set' && param && <SetDetail meta={meta} groupId={param} />}
    </div>
  )
}

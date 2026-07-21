import { useEffect, useState } from 'react'
import { loadMeta } from './lib/loadView.js'
import { useThemeMode } from './lib/theme.js'
import CohortCurves from './views/CohortCurves.jsx'
import AgeBandMedians from './views/AgeBandMedians.jsx'
import SetDetail from './views/SetDetail.jsx'
import Screener from './views/Screener.jsx'
import PremiumVsMedian from './views/PremiumVsMedian.jsx'
import Signals from './views/Signals.jsx'

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
  ['signals', 'Signals'],
  ['screener', 'Screener'],
  ['premium', 'Premium vs Median'],
  ['bands', 'Age-Band Medians'],
  ['sets', 'Sets'],
]

function ThemeToggle() {
  const { mode, toggle } = useThemeMode()
  return (
    <button className="nav-link" onClick={toggle} title="Toggle light / dark"
      style={{ border: '1px solid var(--border-strong)' }}>
      {mode === 'dark' ? '☾ Dark' : '☀ Light'}
    </button>
  )
}

function SetList({ meta }) {
  const [query, setQuery] = useState('')
  const q = query.toLowerCase()
  const rows = [...meta.sets]
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''))
    .filter((s) => !q || s.name?.toLowerCase().includes(q) || s.abbreviation?.toLowerCase().includes(q))
  return (
    <section>
      <h2 className="text-lg font-semibold pb-2">Sets</h2>
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="filter sets…"
        className="field w-64 mb-3" />
      <div className="card p-3 overflow-x-auto">
        <table className="tbl text-sm w-full">
          <thead>
            <tr><th>Set</th><th>Abbr</th><th>Released</th><th>Era</th><th>History</th><th>Hype</th></tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.groupId}>
                <td><a href={`#/set/${s.groupId}`} className="hover:underline" style={{ color: 'var(--accent)' }}>{s.name}</a></td>
                <td className="muted">{s.abbreviation}</td>
                <td className="muted">{s.releaseDate ?? '—'}</td>
                <td className="muted">{s.era}</td>
                <td className="muted">{s.archiveComplete ? 'complete' : 'partial'}</td>
                <td>{s.isHype ? `🔥 ${s.hypeSource}` : ''}</td>
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

  const navActive = (key) => page === key || (page === 'set' && key === 'sets')
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 backdrop-blur"
        style={{ background: 'color-mix(in oklab, var(--surface-0) 88%, transparent)', borderBottom: '1px solid var(--border)' }}>
        <div className="max-w-[1600px] mx-auto px-3 sm:px-4 py-2.5 flex items-center gap-x-4 gap-y-2">
          <div className="flex items-baseline gap-2 shrink-0">
            <span className="text-xl">📦</span>
            <h1 className="text-lg sm:text-xl font-bold tracking-tight">Sealdeon</h1>
            <span className="subtle text-sm hidden md:inline">Pokémon sealed-market intelligence</span>
          </div>
          {/* Desktop nav */}
          <nav className="hidden sm:flex flex-wrap gap-1 ml-auto items-center">
            {NAV.map(([key, label]) => (
              <a key={key} href={`#/${key}`} className="nav-link" data-on={String(navActive(key))}>{label}</a>
            ))}
            <ThemeToggle />
          </nav>
          <div className="ml-auto sm:hidden"><ThemeToggle /></div>
        </div>
      </header>
      <main className="max-w-[1600px] mx-auto px-3 sm:px-4 py-4 pb-24 sm:pb-20">
        <div className="flex justify-end pb-2">
          <span className="muted text-xs">data through {meta.latestDate}</span>
        </div>
        {page === 'cohort' && <CohortCurves meta={meta} />}
        {page === 'signals' && <Signals meta={meta} />}
        {page === 'bands' && <AgeBandMedians meta={meta} />}
        {page === 'screener' && <Screener meta={meta} />}
        {page === 'premium' && <PremiumVsMedian meta={meta} />}
        {page === 'sets' && <SetList meta={meta} />}
        {page === 'set' && param && <SetDetail meta={meta} groupId={param} />}
      </main>
      {/* Mobile bottom tab bar */}
      <nav className="sm:hidden fixed bottom-0 inset-x-0 z-20 flex justify-around backdrop-blur"
        style={{ background: 'color-mix(in oklab, var(--surface-0) 94%, transparent)', borderTop: '1px solid var(--border)' }}>
        {NAV.map(([key, label]) => (
          <a key={key} href={`#/${key}`} className="mobile-tab" data-on={String(navActive(key))}>
            {label.replace(' Curves', '').replace(' Medians', '').replace('Premium vs Median', 'Premium')}
          </a>
        ))}
      </nav>
    </div>
  )
}

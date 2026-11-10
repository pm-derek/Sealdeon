import { useEffect, useMemo, useRef, useState } from 'react'
import { loadMeta } from './lib/loadView.js'
import { useThemeMode } from './lib/theme.js'
import CohortCurves from './views/CohortCurves.jsx'
import AgeBandMedians from './views/AgeBandMedians.jsx'
import SetDetail from './views/SetDetail.jsx'
import Screener from './views/Screener.jsx'
import PremiumVsMedian from './views/PremiumVsMedian.jsx'
import Signals from './views/Signals.jsx'
import Market from './views/Market.jsx'
import Sets from './views/Sets.jsx'

function useRoute() {
  const [hash, setHash] = useState(window.location.hash || '#/market')
  useEffect(() => {
    const onChange = () => {
      setHash(window.location.hash || '#/market')
      window.scrollTo(0, 0)   // a new page starts at its top, not mid-scroll
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  const parts = hash.replace(/^#\//, '').split('/')
  return { page: parts[0] || 'market', param: parts[1] }
}

// Ordered summary -> explore -> find -> reference. Labels stay short so the
// desktop header fits on one row; the hint says what each page answers.
const NAV = [
  ['market', 'Market', 'How is the market doing, and what has worked?'],
  ['cohort', 'Curves', 'Compare sets at the same age, or over the same dates'],
  ['sets', 'Sets', 'Every set at a glance; open one for its detail page'],
  ['screener', 'Screener', 'Sort every product by its recent moves'],
  ['signals', 'Signals', 'Backtested buy rules, and what is firing now'],
  ['premium', 'Premium', 'Which products are priced above or below their usual premium'],
  ['bands', 'Age bands', 'Typical price and premium by age'],
]

function ThemeToggle() {
  const { mode, toggle } = useThemeMode()
  return (
    <button className="nav-link shrink-0" onClick={toggle}
      title={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      style={{ border: '1px solid var(--border-strong)' }}>
      {mode === 'dark' ? '☾' : '☀'}
    </button>
  )
}

const GAME_META = { Pokemon: { icon: '📦', label: 'Pokémon', short: 'Pkmn' }, Magic: { icon: '🔮', label: 'Magic', short: 'Magic' } }

// Kept on ONE line on phones (wrapping cost ~50px of sticky header height).
function GameToggle({ game, setGame, games }) {
  return (
    <div className="seg flex-nowrap shrink-0" title="Switch game">
      {games.map((g) => (
        <button key={g} className="chip whitespace-nowrap" data-on={String(game === g)} onClick={() => setGame(g)}>
          {GAME_META[g]?.icon}
          <span className="hidden sm:inline"> {GAME_META[g]?.label || g}</span>
          <span className="sm:hidden"> {GAME_META[g]?.short || g}</span>
        </button>
      ))}
    </div>
  )
}

export default function App() {
  const [meta, setMeta] = useState(null)
  const [error, setError] = useState(null)
  const [game, setGame] = useState('Pokemon')
  const { page, param } = useRoute()
  const headerRef = useRef(null)

  // Publish the sticky header's height so view-level control bars can stick
  // directly beneath it (it wraps to two lines on narrow screens).
  useEffect(() => {
    const el = headerRef.current
    if (!el) return
    const set = () => document.documentElement.style.setProperty('--header-h', `${el.offsetHeight}px`)
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => ro.disconnect()
  }, [meta])

  useEffect(() => { loadMeta().then(setMeta).catch((e) => setError(e.message)) }, [])

  // games present in the data (toggle only shows once >1 exists, e.g. after
  // the Magic backfill lands)
  const games = meta?.games?.length ? meta.games : ['Pokemon']
  useEffect(() => { if (!games.includes(game)) setGame(games[0]) }, [games, game])

  // meta scoped to the active game: sets + product-type list. Views filter
  // off meta.sets, so scoping here cleanly restricts every view to one game.
  const gameMeta = useMemo(() => {
    if (!meta) return null
    return {
      ...meta,
      sets: meta.sets.filter((s) => (s.game || 'Pokemon') === game),
      seriesTypes: meta.seriesTypesByGame?.[game] || meta.seriesTypes,
    }
  }, [meta, game])

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
      <header ref={headerRef} className="sticky top-0 z-20 backdrop-blur"
        style={{ background: 'color-mix(in oklab, var(--surface-0) 88%, transparent)', borderBottom: '1px solid var(--border)' }}>
        <div className="max-w-[1600px] mx-auto px-3 sm:px-4 py-1.5 sm:py-2.5 flex items-center gap-x-2 sm:gap-x-4 flex-nowrap">
          <div className="flex items-baseline gap-2 shrink-0 min-w-0">
            <span className="text-xl hidden sm:inline">📦</span>
            <h1 className="text-base sm:text-xl font-bold tracking-tight">Sealdeon</h1>
            <span className="subtle text-sm hidden 2xl:inline">sealed-market intelligence</span>
          </div>
          {games.length > 1 && <GameToggle game={game} setGame={setGame} games={games} />}
          {/* Desktop nav */}
          <nav className="hidden sm:flex flex-nowrap gap-0.5 lg:gap-1 ml-auto items-center min-w-0">
            {NAV.map(([key, label, hint]) => (
              <a key={key} href={`#/${key}`} className="nav-link whitespace-nowrap" title={hint}
                data-on={String(navActive(key))} aria-current={navActive(key) ? 'page' : undefined}>{label}</a>
            ))}
            <span className="muted text-xs whitespace-nowrap hidden xl:inline px-2" title="Prices from TCGplayer via TCGCSV, refreshed daily">
              data through {meta.latestDate}
            </span>
            <ThemeToggle />
          </nav>
          <div className="ml-auto sm:hidden"><ThemeToggle /></div>
        </div>
      </header>
      <main className="max-w-[1600px] mx-auto px-3 sm:px-4 py-2 sm:py-4 pb-24 sm:pb-20">
        {page === 'market' && <Market key={game} game={game} />}
        {page === 'cohort' && <CohortCurves key={game} meta={gameMeta} game={game} />}
        {page === 'signals' && <Signals meta={meta} game={game} />}
        {page === 'bands' && <AgeBandMedians key={game} meta={gameMeta} game={game} />}
        {page === 'screener' && <Screener key={game} meta={gameMeta} game={game} />}
        {page === 'premium' && <PremiumVsMedian key={game} meta={gameMeta} game={game} />}
        {page === 'sets' && <Sets key={game} meta={gameMeta} game={game} />}
        {page === 'set' && param && <SetDetail meta={meta} groupId={param} />}
      </main>
      {/* Mobile bottom tab bar */}
      <nav className="sm:hidden fixed bottom-0 inset-x-0 z-20 flex justify-around backdrop-blur"
        style={{ background: 'color-mix(in oklab, var(--surface-0) 94%, transparent)', borderTop: '1px solid var(--border)' }}>
        {NAV.map(([key, label]) => (
          <a key={key} href={`#/${key}`} className="mobile-tab" data-on={String(navActive(key))}
            aria-current={navActive(key) ? 'page' : undefined}>
            {label === 'Age bands' ? 'Bands' : label}
          </a>
        ))}
      </nav>
    </div>
  )
}

import * as Plot from '@observablehq/plot'
import { useEffect, useMemo, useState } from 'react'
import PlotFigure from '../components/PlotFigure.jsx'
import { loadView } from '../lib/loadView.js'
import { fmtPct } from '../lib/slice.js'
import { useTheme } from '../lib/theme.js'
import MarketLaunch from './MarketLaunch.jsx'
import { endLabels, fmtPp, fmtPx, fmtShare, Legend, LinkIcon, Section, Seg, Stat, toDate, toneOf } from '../components/ui.jsx'

// Market pulse: the trend / winners-vs-losers analysis, rebuilt daily by
// pipeline/market.py. Read top to bottom: state -> trend -> what has worked
// -> what that implies today.

const SHORT = { 'Booster Box': 'Box', 'Bundle / UPC': 'Bundle', 'Chase singles': 'Chase', Collector: 'Coll.' }
const REGIME_TONE = { Rising: 'pos', Cooling: 'warn', 'Drifting lower': 'neg', Stabilizing: 'warn', Flat: 'muted' }

// Two targets per row: the set opens its page here, the product opens on TCGplayer.
function ItemLinks({ r }) {
  return (
    <span className="min-w-0 flex-1 flex items-center gap-1 truncate">
      {r.groupId != null
        ? <a href={`#/set/${r.groupId}`} className="font-semibold hover:underline shrink-0" title={`${r.setName} — open set page`}>{r.ab || r.setName}</a>
        : <b className="shrink-0">{r.ab || r.setName}</b>}
      <a href={r.url} target="_blank" rel="noreferrer" className="muted hover:underline inline-flex items-center gap-1 min-w-0"
        title="Open on TCGplayer">
        <span className="truncate">{r.type}</span><LinkIcon />
      </a>
    </span>
  )
}

// Jump links for a long page; each target section carries the matching id.
const JUMPS = [['trend', 'Trend'], ['launch', 'Launch vs market'], ['worked', 'What has worked'],
               ['now', 'Right now'], ['movers', 'Movers'], ['types', 'By type']]

// One line that says what the numbers mean, so the page reads in five seconds.
function headline(game, p) {
  const who = game === 'Magic' ? 'Magic sealed' : 'Seasoned Pokémon sealed'
  const verb = {
    Rising: 'is rising', Cooling: 'is still up on the quarter but cooling',
    'Drifting lower': 'is drifting lower', Stabilizing: 'fell, and is now stabilizing', Flat: 'is flat',
  }[p.regime] || 'is mixed'
  const parts = [`${who} ${verb}: ${fmtPct(p.index90)} over 90 days`,
    `${fmtShare(p.breadth90)} of items that moved went up`]
  if (p.chase90 != null) parts.push(`chase singles ${fmtPct(p.chase90)}`)
  return parts.join(' · ') + '.'
}

export default function Market({ game = 'Pokemon' }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [moverWin, setMoverWin] = useState('r90')
  const [factorWin, setFactorWin] = useState('recent')
  const { palette, themeTick } = useTheme()

  useEffect(() => { loadView('market').then(setData).catch((e) => setErr(String(e))) }, [])
  const g = data?.games?.[game]

  if (err) return <p className="muted py-8">Market view not built yet ({err}).</p>
  if (!g) return <p className="muted py-8">Loading market pulse…</p>
  const p = g.pulse

  return (
    <div className="pb-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2 pt-3">
        <h1 className="text-xl font-semibold">Market pulse</h1>
        <span className="muted text-xs"><span className="sm:hidden">data through {data.asOf} · </span>rebuilt daily</span>
      </div>
      <p className="text-sm mt-1.5" style={{ color: 'var(--text-secondary)' }}>
        <span className="font-semibold px-1.5 py-0.5 rounded mr-1.5 text-xs align-middle"
          style={{ background: `color-mix(in oklab, var(--${REGIME_TONE[p.regime] || 'muted'}) 18%, transparent)`,
                   color: `var(--${REGIME_TONE[p.regime] === 'muted' ? 'text-secondary' : REGIME_TONE[p.regime] || 'text-secondary'})` }}>
          {p.regime}
        </span>
        {headline(game, p)}
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
        <Stat label="Market index · 90d" value={fmtPct(p.index90)} tone={toneOf(p.index90)}
          sub={`30d ${fmtPct(p.index30)}`}
          hint="Median week-over-week move across items older than 120 days, chained. New releases are left out so their post-launch decay can't pass for a market move." />
        <Stat label="vs 12-month high" value={fmtPct(p.offYearHigh)} tone={toneOf(p.offYearHigh)}
          sub="index level" />
        <Stat label="Breadth · 90d" value={fmtShare(p.breadth90)} tone={p.breadth90 >= 0.5 ? 'pos' : 'neg'}
          sub={`of movers rose · 30d ${fmtShare(p.breadth30)}`}
          hint="Of items that moved more than 2%, the share that went up." />
        {p.chase90 != null
          ? <Stat label="Chase singles · 90d" value={fmtPct(p.chase90)} tone={toneOf(p.chase90)}
              sub="top-5 cards per set" />
          : <Stat label="Typical item · 90d" value={fmtPct(p.median90)} tone={toneOf(p.median90)}
              sub={`30d ${fmtPct(p.median30)}`} />}
      </div>

      <nav className="flex flex-wrap gap-1.5 mt-3" aria-label="Jump to section">
        {JUMPS.filter(([id]) => id !== 'launch' || g.launch).map(([id, label]) => (
          <a key={id} href={`#/market`} className="chip" onClick={(e) => {
            e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }}>{label}</a>
        ))}
      </nav>
      <IndexChart g={g} palette={palette} themeTick={themeTick} />
      <SupplyChart g={g} palette={palette} themeTick={themeTick} />
      <MarketLaunch launch={g.launch} palette={palette} themeTick={themeTick} />

      <Section id="worked" title="What has worked"
        kicker="Past purchases grouped by what the product looked like when bought — and how each group did over the next three months."
        right={<Seg value={factorWin} onChange={setFactorWin}
          options={[['recent', 'Latest 6 mo'], ['all', 'All history']]} />}>
        <FactorBaseline w={g.factors.windows[factorWin]} days={g.factors.horizonDays} />
        <div className="grid sm:grid-cols-2 gap-2 mt-2">
          {g.factors.factors.map((f) => (
            <FactorCard key={f.key} f={f} win={factorWin} base={g.factors.windows[factorWin]} />
          ))}
        </div>
      </Section>

      <Section id="now" title="Right now" kicker="Live lists built from the patterns that held up. Tap a set to open its page, or the product to open it on TCGplayer.">
        <div className="grid lg:grid-cols-2 gap-2">
          {g.screens.map((s) => <ScreenCard key={s.key} s={s} />)}
        </div>
      </Section>

      <Section id="movers" title="Biggest movers" kicker="Single-unit sealed only."
        right={<Seg value={moverWin} onChange={setMoverWin} options={[['r30', '30d'], ['r90', '90d']]} />}>
        <div className="grid sm:grid-cols-2 gap-2">
          <MoverList title="Up" rows={g.movers[moverWin].up} k={moverWin} />
          <MoverList title="Down" rows={g.movers[moverWin].down} k={moverWin} />
        </div>
      </Section>

      <Section id="types" title="By product type">
        <SegmentTable rows={g.segments} />
      </Section>

      <details className="card p-3 mt-6 text-xs" style={{ color: 'var(--text-secondary)' }}>
        <summary className="cursor-pointer font-medium" style={{ color: 'var(--text-primary)' }}>How this is built</summary>
        <ul className="list-disc pl-4 mt-2 space-y-1.5">
          <li><b>Universe:</b> each set's canonical single-unit sealed product per type — no cases or multipacks.
            Pokémon: Sword &amp; Shield onward (vintage history is thin and full of listing artifacts). Magic: sets from 2019.</li>
          <li><b>Index:</b> median week-over-week return across items, chained. Items only count once they're 120+ days old.</li>
          <li><b>What has worked:</b> every item, every two weeks since May 2024 — what it looked like then, and what it did over the next 90 days.
            Bars show the gap to the market's average over the same windows, so a bull market doesn't make everything look good.
            Windows overlap, so treat this as direction rather than precise odds.</li>
          <li><b>Entry price:</b> when the cheapest listing sits above market, the buyer pays the listing. Scoring at market price instead
            invents a "thin supply" edge — market price just catches up to the listings, which no buyer captures.</li>
          <li><b>Not included:</b> fees and shipping. Selling on TCGplayer costs roughly 12–15%, so a quick flip needs to clear that first.</li>
        </ul>
      </details>
    </div>
  )
}

function IndexChart({ g, palette, themeTick }) {
  const segs = Object.keys(g.index).filter((k) => k !== 'All')
  // fixed slot order: color follows the segment, never its rank
  const color = Object.fromEntries(segs.map((s, i) => [s, palette.series[i % palette.series.length]]))
  const rows = useMemo(() => segs.flatMap((s) => g.index[s].map(([d, v]) => ({ seg: s, date: toDate(d), v }))), [g, themeTick])
  const build = (width) => {
    const height = width < 640 ? 240 : 300
    const vs = rows.map((r) => r.v).concat([100])
    const lo = Math.min(...vs), hi = Math.max(...vs)
    // end labels name the line (identity never rests on color alone);
    // phones get short names so the label fits the margin
    const labels = endLabels(rows, 'seg', { lo, hi, plotPx: height - 50 })
    return Plot.plot({
    width, height, marginRight: width < 640 ? 76 : 124, marginLeft: 36,
    style: { background: 'transparent', color: palette.textSecondary, fontSize: '11px' },
    x: { type: 'utc', label: null, ticks: width < 640 ? 4 : 8 },
    y: { grid: true, label: null, domain: [lo, hi], tickFormat: (d) => `${d}` },
    color: { domain: segs, range: segs.map((s) => color[s]) },
    marks: [
      Plot.ruleY([100], { stroke: palette.textSecondary, strokeOpacity: 0.55 }),
      Plot.lineY(rows, { x: 'date', y: 'v', stroke: 'seg', strokeWidth: 2, curve: 'monotone-x' }),
      Plot.text(labels, { x: 'date', y: 'ly',
        text: (d) => `${width < 640 ? SHORT[d.seg] || d.seg : d.seg} ${Math.round(d.v)}`,
        dx: 6, textAnchor: 'start', fill: palette.text, fontSize: 11 }),
      Plot.ruleX(rows, Plot.pointerX({ x: 'date', stroke: palette.textSecondary, strokeOpacity: 0.4 })),
      Plot.dot(rows, Plot.pointerX({ x: 'date', y: 'v', fill: 'seg', r: 3.5, stroke: palette.surface, strokeWidth: 1.5 })),
      Plot.tip(rows, Plot.pointerX({ x: 'date', y: 'v', z: 'seg',
        title: (d) => `${d.seg}\n${d.date.toISOString().slice(0, 10)} · ${d.v.toFixed(1)}  (${fmtPct(d.v / 100 - 1)} on the year)` })),
    ],
    })
  }
  return (
    <Section id="trend" title="Prices by segment, last 12 months"
      kicker="Index, 100 = a year ago. Items under 120 days old are left out.">
      <div className="card p-3">
        <Legend items={segs.map((s) => [s, color[s]])} />
        <PlotFigure build={build} deps={[rows, themeTick]} />
      </div>
    </Section>
  )
}

function SupplyChart({ g, palette, themeTick }) {
  const rows = useMemo(() => g.supply.flatMap(([d, , thin, glut]) => [
    { k: 'Nobody undercutting', date: toDate(d), v: thin },
    { k: 'Heavy undercutting', date: toDate(d), v: glut },
  ]), [g, themeTick])
  const color = { 'Nobody undercutting': palette.series[0], 'Heavy undercutting': palette.series[1] }
  const build = (width) => {
    const height = width < 640 ? 180 : 220
    const hi = Math.max(0.5, ...rows.map((r) => r.v))
    const labels = endLabels(rows, 'k', { lo: 0, hi, plotPx: height - 50 })
    return Plot.plot({
    width, height, marginRight: width < 640 ? 64 : 84, marginLeft: 36,
    style: { background: 'transparent', color: palette.textSecondary, fontSize: '11px' },
    x: { type: 'utc', label: null, ticks: width < 640 ? 4 : 8 },
    y: { grid: true, label: null, domain: [0, hi], tickFormat: (d) => `${Math.round(d * 100)}%` },
    color: { domain: Object.keys(color), range: Object.values(color) },
    marks: [
      Plot.ruleY([0], { stroke: palette.textSecondary, strokeOpacity: 0.4 }),
      Plot.lineY(rows, { x: 'date', y: 'v', stroke: 'k', strokeWidth: 2, curve: 'monotone-x' }),
      // the two lines often end at the same share, so the label says which
      Plot.text(labels, { x: 'date', y: 'ly', text: (d) => `${d.k.startsWith('Nobody') ? 'tight' : 'glut'} ${fmtShare(d.v)}`,
        dx: 6, textAnchor: 'start', fill: palette.text, fontSize: 11 }),
      Plot.ruleX(rows, Plot.pointerX({ x: 'date', stroke: palette.textSecondary, strokeOpacity: 0.4 })),
      Plot.tip(rows, Plot.pointerX({ x: 'date', y: 'v', z: 'k',
        title: (d) => `${d.k}\n${d.date.toISOString().slice(0, 10)} · ${fmtShare(d.v)} of items` })),
    ],
    })
  }
  return (
    <Section title="Supply on the listings book"
      kicker="Share of items where the cheapest listing is at or above market (nobody undercutting) vs 10%+ below it. Tight supply tends to fade before prices roll over.">
      <div className="card p-3">
        <Legend items={Object.entries(color)} />
        <PlotFigure build={build} deps={[rows, themeTick]} />
      </div>
    </Section>
  )
}

// Plain-language framing for each factor: a question, and bucket labels a
// non-trader can read. Keys and bucket names come from pipeline/market.py.
const FACTOR_TEXT = {
  prem_t: { q: 'Does paying over pack value hurt?', d: 'Sealed price compared with what the packs inside sell for one by one.',
    b: { 'below −10%': 'Cheaper than its packs', '−10…+10%': 'About what its packs are worth', '+10…30%': '10–30% over pack value',
         '+30…60%': '30–60% over pack value', 'above +60%': 'More than 60% over pack value' } },
  age: { q: 'Does the set’s age matter?', d: 'How long the set had been out when bought.',
    b: { 'under 6 mo': 'Under 6 months old', '6–12 mo': '6–12 months old', '1–2 yr': '1–2 years old', '2–3 yr': '2–3 years old', '3 yr+': 'Over 3 years old' } },
  mom30: { q: 'Does last month’s trend keep going?', d: 'What the price did in the month before buying.',
    b: { 'down >3%': 'Fell more than 3%', flat: 'Roughly flat', 'up 3–10%': 'Rose 3–10%', 'up >10%': 'Rose more than 10%' } },
  dd: { q: 'Buy at the top, or after a dip?', d: 'How far below its all-time high the price was when bought.',
    b: { '>30% below': 'More than 30% below its high', '5–30% below': '5–30% below its high', 'at its high': 'At or near its high' } },
  ask_t: { q: 'Do cheap listings mean anything?', d: 'Cheapest listing compared with the market price when bought. Above market, you pay the listing.',
    b: { 'under 0.90': 'Listings 10%+ under market', '0.90–0.97': 'Listings 3–10% under market', '0.97–1.03': 'Listings at market',
         'over 1.03': 'Listings 3%+ above market' } },
}
const dollars = (r) => `$${Math.round(100 * (1 + r))}`

function FactorBaseline({ w, days }) {
  return (
    <div className="card p-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
      <p>
        Imagine putting <b>$100</b> into every product that fit a description, then checking {Math.round(days / 30)} months later.
        Each card asks one question and shows what that $100 became for each answer.
      </p>
      <p className="mt-1">
        The dashed line is the yardstick: $100 in the <b>average</b> product became <b className="tabular-nums" style={{ color: 'var(--text-primary)' }}>{dollars(w.mean)}</b>
        {' '}({Math.round(w.hit * 10)} in 10 went up). <span style={{ color: 'var(--pos)' }}>Green</span> groups beat the average,
        {' '}<span style={{ color: 'var(--neg)' }}>red</span> groups lagged it. Prices are what a buyer actually pays; fees not included.
      </p>
    </div>
  )
}

function FactorCard({ f, win, base }) {
  const t = FACTOR_TEXT[f.key] || { q: f.label, d: f.desc, b: {} }
  const rows = f.buckets.filter((b) => b[win]).map((b) => ({ bucket: b.bucket, label: t.b[b.bucket] || b.bucket, ...b[win] }))
  if (!rows.length) return null
  const val = (r) => 100 * (1 + r)
  const mkt = val(base.mean)
  const lo = Math.min(100, mkt, ...rows.map((r) => val(r.mean))) - 2
  const hi = Math.max(100, mkt, ...rows.map((r) => val(r.mean))) + 2
  const x = (v) => `${((v - lo) / (hi - lo)) * 100}%`
  const best = rows.reduce((a, b) => (b.excess > a.excess ? b : a))
  const worst = rows.reduce((a, b) => (b.excess < a.excess ? b : a))
  const spread = best.excess - worst.excess
  const verdict = spread < 0.03
    ? 'Not much difference between the groups — this doesn’t seem to matter much.'
    : <>Best: <b style={{ color: 'var(--pos)' }}>{best.label.toLowerCase()}</b> ({dollars(best.mean)}).
        {' '}Worst: <b style={{ color: 'var(--neg)' }}>{worst.label.toLowerCase()}</b> ({dollars(worst.mean)}).</>
  return (
    <div className="card p-3 min-w-0">
      <h3 className="text-sm font-semibold">{t.q}</h3>
      <p className="muted text-[11px]">{t.d}</p>
      <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{verdict}</p>
      <div className="mt-2 space-y-2">
        {rows.map((r) => {
          const v = val(r.mean)
          const beat = r.excess >= 0
          const c = beat ? 'var(--pos)' : 'var(--neg)'
          return (
            <div key={r.bucket} title={`${r.n.toLocaleString()} purchases · ${fmtShare(r.loss)} lost 5% or more · ${fmtPp(r.excess)} vs average`}>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="min-w-0">{r.label}</span>
                <span className="tabular-nums shrink-0">
                  <b style={{ color: c }}>{dollars(r.mean)}</b>
                  <span className="muted"> · {Math.round(r.hit * 10)} in 10 rose</span>
                </span>
              </div>
              <div className="relative h-3 mt-0.5 rounded" style={{ background: 'var(--surface-2, rgba(127,127,127,0.12))' }}>
                <div className="absolute top-0 bottom-0 rounded" style={{
                  left: x(Math.min(100, v)), width: `calc(${x(Math.max(100, v))} - ${x(Math.min(100, v))})`, background: c, opacity: 0.85,
                }} />
                {/* $100 start and the market yardstick */}
                <div className="absolute -top-0.5 -bottom-0.5" style={{ left: x(100), borderLeft: '1.5px solid var(--text-primary)', opacity: 0.6 }} />
                <div className="absolute -top-1 -bottom-1" style={{ left: x(mkt), borderLeft: '1.5px dashed var(--text-primary)' }} />
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex justify-between muted text-[10px] mt-1.5">
        <span>solid line = your $100</span><span>dashed = average product ({dollars(base.mean)})</span>
      </div>
    </div>
  )
}

function ScreenCard({ s }) {
  return (
    <div className="card p-3 min-w-0" style={{ borderLeft: `3px solid var(--${s.tone})` }}>
      <h3 className="text-sm font-semibold">{s.title}</h3>
      <p className="muted text-[11px] mt-0.5">{s.why}</p>
      {s.rows.length === 0
        ? <p className="muted text-xs mt-2">Nothing qualifies today.</p>
        : (
          <ul className="mt-2 divide-y" style={{ borderColor: 'var(--border)' }}>
            {s.rows.map((r, i) => (
              <li key={i} className="py-1.5 flex items-center gap-2 text-xs" style={{ borderColor: 'var(--border)' }}>
                <ItemLinks r={r} />
                <span className="tabular-nums w-14 text-right">{fmtPx(r.p0)}</span>
                <span className="tabular-nums w-14 text-right" title="vs pack value"
                  style={{ color: r.prem == null ? 'var(--text-muted)' : undefined }}>
                  {r.prem == null ? '—' : `${r.prem > 0 ? '+' : ''}${Math.round(r.prem * 100)}%`}
                </span>
                <span className="tabular-nums w-14 text-right" title="90-day change"
                  style={{ color: `var(--${toneOf(r.r90) === 'muted' ? 'text-muted' : toneOf(r.r90)})` }}>
                  {fmtPct(r.r90, 0)}
                </span>
              </li>
            ))}
            <li className="pt-1.5 flex gap-2 text-[10px] muted">
              <span className="flex-1" /><span className="w-14 text-right">price</span>
              <span className="w-14 text-right">vs packs</span><span className="w-14 text-right">90d</span>
            </li>
          </ul>
        )}
    </div>
  )
}

function MoverList({ title, rows, k }) {
  const ext = Math.max(0.01, ...rows.map((r) => Math.abs(r[k] || 0)))
  return (
    <div className="card p-3 min-w-0">
      <h3 className="text-sm font-semibold mb-1">{title}</h3>
      <ul>
        {rows.map((r, i) => (
          <li key={i} className="py-1 text-xs">
            <div className="flex items-center gap-2">
                <ItemLinks r={r} />
              <span className="tabular-nums muted">{fmtPx(r.p0)}</span>
              <span className="tabular-nums w-14 text-right font-medium"
                style={{ color: `var(--${toneOf(r[k]) === 'muted' ? 'text-muted' : toneOf(r[k])})` }}>{fmtPct(r[k], 1)}</span>
            </div>
            <div className="h-1 mt-1 rounded-full" style={{ background: 'var(--surface-2)' }}>
              <div className="h-1 rounded-full" style={{
                width: `${(Math.abs(r[k] || 0) / ext) * 100}%`,
                background: `var(--${(r[k] || 0) >= 0 ? 'pos' : 'neg'})`, opacity: 0.75,
              }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SegmentTable({ rows }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-xs tabular-nums">
        <thead>
          <tr className="muted text-left">
            <th className="font-medium p-2">Type</th><th className="font-medium p-2 text-right">Items</th>
            <th className="font-medium p-2 text-right">30d</th><th className="font-medium p-2 text-right">90d</th>
            <th className="font-medium p-2 text-right" title="Of items that moved >2% over 90 days, the share that rose">Rose (90d)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.type} style={{ borderTop: '1px solid var(--border)' }}>
              <td className="p-2">{r.type}</td><td className="p-2 text-right">{r.n}</td>
              <td className="p-2 text-right" style={{ color: `var(--${toneOf(r.median30) === 'muted' ? 'text-muted' : toneOf(r.median30)})` }}>{fmtPct(r.median30)}</td>
              <td className="p-2 text-right" style={{ color: `var(--${toneOf(r.median90) === 'muted' ? 'text-muted' : toneOf(r.median90)})` }}>{fmtPct(r.median90)}</td>
              <td className="p-2 text-right">{fmtShare(r.up90)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

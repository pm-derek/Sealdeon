import * as Plot from '@observablehq/plot'
import { useEffect, useMemo, useState } from 'react'
import PlotFigure from '../components/PlotFigure.jsx'
import { loadView } from '../lib/loadView.js'
import { fmtPct } from '../lib/slice.js'
import { useTheme } from '../lib/theme.js'

// Market pulse: the trend / winners-vs-losers analysis, rebuilt daily by
// pipeline/market.py. Read top to bottom: state -> trend -> what has worked
// -> what that implies today.

const fmtPx = (v) => (v == null ? '—' : `$${v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(0)}`)
const fmtPp = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)} pts`)
const fmtShare = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)
// tolerate 'YYYY-MM-DD' or a full timestamp; one bad date must not blank the page
const toDate = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00`)
const toneOf = (v) => (v == null ? 'muted' : v > 0.005 ? 'pos' : v < -0.005 ? 'neg' : 'muted')

// End labels for line charts, pushed apart vertically so two lines ending at
// nearly the same value never print on top of each other. Works in data
// units: `px` is the label height in pixels, `plotPx` the plot's pixel height.
function endLabels(rows, key, { lo, hi, plotPx, px = 14 }) {
  const last = new Map()
  for (const r of rows) {
    const cur = last.get(r[key])
    if (!cur || r.date > cur.date) last.set(r[key], r)
  }
  const pts = [...last.values()].map((r) => ({ ...r, ly: r.v })).sort((a, b) => a.v - b.v)
  const gap = ((hi - lo) * px) / Math.max(1, plotPx)
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].ly - pts[i - 1].ly < gap) pts[i].ly = pts[i - 1].ly + gap
  }
  // if the stack ran off the top, slide the whole stack back down
  const over = pts.length ? pts[pts.length - 1].ly - hi : 0
  if (over > 0) pts.forEach((p) => { p.ly -= over })
  return pts
}

const SHORT = { 'Booster Box': 'Box', 'Bundle / UPC': 'Bundle', 'Chase singles': 'Chase', Collector: 'Coll.' }

const REGIME_TONE = { Rising: 'pos', Cooling: 'warn', 'Drifting lower': 'neg', Stabilizing: 'warn', Flat: 'muted' }

function LinkIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
      strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.7 }} aria-hidden="true">
      <path d="M14 3h7v7" /><path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  )
}

function Stat({ label, value, sub, tone, hint }) {
  return (
    <div className="card p-3 min-w-0" title={hint}>
      <div className="muted text-[11px] uppercase tracking-wide truncate">{label}</div>
      <div className="text-2xl font-semibold tabular-nums leading-tight mt-0.5"
        style={{ color: tone && tone !== 'muted' ? `var(--${tone})` : 'var(--text-primary)' }}>{value}</div>
      {sub && <div className="muted text-xs mt-0.5 truncate">{sub}</div>}
    </div>
  )
}

function Section({ title, kicker, children, right }) {
  return (
    <section className="mt-6">
      {/* the control wraps under the text on phones instead of squeezing it */}
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2 mb-2">
        <div className="min-w-0 flex-1 basis-72">
          <h2 className="text-base font-semibold">{title}</h2>
          {kicker && <p className="muted text-xs mt-0.5">{kicker}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  )
}

function Seg({ value, onChange, options }) {
  return (
    <div className="seg flex-nowrap shrink-0">
      {options.map(([v, t]) => (
        <button key={v} className="chip" data-on={String(value === v)} onClick={() => onChange(v)}>{t}</button>
      ))}
    </div>
  )
}

function Legend({ items }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
      {items.map(([label, color, dashed]) => (
        <span key={label} className="inline-flex items-center gap-1.5">
          <svg width="16" height="8" aria-hidden="true">
            <line x1="1" x2="15" y1="4" y2="4" stroke={color} strokeWidth="2.5" strokeLinecap="round"
              strokeDasharray={dashed ? '3 3' : undefined} />
          </svg>
          {label}
        </span>
      ))}
    </div>
  )
}

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

      <IndexChart g={g} palette={palette} themeTick={themeTick} />
      <SupplyChart g={g} palette={palette} themeTick={themeTick} />

      <Section title="What has worked"
        kicker={`Average return over the next ${g.factors.horizonDays} days, by what an item looked like beforehand — measured against the market's own average, at the price a buyer actually pays.`}
        right={<Seg value={factorWin} onChange={setFactorWin}
          options={[['recent', 'Latest 6 mo'], ['all', 'All history']]} />}>
        <FactorBaseline w={g.factors.windows[factorWin]} />
        <div className="grid sm:grid-cols-2 gap-2 mt-2">
          {g.factors.factors.map((f) => (
            <FactorCard key={f.key} f={f} win={factorWin} palette={palette} themeTick={themeTick} />
          ))}
        </div>
      </Section>

      <Section title="Right now" kicker="Live lists built from the patterns that held up. Tap an item to open it on TCGplayer.">
        <div className="grid lg:grid-cols-2 gap-2">
          {g.screens.map((s) => <ScreenCard key={s.key} s={s} />)}
        </div>
      </Section>

      <Section title="Biggest movers" kicker="Single-unit sealed only."
        right={<Seg value={moverWin} onChange={setMoverWin} options={[['r30', '30d'], ['r90', '90d']]} />}>
        <div className="grid sm:grid-cols-2 gap-2">
          <MoverList title="Up" rows={g.movers[moverWin].up} k={moverWin} />
          <MoverList title="Down" rows={g.movers[moverWin].down} k={moverWin} />
        </div>
      </Section>

      <Section title="By product type">
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
    <Section title="Prices by segment, last 12 months"
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

function FactorBaseline({ w }) {
  return (
    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
      Market average over these windows: <b className="tabular-nums">{fmtPct(w.mean)}</b> per 90 days,
      {' '}{fmtShare(w.hit)} of items gained. Bars show how much better or worse each group did than that.
    </p>
  )
}

function FactorCard({ f, win, palette, themeTick }) {
  const rows = f.buckets.filter((b) => b[win]).map((b) => ({ bucket: b.bucket, ...b[win] }))
  const best = rows.length ? rows.reduce((a, b) => (b.excess > a.excess ? b : a)) : null
  const worst = rows.length ? rows.reduce((a, b) => (b.excess < a.excess ? b : a)) : null
  const maxAbs = Math.max(0.04, ...rows.map((r) => Math.abs(r.excess)))
  const build = (width) => {
    // padded so a value label beside the longest bar never runs into the
    // axis; narrow cards need proportionally more room for the same label
    const ext = maxAbs * (width < 420 ? 1.75 : 1.45)
    return Plot.plot({
    width, height: 26 * f.buckets.length + 28, marginLeft: 96, marginRight: 48,
    style: { background: 'transparent', color: palette.textSecondary, fontSize: '11px' },
    x: { domain: [-ext, ext], label: null, ticks: 4, tickFormat: (d) => `${d > 0 ? '+' : ''}${Math.round(d * 100)}` },
    y: { domain: f.buckets.map((b) => b.bucket), label: null },
    marks: [
      Plot.ruleX([0], { stroke: palette.textSecondary, strokeOpacity: 0.6 }),
      Plot.barX(rows, { y: 'bucket', x: 'excess', fill: (d) => (d.excess >= 0 ? palette.pos : palette.neg),
        insetTop: 5, insetBottom: 5, rx: 3 }),
      // dx/textAnchor must be constants in Plot, so positive and negative
      // labels are two marks rather than one with per-datum options
      Plot.text(rows.filter((d) => d.excess >= 0), { y: 'bucket', x: 'excess', text: (d) => fmtPp(d.excess).replace(' pts', ''),
        textAnchor: 'start', dx: 4, fill: palette.text, fontSize: 10.5 }),
      Plot.text(rows.filter((d) => d.excess < 0), { y: 'bucket', x: 'excess', text: (d) => fmtPp(d.excess).replace(' pts', ''),
        textAnchor: 'end', dx: -4, fill: palette.text, fontSize: 10.5 }),
      Plot.tip(rows, Plot.pointerY({ y: 'bucket', x: 'excess',
        title: (d) => `${f.label}: ${d.bucket}\nNext 90d: ${fmtPct(d.mean)} on average (${fmtPp(d.excess)} vs market)\n${fmtShare(d.hit)} gained · ${fmtShare(d.loss)} lost 5%+ · ${d.n.toLocaleString()} observations` })),
    ],
    })
  }
  return (
    <div className="card p-3 min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{f.label}</h3>
      </div>
      <p className="muted text-[11px]">{f.desc}</p>
      {best && worst && best !== worst && (
        <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
          Best: <b style={{ color: 'var(--pos)' }}>{best.bucket}</b> · Worst: <b style={{ color: 'var(--neg)' }}>{worst.bucket}</b>
        </p>
      )}
      <PlotFigure build={build} deps={[rows, win, themeTick]} />
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
                <a href={r.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 flex items-center gap-1 hover:underline">
                  <span className="truncate"><b>{r.ab || r.setName}</b> <span className="muted">{r.type}</span></span>
                  <LinkIcon />
                </a>
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
              <a href={r.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 flex items-center gap-1 hover:underline">
                <span className="truncate"><b>{r.ab || r.setName}</b> <span className="muted">{r.type}</span></span>
                <LinkIcon />
              </a>
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

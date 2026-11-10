import * as Plot from '@observablehq/plot'
import { useMemo, useState } from 'react'
import PlotFigure from '../components/PlotFigure.jsx'
import { fmtPct } from '../lib/slice.js'
import { HowToRead, Legend, Section, Seg, fmtShare } from '../components/ui.jsx'

// Launch hype vs the market (pipeline/launch.py). Splits each set's fall from
// its launch peak into four parts that add up, in log terms, to the total:
//   launch unwind  peak -> settled price (the typical price in month two)
//   normal decay   what a typical item does after settling, at this age
//   market         the market index over the same dates
//   set-specific   what is left: this set versus a normal one
// The pipeline ships every item; sets and years are averaged here so the
// product toggle can narrow them. Every product counts the same (no price
// weighting), and the average is taken in log terms so the parts still add up.

const PARTS = [
  ['unwind', 'Launch unwind', 'Peak → settled price. The launch premium leaving.'],
  ['decay', 'Normal decay', 'What a typical item does after settling, at this age. Sealed: roughly flat. Singles: keep falling as packs get opened.'],
  ['market', 'Market', 'The whole market over the same dates.'],
  ['specific', 'Set-specific', 'What is left: this set versus a normal one. Negative = weaker than usual.'],
]
const KEYS = [...PARTS.map(([k]) => k), 'total']
const ANCHOR_LABEL = { 'Launch peak': 'Launch peak (highest price)', 'Day 0': 'Release day', 'Days 7–13': 'Week 2 (days 7–13)',
  'Days 7–29': 'Weeks 2–4 (days 7–29)', 'Days 30–59 (settled)': 'Month 2 (days 30–59) = settled' }
const TYPE_LABEL = { 'PKC ETB': 'Pokémon Center ETB' }
const toneVar = (v) => (v == null ? 'var(--text-muted)' : v > 0.005 ? 'var(--pos)' : v < -0.005 ? 'var(--neg)' : 'var(--text-secondary)')
const P = ({ v }) => <span className="tabular-nums" style={{ color: toneVar(v) }}>{v == null ? '—' : fmtPct(v, 0)}</span>

// Ticks placed in log space but labelled as plain % changes, so stacked parts
// add up visually and still read as "-50%", "+100%".
const PCT_TICKS = [-0.9, -0.75, -0.5, -0.25, 0, 0.5, 1, 2, 4]

// equal-weight average of % changes, taken in log terms so parts add to total
function blend(items) {
  if (!items.length) return null
  const out = { n: items.length }
  for (const k of KEYS) out[k] = Math.expm1(items.reduce((t, i) => t + Math.log1p(i[k]), 0) / items.length)
  return out
}

function takeaway(years, kind) {
  const ys = years.slice().sort((a, b) => a.year - b.year)
  if (ys.length < 2) return null
  const [a, b] = ys.slice(-2)
  const same = Math.abs(b.unwind - a.unwind) < 0.08
  const word = kind === 'single' ? 'top cards' : 'sealed'
  return `${b.year} ${word} gave back ${same ? 'about the same launch premium as' : b.unwind < a.unwind ? 'more launch premium than' : 'less launch premium than'} ${a.year}'s `
    + `(${fmtPct(b.unwind, 0)} vs ${fmtPct(a.unwind, 0)} from peak to settled). Since settling, the market has moved `
    + `${fmtPct(b.market, 0)} for ${b.year} sets against ${fmtPct(a.market, 0)} for ${a.year}'s`
    + `${same ? ' — that, not the launch, is most of the gap in how they look today.' : '.'}`
}

export default function MarketLaunch({ launch, palette, themeTick }) {
  const [kind, setKind] = useState('sealed')
  const [type, setType] = useState('all')
  const color = Object.fromEntries(PARTS.map(([k], i) => [k, palette.series[i]]))

  // product filter: sealed by product type; singles all top 10 or the #1 card
  const typeOpts = useMemo(() => {
    if (kind === 'single') return [['all', 'Top 10 cards'], ['top1', '#1 card only']]
    const n = {}
    for (const s of launch?.sets || []) for (const i of s.sealed?.items || []) n[i.type] = (n[i.type] || 0) + 1
    return [['all', 'All sealed'], ...Object.keys(n).sort((a, b) => n[b] - n[a]).map((t) => [t, TYPE_LABEL[t] || t])]
  }, [launch, kind])
  const pick = (items) => (type === 'all' ? items : type === 'top1' ? items.slice(0, 1) : items.filter((i) => i.type === type))

  // newest sets first in the table; the chart reverses this
  const sets = useMemo(() => (launch?.sets || []).map((s) => {
    const items = pick(s[kind]?.items || [])
    return items.length ? { ...s, items, b: blend(items), year: +String(s.releaseDate).slice(0, 4) } : null
  }).filter(Boolean), [launch, kind, type])
  const rows = useMemo(() => sets.slice().reverse(), [sets])
  const years = useMemo(() => {
    const by = {}
    for (const s of sets) (by[s.year] ||= []).push(...s.items)
    return Object.entries(by).map(([y, items]) => ({ year: +y, ...blend(items) })).sort((a, b) => a.year - b.year)
  }, [sets])
  if (!launch) return null

  const build = (width) => {
    const narrow = width < 560
    const data = rows.flatMap((s) => PARTS.map(([k, label]) => ({
      ab: s.ab, name: s.name, part: label, k, x: Math.log1p(s.b[k]), v: s.b[k], total: s.b.total,
    })))
    const totals = rows.map((s) => ({ ab: s.ab, x: Math.log1p(s.b.total), v: s.b.total }))
    const xs = data.map((d) => d.x)
    // stacked extent: positives and negatives stack separately
    const pos = Math.max(0.2, ...rows.map((s) => PARTS.reduce((t, [k]) => t + Math.max(0, Math.log1p(s.b[k])), 0)))
    const neg = Math.min(-0.2, ...rows.map((s) => PARTS.reduce((t, [k]) => t + Math.min(0, Math.log1p(s.b[k])), 0)), ...xs)
    return Plot.plot({
      width, height: 26 * rows.length + 40, marginLeft: narrow ? 52 : 64, marginRight: 46,
      style: { background: 'transparent', color: palette.textSecondary, fontSize: '11px' },
      x: { domain: [neg * 1.05, pos * 1.05], label: null, ticks: (narrow ? [-0.75, -0.5, 0, 1] : PCT_TICKS).map(Math.log1p).filter((t) => t >= neg && t <= pos),
           tickFormat: (d) => fmtPct(Math.expm1(d), 0), grid: true },
      y: { domain: rows.map((s) => s.ab), label: null },
      color: { domain: PARTS.map(([, l]) => l), range: PARTS.map(([k]) => color[k]) },
      marks: [
        Plot.barX(data, Plot.stackX({ x: 'x', y: 'ab', fill: 'part', order: PARTS.map(([, l]) => l), insetTop: 4, insetBottom: 4 })),
        Plot.ruleX([0], { stroke: palette.text, strokeOpacity: 0.55 }),
        // the total is the point of the row: a dot, ringed so it reads on any part
        Plot.dot(totals, { x: 'x', y: 'ab', r: 4, fill: palette.text, stroke: palette.surface, strokeWidth: 2 }),
        Plot.text(totals, { x: () => pos * 1.05, y: 'ab', text: (d) => fmtPct(d.v, 0), textAnchor: 'start', dx: 6,
                            fill: palette.text, fontSize: 11, fontWeight: 600 }),
        Plot.tip(data, Plot.pointerY(Plot.stackX({ x: 'x', y: 'ab', z: 'part', order: PARTS.map(([, l]) => l),
          title: (d) => `${d.name}\n${d.part}: ${fmtPct(d.v, 0)}\nPeak → now: ${fmtPct(d.total, 0)}` }))),
      ],
    })
  }

  const curveRows = Object.entries(launch.curve || {}).flatMap(([k, pts]) =>
    pts.map(([age, v]) => ({ k: k === 'single' ? 'Singles' : 'Sealed', age, v })))
  const curveColor = { Sealed: palette.series[0], Singles: palette.series[4] }
  const buildCurve = (width) => Plot.plot({
    width, height: 200, marginLeft: 44, marginRight: width < 500 ? 104 : 92,
    style: { background: 'transparent', color: palette.textSecondary, fontSize: '11px' },
    x: { label: width < 500 ? null : 'days since release →', ticks: width < 500 ? 4 : 8 },
    y: { grid: true, label: null, tickFormat: (d) => `${d > 0 ? '+' : ''}${Math.round(d * 100)}%` },
    color: { domain: Object.keys(curveColor), range: Object.values(curveColor) },
    marks: [
      Plot.ruleY([0], { stroke: palette.text, strokeOpacity: 0.55 }),
      Plot.lineY(curveRows, { x: 'age', y: 'v', stroke: 'k', strokeWidth: 2, curve: 'monotone-x' }),
      Plot.dot(curveRows, { x: 'age', y: 'v', fill: 'k', r: 2.5 }),
      Plot.text(curveRows, Plot.selectLast({ x: 'age', y: 'v', z: 'k', text: (d) => `${d.k} ${fmtPct(d.v, 0)}`,
        dx: 6, textAnchor: 'start', fill: palette.text, fontSize: 11 })),
      Plot.tip(curveRows, Plot.pointer({ x: 'age', y: 'v',
        title: (d) => `${d.k}, day ${d.age}\n${fmtPct(d.v, 0)} vs settled price, market move removed` })),
    ],
  })

  const board = launch.scoreboard || []
  const anchors = [...new Set(board.map((b) => b.anchor))]
  const cell = (a, k) => board.find((b) => b.anchor === a && b.kind === k)
  const tk = takeaway(years, kind)

  return (
    <Section id="launch" title="Launch hype vs the market"
      kicker="New sets launch at hyped prices that fade. This splits each set's move since its launch peak into how much was hype leaving and how much was the whole market moving."
      right={launch.hasSingles && <Seg value={kind} onChange={(k) => { setKind(k); setType('all') }} options={[['sealed', 'Sealed'], ['single', 'Top cards']]} />}>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="seg flex-wrap">
          {typeOpts.map(([v, t]) => (
            <button key={v} className="chip" data-on={String(type === v)} onClick={() => setType(v)}>{t}</button>
          ))}
        </div>
        <span className="muted text-xs">
          {type === 'all' ? 'Each set is the plain average of its products — every product counts the same, a $40 bundle as much as a $400 box.'
            : type === 'top1' ? 'Only each set’s most valuable card (by settled price).'
            : `Only the ${typeOpts.find(([v]) => v === type)?.[1]} from each set — like for like.`}
        </span>
      </div>
      <HowToRead label="What is the “settled price”?">
        <p>Prices for a new set are unreliable for the first few weeks: preorders trade thin, and early listings are asks with few sales behind them. By the second month the first rush is over, the product is on shelves and real sales have piled up.</p>
        <p>So the <b>settled price</b> is the middle sale price during the second month after release (days 30–59). Half of that month's prices were above it, half below. It is the baseline everything here is measured from — the table at the bottom shows it predicts later prices far better than the launch price does.</p>
      </HowToRead>
      {tk && <p className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>{tk}</p>}

      {/* phones: one compact table; wider: a card per release year */}
      <div className="card p-2 mb-2 sm:hidden">
        <table className="tbl text-xs w-full tabular-nums">
          <thead><tr><th>Released</th><th className="text-right">Launch unwind</th><th className="text-right">Market since</th><th className="text-right">Peak → now</th></tr></thead>
          <tbody>
            {years.map((y) => (
              <tr key={y.year}><td>{y.year}</td><td className="text-right"><P v={y.unwind} /></td>
                <td className="text-right"><P v={y.market} /></td><td className="text-right font-semibold"><P v={y.total} /></td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="hidden sm:grid sm:grid-cols-3 gap-2 mb-2">
        {years.map((y) => (
          <div key={y.year} className="card p-3">
            <div className="muted text-[11px] uppercase tracking-wide">{y.year} releases · {y.n} {y.n === 1 ? 'product' : 'products'}</div>
            <div className="grid grid-cols-3 gap-1 mt-1 text-xs">
              <div><div className="muted">Launch unwind</div><div className="text-lg font-semibold"><P v={y.unwind} /></div></div>
              <div><div className="muted">Market since</div><div className="text-lg font-semibold"><P v={y.market} /></div></div>
              <div><div className="muted">Peak → now</div><div className="text-lg font-semibold"><P v={y.total} /></div></div>
            </div>
          </div>
        ))}
      </div>

      <div className="card p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
          <Legend items={PARTS.map(([k, l]) => [l, color[k]])} />
          <span className="muted text-xs">● = peak → now (the parts add up to it)</span>
        </div>
        <PlotFigure build={build} deps={[rows, themeTick]} />
        <HowToRead>
          <p>One row per set, newest at the top. The <b>dot</b> is the answer: how far the price is from its launch peak today. The coloured pieces are the reasons, and they add up to the dot.</p>
          <p>Pieces left of the centre line pulled the price <b>down</b>; pieces to the right pushed it <b>up</b>. In order: <b>launch unwind</b> — hype leaving between the peak and the settled price; <b>normal decay</b> — what any product usually does after settling at that age (sealed holds roughly flat; cards keep sliding as more packs get opened); <b>market</b> — the whole market rising or falling over the same dates; <b>set-specific</b> — whatever is left, i.e. this set doing better (right) or worse (left) than a normal set would have.</p>
          <p>Example: a row with a long launch-unwind bar on the left, a market bar on the right and the dot near zero means “it fell a lot after launch, but the market has since lifted it back to about where it started.” A big set-specific bar is the interesting one — that is the set itself, not hype or the market.</p>
          <p>The scale is stretched so that −50% and +100% look the same length: halving and doubling are equal-sized moves.</p>
        </HowToRead>
      </div>

      <details className="card p-3 mt-2 min-w-0 overflow-hidden">
        <summary className="cursor-pointer text-sm font-medium">Table: every set, part by part</summary>
        <div className="overflow-x-auto mt-2">
          <table className="tbl text-xs w-full tabular-nums">
            <thead>
              <tr>
                <th>Set</th><th className="text-right">Age</th><th className="text-right">Peak → now</th>
                {PARTS.map(([k, l, hint]) => <th key={k} className="text-right" title={hint}>{l}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.slice().reverse().map((s) => (
                <tr key={s.groupId}>
                  <td><a href={`#/set/${s.groupId}`} className="hover:underline" style={{ color: 'var(--accent)' }}>{s.name}</a></td>
                  <td className="text-right muted">{s.age}d</td>
                  <td className="text-right font-semibold"><P v={s.b.total} /></td>
                  {PARTS.map(([k]) => <td key={k} className="text-right"><P v={s.b[k]} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 mt-2">
        <div className="card p-3 min-w-0">
          <h3 className="text-sm font-semibold">What's normal after settling</h3>
          <p className="muted text-[11px] mb-1">Typical change from the settled price by days since release, with the market's own move removed.</p>
          <PlotFigure build={buildCurve} deps={[curveRows, themeTick]} />
          <HowToRead>
            <p>Starts at 0% = the settled price. Each point is what a typical product was worth at that age compared with its settled price, after taking out whatever the whole market did. It is the “normal decay” piece above.</p>
            <p>A flat line means “holds its settled price”. A line sloping down means products of that kind keep losing value as they age, even in a flat market — top cards do, because every pack opened adds more copies.</p>
          </HowToRead>
        </div>
        <div className="card p-3 min-w-0 overflow-x-auto">
          <h3 className="text-sm font-semibold">Why days 30–59?</h3>
          <p className="muted text-[11px] mb-2">How often each starting price turned out more than 30% wrong about where the product stood three months after release (market move removed). Lower is better.</p>
          <table className="tbl text-xs w-full tabular-nums">
            <thead><tr><th>Starting point</th><th className="text-right">Sealed</th>{launch.hasSingles && <th className="text-right">Top cards</th>}</tr></thead>
            <tbody>
              {anchors.map((a) => (
                <tr key={a} style={a.includes('settled') ? { fontWeight: 600 } : undefined}>
                  <td>{ANCHOR_LABEL[a] || a}</td>
                  {['sealed', ...(launch.hasSingles ? ['single'] : [])].map((k) => {
                    const c = cell(a, k)
                    return (
                      <td key={k} className="text-right">
                        <div className="inline-flex items-center gap-2 justify-end">
                          <span className="inline-block h-1.5 rounded-full" style={{ width: `${(c?.miss30 || 0) * 70}px`, background: 'var(--accent)', opacity: 0.7 }} />
                          <span className="w-9">{c ? fmtShare(c.miss30) : '—'}</span>
                        </div>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <HowToRead>
            <p>Each row is a candidate “starting price”. For every product we asked: if you had used this as the fair price, how often was it badly off (more than 30%) by day 90? The settled price (days 30–59) is wrong far less often than the launch peak, which is why it is the baseline.</p>
          </HowToRead>
        </div>
      </div>
    </Section>
  )
}

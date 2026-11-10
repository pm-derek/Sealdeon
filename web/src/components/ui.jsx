// Shared dashboard building blocks: formatters, section scaffolding, chart
// helpers. One place, so every page formats and lays out the same way.

export const fmtPx = (v) => (v == null ? '—' : `$${v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(0)}`)
export const fmtPp = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)} pts`)
export const fmtShare = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)
// tolerate 'YYYY-MM-DD' or a full timestamp; one bad date must not blank the page
export const toDate = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00`)
export const toneOf = (v) => (v == null ? 'muted' : v > 0.005 ? 'pos' : v < -0.005 ? 'neg' : 'muted')

// End labels for line charts, pushed apart vertically so two lines ending at
// nearly the same value never print on top of each other. Works in data
// units: `px` is the label height in pixels, `plotPx` the plot's pixel height.
export function endLabels(rows, key, { lo, hi, plotPx, px = 14 }) {
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



export function LinkIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
      strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.7 }} aria-hidden="true">
      <path d="M14 3h7v7" /><path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  )
}

export function Stat({ label, value, sub, tone, hint }) {
  return (
    <div className="card p-3 min-w-0" title={hint}>
      <div className="muted text-[11px] uppercase tracking-wide truncate">{label}</div>
      <div className="text-2xl font-semibold tabular-nums leading-tight mt-0.5"
        style={{ color: tone && tone !== 'muted' ? `var(--${tone})` : 'var(--text-primary)' }}>{value}</div>
      {sub && <div className="muted text-xs mt-0.5 truncate">{sub}</div>}
    </div>
  )
}

export function Section({ id, title, kicker, children, right }) {
  return (
    // scroll-margin keeps a jumped-to section clear of the sticky header
    <section id={id} className="mt-6" style={{ scrollMarginTop: 'calc(var(--header-h, 52px) + 8px)' }}>
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

export function Seg({ value, onChange, options }) {
  return (
    <div className="seg flex-nowrap shrink-0">
      {options.map(([v, t]) => (
        <button key={v} className="chip" data-on={String(value === v)} onClick={() => onChange(v)}>{t}</button>
      ))}
    </div>
  )
}

export function Legend({ items }) {
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


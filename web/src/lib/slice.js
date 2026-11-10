// In-memory slicing of the loaded view JSON. All dashboard filters (era,
// product type, hype/clean, complete/partial, explicit set picks) are
// pure functions over already-loaded data -- no re-query, no network.

// Approximate modern US retail (MSRP, pre-tax) per sealed product type.
// Used as an alternative cohort baseline: indexing to release-day market
// price flatters hyped sets (their day-0 is already inflated), whereas
// indexing to retail shows appreciation over what you'd pay at a store.
// Chase Singles have no MSRP. Editable; era-specific values could refine.
export const MSRP = {
  'Booster Box': 144,
  'ETB': 50,
  'PKC ETB': 60,
  'Booster Bundle': 27,
  'UPC': 120,
}

export function eraMatch(era, eras) {
  return !eras || eras.length === 0 || eras.includes(era)
}

export function setIndex(meta) {
  const bySet = new Map()
  for (const s of meta.sets) bySet.set(s.groupId, s)
  return bySet
}

export function filterSets(meta, { eras = [], hype = 'all', completeness = 'complete', picked = null }) {
  return meta.sets.filter((s) => {
    if (picked && picked.size > 0) return picked.has(s.groupId)
    if (!eraMatch(s.era, eras)) return false
    if (hype === 'hype' && !s.isHype) return false
    if (hype === 'clean' && s.isHype) return false
    if (completeness === 'complete' && !s.archiveComplete) return false
    return true
  })
}

export function filterSeries(curves, meta, opts) {
  const keep = new Set(filterSets(meta, opts).map((s) => s.groupId))
  return curves.series.filter(
    (s) => keep.has(s.groupId) && s.seriesType === opts.seriesType,
  )
}

// Percentile band across the displayed cohort at each age.
export function cohortBand(seriesList, valueAt, maxAge = Infinity) {
  const byAge = new Map()
  for (const s of seriesList) {
    for (const pt of s.points) {
      const [age] = pt
      if (age > maxAge) continue
      const v = valueAt(pt)
      if (v == null) continue
      if (!byAge.has(age)) byAge.set(age, [])
      byAge.get(age).push(v)
    }
  }
  const out = []
  for (const [age, vals] of [...byAge.entries()].sort((a, b) => a[0] - b[0])) {
    if (vals.length < 2) continue
    vals.sort((a, b) => a - b)
    out.push({ age, p25: q(vals, 0.25), p50: q(vals, 0.5), p75: q(vals, 0.75), n: vals.length })
  }
  return out
}

function q(sorted, p) {
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

export const fmtPct = (v, digits = 1) =>
  v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`
export const fmtUsd = (v) =>
  v == null ? '—' : v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(2)}`

// ---- settled anchor ---------------------------------------------------------
// The SETTLED price is the median over days 30-59 after release. Launch-day
// prices are mostly hype -- sealed peaks in thin preorder trading, singles at
// prerelease with half the listings unsold -- so they make a poor baseline.
// Measured against what items did next (market removed), this window misses
// by >30% about 1 time in 15 for sealed vs ~9 in 10 from the launch peak.
// See pipeline/launch.py.
export const SETTLED_WINDOW = [30, 59]
export const MIN_SETTLED_OBS = 8

export function settledOf(points, rawAt = (pt) => pt[3]) {
  const vals = []
  for (const pt of points) {
    if (pt[0] >= SETTLED_WINDOW[0] && pt[0] <= SETTLED_WINDOW[1]) {
      const v = rawAt(pt)
      if (v != null && v > 0) vals.push(v)
    }
  }
  if (vals.length < MIN_SETTLED_OBS) return null
  vals.sort((a, b) => a - b)
  return q(vals, 0.5)
}

// Headline numbers for one cohort series: latest price, 30/90-day change,
// change vs its settled price, latest premium.
export function seriesStats(s) {
  const pts = s?.points
  if (!pts?.length) return null
  const raw = s.basketSize ? (pt) => (pt[3] == null ? null : pt[3] * s.basketSize) : (pt) => pt[3]
  const last = pts[pts.length - 1]
  const back = (days) => {
    let best = null
    for (const pt of pts) if (pt[0] <= last[0] - days) best = pt
    return best && last[0] - best[0] <= days + 10 ? raw(best) : null
  }
  const now = raw(last)
  const settled = settledOf(pts, raw)
  const ch = (then) => (now != null && then ? now / then - 1 : null)
  let prem = null
  for (let i = pts.length - 1; i >= 0 && prem == null; i--) prem = pts[i][2]
  return { now, age: last[0], chg30: ch(back(30)), chg90: ch(back(90)), settled, vsSettled: ch(settled), prem }
}

// In-memory slicing of the loaded view JSON. All dashboard filters (era,
// product type, hype/clean, complete/partial, explicit set picks) are
// pure functions over already-loaded data -- no re-query, no network.

export function setIndex(meta) {
  const bySet = new Map()
  for (const s of meta.sets) bySet.set(s.groupId, s)
  return bySet
}

export function filterSets(meta, { era = 'All', hype = 'all', completeness = 'complete', picked = null }) {
  return meta.sets.filter((s) => {
    if (picked && picked.size > 0) return picked.has(s.groupId)
    if (era !== 'All' && s.era !== era) return false
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

// Percentile band across the displayed cohort at each age: exact for
// whatever population the current filters select.
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

export function toWeeks(days) { return days / 7 }
export function toMonths(days) { return days / 30.44 }

export const fmtPct = (v, digits = 1) =>
  v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`
export const fmtUsd = (v) =>
  v == null ? '—' : v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(2)}`

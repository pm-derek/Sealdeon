import { useMemo, useState } from 'react'

// Ad-hoc multi-select set picker: pick an explicit list (hype-set
// comparisons etc.) that overrides the era/hype filters while active.
export default function SetPicker({ meta, picked, setPicked, focus, setFocus }) {
  const [query, setQuery] = useState('')
  const aliases = meta.aliases || {}
  const matches = useMemo(() => {
    const q = query.toLowerCase().trim()
    if (!q) return []
    const aliasHit = Object.entries(aliases).find(([k]) => k.toLowerCase() === q)
    return meta.sets
      .filter(
        (s) =>
          s.name?.toLowerCase().includes(q) ||
          s.abbreviation?.toLowerCase().includes(q) ||
          (aliasHit && s.name?.toLowerCase().includes(aliasHit[1].toLowerCase())),
      )
      .slice(0, 8)
  }, [query, meta])

  const toggle = (gid) => {
    const next = new Set(picked)
    next.has(gid) ? next.delete(gid) : next.add(gid)
    setPicked(next)
  }

  return (
    <div className="py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="muted text-xs uppercase tracking-wide">Compare sets</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search sets… (or use '151', 'Prismatic')"
          className="card px-2 py-1 text-sm w-64"
        />
        {[...picked].map((gid) => {
          const s = meta.sets.find((x) => x.groupId === gid)
          return (
            <button key={gid} className="chip" data-on="true" onClick={() => toggle(gid)}
              title="remove from comparison">
              {s?.abbreviation || s?.name || gid} ✕
            </button>
          )
        })}
        {picked.size > 0 && (
          <button className="chip" onClick={() => setPicked(new Set())}>clear</button>
        )}
      </div>
      {matches.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {matches.map((s) => (
            <button key={s.groupId} className="chip" data-on={String(picked.has(s.groupId))}
              onClick={() => { toggle(s.groupId); setQuery('') }}>
              {s.name} {s.isHype ? '🔥' : ''}
            </button>
          ))}
        </div>
      )}
      {setFocus && (
        <div className="flex items-center gap-2 mt-2">
          <span className="muted text-xs uppercase tracking-wide">Focus set</span>
          <select
            className="card px-2 py-1 text-sm"
            value={focus ?? ''}
            onChange={(e) => setFocus(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">(median band only)</option>
            {meta.sets.map((s) => (
              <option key={s.groupId} value={s.groupId}>{s.name}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}

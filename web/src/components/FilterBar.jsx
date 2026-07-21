// Shared one-row filter controls operating on in-memory view JSON.
function ChipGroup({ label, options, value, onChange }) {
  return (
    <div className="seg">
      {label && <span className="seg-label">{label}</span>}
      {options.map(([val, text]) => (
        <button key={val} className="chip" data-on={String(val === value)} onClick={() => onChange(val)}>
          {text}
        </button>
      ))}
    </div>
  )
}

// Multi-select era: click toggles each era; "All" clears the selection
// (empty = all eras). Overlappable, e.g. Mega Evolution + Scarlet & Violet.
function EraMulti({ eras, allEras, onChange }) {
  const toggle = (e) => {
    const next = eras.includes(e) ? eras.filter((x) => x !== e) : [...eras, e]
    onChange(next)
  }
  return (
    <div className="seg">
      <span className="seg-label">Era</span>
      <button className="chip" data-on={String(eras.length === 0)} onClick={() => onChange([])}>All</button>
      {allEras.map((e) => (
        <button key={e} className="chip" data-on={String(eras.includes(e))} onClick={() => toggle(e)}>{e}</button>
      ))}
    </div>
  )
}

export default function FilterBar({ meta, state, setState, show = {} }) {
  const allEras = [...new Set(meta.sets.map((s) => s.era).filter(Boolean))]
  const set = (k) => (v) => setState((s) => ({ ...s, [k]: v }))
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5 py-3">
      {show.era !== false && (
        <EraMulti eras={state.eras || []} allEras={allEras} onChange={set('eras')} />
      )}
      {show.seriesType !== false && (
        <ChipGroup
          label="Product"
          options={meta.seriesTypes.map((t) => [t, t])}
          value={state.seriesType}
          onChange={set('seriesType')}
        />
      )}
      {show.hype !== false && (
        <ChipGroup
          label="Hype"
          options={[['all', 'All'], ['hype', 'Hype only'], ['clean', 'Clean only']]}
          value={state.hype}
          onChange={set('hype')}
        />
      )}
      {show.completeness !== false && (
        <ChipGroup
          label="History"
          options={[['complete', 'Complete only'], ['all', 'Include partial']]}
          value={state.completeness}
          onChange={set('completeness')}
        />
      )}
    </div>
  )
}

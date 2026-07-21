// Compact filter toolbar. Single-select filters are dropdowns (to save
// space); era is multi-select chips (overlappable).
export function Dropdown({ label, value, onChange, options }) {
  return (
    <label className="inline-flex items-center gap-1.5">
      <span className="seg-label">{label}</span>
      <select className="field py-1" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    </label>
  )
}

function EraMulti({ eras, allEras, onChange }) {
  const toggle = (e) => onChange(eras.includes(e) ? eras.filter((x) => x !== e) : [...eras, e])
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
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 py-2">
      {show.era !== false && <EraMulti eras={state.eras || []} allEras={allEras} onChange={set('eras')} />}
      {show.seriesType !== false && (
        <Dropdown label="Product" value={state.seriesType} onChange={set('seriesType')}
          options={meta.seriesTypes.map((t) => [t, t])} />
      )}
      {show.hype !== false && (
        <Dropdown label="Hype" value={state.hype} onChange={set('hype')}
          options={[['all', 'All'], ['hype', 'Hype only'], ['clean', 'Clean only']]} />
      )}
      {show.completeness !== false && (
        <Dropdown label="History" value={state.completeness} onChange={set('completeness')}
          options={[['complete', 'Complete only'], ['all', 'Include partial']]} />
      )}
    </div>
  )
}

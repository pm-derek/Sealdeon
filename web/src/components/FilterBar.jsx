// Shared one-row filter controls operating on in-memory view JSON.
function ChipGroup({ label, options, value, onChange }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {label && <span className="muted text-xs uppercase tracking-wide mr-1">{label}</span>}
      {options.map(([val, text]) => (
        <button key={val} className="chip" data-on={String(val === value)} onClick={() => onChange(val)}>
          {text}
        </button>
      ))}
    </div>
  )
}

export default function FilterBar({ meta, state, setState, show = {} }) {
  const eras = ['All', ...new Set(meta.sets.map((s) => s.era).filter(Boolean))]
  const set = (k) => (v) => setState((s) => ({ ...s, [k]: v }))
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 py-3">
      {show.era !== false && (
        <ChipGroup label="Era" options={eras.map((e) => [e, e])} value={state.era} onChange={set('era')} />
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
      {show.metric && (
        <ChipGroup
          label="Metric"
          options={[['idx', 'Indexed price'], ['prem', 'Sealed premium %']]}
          value={state.metric}
          onChange={set('metric')}
        />
      )}
      {show.xUnit && (
        <ChipGroup
          label="X"
          options={[['days', 'Days'], ['weeks', 'Weeks'], ['months', 'Months']]}
          value={state.xUnit}
          onChange={set('xUnit')}
        />
      )}
    </div>
  )
}

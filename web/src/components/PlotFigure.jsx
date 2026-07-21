import { useEffect, useRef } from 'react'

// Mount an Observable Plot figure built by `build(width)`; rebuilds on
// resize and dependency change. If `onPick` is given, clicking the figure
// reports the Plot's current pointer value (the datum nearest the cursor),
// so callers can implement click-to-select on interactive charts.
export default function PlotFigure({ build, deps = [], onPick }) {
  const ref = useRef(null)
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    let fig = null
    const handleClick = () => {
      if (onPickRef.current && fig && fig.value != null) onPickRef.current(fig.value)
    }
    const render = () => {
      el.replaceChildren()
      const width = el.clientWidth || 640
      fig = build(width)
      if (fig) {
        fig.addEventListener('click', handleClick)
        el.append(fig)
      }
    }
    render()
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(render)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
      el.replaceChildren()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return <div ref={ref} className="w-full overflow-x-auto" style={{ cursor: onPick ? 'pointer' : 'default' }} />
}

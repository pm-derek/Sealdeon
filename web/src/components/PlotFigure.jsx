import { useEffect, useRef } from 'react'

// Mount an Observable Plot figure built by `build(width)`; rebuilds on
// resize and dependency change.
export default function PlotFigure({ build, deps = [] }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    const render = () => {
      el.replaceChildren()
      const width = el.clientWidth || 640
      const fig = build(width)
      if (fig) el.append(fig)
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
  return <div ref={ref} className="w-full overflow-x-auto" />
}

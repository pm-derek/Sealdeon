import { useEffect, useRef } from 'react'

function invertScale(s, px) {
  if (!s) return null
  if (typeof s.invert === 'function') return s.invert(px)
  if (!s.domain || !s.range) return null
  const [d0, d1] = s.domain, [r0, r1] = s.range
  return r1 === r0 ? d0 : d0 + ((px - r0) / (r1 - r0)) * (d1 - d0)
}

// Mount an Observable Plot figure with TradingView-style navigation:
//   - mouse wheel  -> zoom the x-axis around the cursor
//   - click-drag   -> pan the x-axis (grab and move the time window)
//   - double-click -> reset to the full range
//   - plain click  -> onPick (select the mark under the cursor)
// The parent owns the x-domain (view) and re-renders through build(); this
// component only computes the new domain and reports it via onView.
export default function PlotFigure({ build, deps = [], onPick, onView }) {
  const ref = useRef(null)
  const onPickRef = useRef(onPick); onPickRef.current = onPick
  const onViewRef = useRef(onView); onViewRef.current = onView

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    let fig = null
    let pan = null      // {startPx, dom0, dom1, dataPerPx}
    let dragged = false

    const xScale = () => (fig ? fig.scale('x') : null)

    const onWheel = (e) => {
      if (!onViewRef.current || !fig) return
      e.preventDefault()
      const sx = xScale(); if (!sx?.domain) return
      const [d0, d1] = sx.domain
      const rect = el.getBoundingClientRect()
      const cx = invertScale(sx, e.clientX - rect.left)
      if (cx == null) return
      const factor = e.deltaY < 0 ? 0.82 : 1.22 // in / out
      const n0 = cx - (cx - d0) * factor
      const n1 = cx + (d1 - cx) * factor
      if (n1 - n0 < 1) return // don't over-zoom past ~1 day
      onViewRef.current([n0, n1])
    }
    const onDown = (e) => {
      if (!onViewRef.current || e.button !== 0 || !fig) return
      const sx = xScale(); if (!sx?.domain || !sx?.range) return
      const [d0, d1] = sx.domain, [r0, r1] = sx.range
      pan = { startPx: e.clientX, dom0: d0, dom1: d1, dataPerPx: (d1 - d0) / (r1 - r0) }
      dragged = false
    }
    const onMove = (e) => {
      if (!pan) return
      const totalPx = e.clientX - pan.startPx
      if (Math.abs(totalPx) > 3) dragged = true
      if (!dragged) return
      const shift = -totalPx * pan.dataPerPx
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => onViewRef.current([pan.dom0 + shift, pan.dom1 + shift]))
    }
    const onUp = () => { pan = null }
    const onClick = () => {
      if (dragged) { dragged = false; return }
      if (onPickRef.current && fig && fig.value != null) onPickRef.current(fig.value)
    }
    const onDbl = () => { if (onViewRef.current) onViewRef.current(null) }

    const render = () => {
      el.replaceChildren()
      fig = build(el.clientWidth || 640)
      if (fig) el.appendChild(fig)
    }
    render()
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    el.addEventListener('click', onClick)
    el.addEventListener('dblclick', onDbl)
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(render) })
    ro.observe(el)
    return () => {
      ro.disconnect(); cancelAnimationFrame(raf)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      el.removeEventListener('click', onClick)
      el.removeEventListener('dblclick', onDbl)
      el.replaceChildren()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return (
    <div ref={ref} className="w-full overflow-x-auto select-none"
      style={{ cursor: onView ? 'grab' : onPick ? 'pointer' : 'default' }} />
  )
}

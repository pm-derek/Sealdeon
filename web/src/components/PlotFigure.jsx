import { useEffect, useRef } from 'react'

// Convert a pixel position back to a data value using a Plot scale
// descriptor. Uses scale.invert when available, else linear interpolation
// from domain/range (works for the inverted y range too).
function invertScale(s, px) {
  if (!s) return null
  if (typeof s.invert === 'function') return s.invert(px)
  if (!s.domain || !s.range) return null
  const [d0, d1] = s.domain
  const [r0, r1] = s.range
  if (r1 === r0) return d0
  return d0 + ((px - r0) / (r1 - r0)) * (d1 - d0)
}

// Mount an Observable Plot figure built by `build(width)`; rebuilds on
// resize / dependency change.
//  - onPick: click a mark to select (reads the plot's pointer value).
//  - onZoom: click-drag a box to zoom (reports {x:[a,b], y:[a,b]} in data
//    coords); double-click clears (reports null). TradingView-style.
export default function PlotFigure({ build, deps = [], onPick, onZoom }) {
  const ref = useRef(null)
  const onPickRef = useRef(onPick); onPickRef.current = onPick
  const onZoomRef = useRef(onZoom); onZoomRef.current = onZoom

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    let fig = null
    let drag = null
    let boxEl = null
    let dragged = false

    const clearBox = () => { if (boxEl) { boxEl.remove(); boxEl = null } }

    const onDown = (e) => {
      if (!onZoomRef.current || e.button !== 0) return
      const rect = el.getBoundingClientRect()
      drag = { x0: e.clientX - rect.left, y0: e.clientY - rect.top }
      dragged = false
    }
    const onMove = (e) => {
      if (!drag) return
      const rect = el.getBoundingClientRect()
      const x1 = e.clientX - rect.left, y1 = e.clientY - rect.top
      if (Math.abs(x1 - drag.x0) > 4 || Math.abs(y1 - drag.y0) > 4) dragged = true
      if (!dragged) return
      if (!boxEl) { boxEl = document.createElement('div'); boxEl.className = 'zoombox'; el.appendChild(boxEl) }
      Object.assign(boxEl.style, {
        left: Math.min(drag.x0, x1) + 'px', top: Math.min(drag.y0, y1) + 'px',
        width: Math.abs(x1 - drag.x0) + 'px', height: Math.abs(y1 - drag.y0) + 'px',
      })
    }
    const onUp = (e) => {
      if (!drag) return
      const rect = el.getBoundingClientRect()
      const x1 = e.clientX - rect.left, y1 = e.clientY - rect.top
      const wasDrag = dragged
      clearBox()
      const d = drag; drag = null
      if (!wasDrag || !fig || !onZoomRef.current) return
      try {
        const sx = fig.scale('x'), sy = fig.scale('y')
        const xs = [invertScale(sx, d.x0), invertScale(sx, x1)].sort((a, b) => a - b)
        const ys = [invertScale(sy, d.y0), invertScale(sy, y1)].sort((a, b) => a - b)
        if (xs.every((n) => n != null) && ys.every((n) => n != null)) {
          onZoomRef.current({ x: xs, y: ys })
        }
      } catch { /* ignore */ }
    }
    const onClick = () => {
      if (dragged) { dragged = false; return } // a zoom drag, not a pick
      if (onPickRef.current && fig && fig.value != null) onPickRef.current(fig.value)
    }
    const onDbl = () => { if (onZoomRef.current) onZoomRef.current(null) }

    const render = () => {
      el.replaceChildren(); clearBox()
      fig = build(el.clientWidth || 640)
      if (fig) el.appendChild(fig)
    }
    render()
    el.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    el.addEventListener('click', onClick)
    el.addEventListener('dblclick', onDbl)
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(render) })
    ro.observe(el)
    return () => {
      ro.disconnect(); cancelAnimationFrame(raf)
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
    <div ref={ref} className="w-full overflow-x-auto"
      style={{ position: 'relative', cursor: onZoom ? 'crosshair' : onPick ? 'pointer' : 'default' }} />
  )
}

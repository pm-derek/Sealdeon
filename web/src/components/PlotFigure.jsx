import { useCallback, useEffect, useRef } from 'react'

function invertScale(s, px) {
  if (!s) return null
  if (typeof s.invert === 'function') return s.invert(px)
  if (!s.domain || !s.range) return null
  const [d0, d1] = s.domain, [r0, r1] = s.range
  return r1 === r0 ? d0 : d0 + ((px - r0) / (r1 - r0)) * (d1 - d0)
}

// Zoom a [d0,d1] domain around center c by factor, in log space for log axes.
function zoomDomain(scale, c, factor) {
  const [d0, d1] = scale.domain
  if (scale.type === 'log' && d0 > 0 && d1 > 0 && c > 0) {
    const l0 = Math.log(d0), l1 = Math.log(d1), lc = Math.log(c)
    return [Math.exp(lc - (lc - l0) * factor), Math.exp(lc + (l1 - lc) * factor)]
  }
  return [c - (c - d0) * factor, c + (d1 - c) * factor]
}

// Observable Plot figure with TradingView-style navigation:
//   wheel over plot -> zoom X · wheel over Y-axis or Shift+wheel -> zoom Y
//   drag -> pan X · double-click -> reset · click -> onPick
// Event listeners are attached ONCE and read the current figure via a ref,
// so an in-progress drag survives the re-renders that zoom/pan trigger.
// onView reports patches: {x:[..]} / {y:[..]} / null (reset).
export default function PlotFigure({ build, deps = [], onPick, onView }) {
  const elRef = useRef(null)
  const figRef = useRef(null)
  const buildRef = useRef(build); buildRef.current = build
  const onPickRef = useRef(onPick); onPickRef.current = onPick
  const onViewRef = useRef(onView); onViewRef.current = onView

  const doRender = useCallback(() => {
    const el = elRef.current
    if (!el) return
    el.replaceChildren()
    figRef.current = buildRef.current(el.clientWidth || 640)
    if (figRef.current) el.appendChild(figRef.current)
  }, [])

  // Re-render whenever the parent's data/view deps change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { doRender() }, deps)

  // Attach interaction listeners once; they read figRef.current each time.
  useEffect(() => {
    const el = elRef.current
    if (!el) return
    let raf = 0, pan = null, dragged = false

    const onWheel = (e) => {
      const fig = figRef.current
      if (!onViewRef.current || !fig) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const px = e.clientX - rect.left, py = e.clientY - rect.top
      const factor = e.deltaY < 0 ? 0.82 : 1.22
      const sx = fig.scale('x'), sy = fig.scale('y')
      const overYAxis = sx?.range && px < sx.range[0]
      if ((e.shiftKey || overYAxis) && sy?.domain) {
        const cy = invertScale(sy, py); if (cy == null) return
        onViewRef.current({ y: zoomDomain(sy, cy, factor) })
      } else if (sx?.domain) {
        const cx = invertScale(sx, px); if (cx == null) return
        const [n0, n1] = zoomDomain(sx, cx, factor)
        if (n1 - n0 < 1) return
        onViewRef.current({ x: [n0, n1] })
      }
    }
    const onDown = (e) => {
      const fig = figRef.current
      if (!onViewRef.current || e.button !== 0 || !fig) return
      const sx = fig.scale('x'); if (!sx?.domain || !sx?.range) return
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
      raf = requestAnimationFrame(() => onViewRef.current({ x: [pan.dom0 + shift, pan.dom1 + shift] }))
    }
    const onUp = () => { pan = null }
    const onClick = () => {
      if (dragged) { dragged = false; return }
      const fig = figRef.current
      if (onPickRef.current && fig && fig.value != null) onPickRef.current(fig.value)
    }
    const onDbl = () => { if (onViewRef.current) onViewRef.current(null) }

    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    el.addEventListener('click', onClick)
    el.addEventListener('dblclick', onDbl)
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(doRender) })
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
  }, [doRender])

  return (
    <div ref={elRef} className="w-full overflow-hidden select-none"
      style={{ cursor: onView ? 'grab' : onPick ? 'pointer' : 'default' }} />
  )
}

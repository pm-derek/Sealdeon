import { useCallback, useEffect, useRef } from 'react'

function invertScale(s, px) {
  if (!s) return null
  if (typeof s.invert === 'function') return s.invert(px)
  if (!s.domain || !s.range) return null
  const [d0, d1] = s.domain, [r0, r1] = s.range
  return r1 === r0 ? d0 : d0 + ((px - r0) / (r1 - r0)) * (d1 - d0)
}
function applyScale(s, v) {
  if (typeof s.apply === 'function') return s.apply(v)
  const [d0, d1] = s.domain, [r0, r1] = s.range
  return r0 + ((v - d0) / (d1 - d0)) * (r1 - r0)
}
function zoomFrom(domain, isLog, c, factor) {
  const [d0, d1] = domain
  if (isLog && d0 > 0 && d1 > 0 && c > 0) {
    const l0 = Math.log(d0), l1 = Math.log(d1), lc = Math.log(c)
    return [Math.exp(lc - (lc - l0) * factor), Math.exp(lc + (l1 - lc) * factor)]
  }
  return [c - (c - d0) * factor, c + (d1 - c) * factor]
}
function zoomDomain(scale, c, factor) {
  return zoomFrom(scale.domain, scale.type === 'log', c, factor)
}
const touchDist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)

// Observable Plot figure with TradingView navigation:
//   wheel -> zoom X (Shift or over Y-axis -> zoom Y) · drag -> pan X+Y
//   double-click -> reset · click -> onPick
// `labelData` (optional): [{groupId, text, color, points:[{x,value}]}].
// Rendered as clickable HTML overlays at each line's last in-view point,
// so a label is an exact click target (no snapping) -- onLabelClick(id).
export default function PlotFigure({ build, deps = [], onPick, onView, labelData, onLabelClick }) {
  const elRef = useRef(null)
  const figRef = useRef(null)
  const buildRef = useRef(build); buildRef.current = build
  const onPickRef = useRef(onPick); onPickRef.current = onPick
  const onViewRef = useRef(onView); onViewRef.current = onView
  const labelRef = useRef(labelData); labelRef.current = labelData
  const onLabelClickRef = useRef(onLabelClick); onLabelClickRef.current = onLabelClick

  const placeLabels = useCallback(() => {
    const el = elRef.current, fig = figRef.current
    if (!el) return
    el.querySelectorAll('.linelabel').forEach((n) => n.remove())
    if (!fig || !labelRef.current) return
    const sx = fig.scale('x'), sy = fig.scale('y')
    if (!sx?.domain || !sy?.domain) return
    const [xlo, xhi] = sx.domain
    const ylo = Math.min(sy.domain[0], sy.domain[1]), yhi = Math.max(sy.domain[0], sy.domain[1])
    for (const L of labelRef.current) {
      // last point within the visible x-window
      let pt = null
      for (const p of L.points) if (p.x >= xlo && p.x <= xhi) pt = p
      if (!pt || pt.value < ylo || pt.value > yhi) continue
      const px = applyScale(sx, pt.x), py = applyScale(sy, pt.value)
      const btn = document.createElement('button')
      btn.className = 'linelabel'
      btn.textContent = L.text
      btn.style.left = `${px + 4}px`
      btn.style.top = `${py}px`
      btn.style.color = L.color
      btn.onclick = (e) => { e.stopPropagation(); onLabelClickRef.current?.(L.groupId) }
      el.appendChild(btn)
    }
  }, [])

  const doRender = useCallback(() => {
    const el = elRef.current
    if (!el) return
    el.querySelectorAll('.linelabel').forEach((n) => n.remove())
    const svg = figRef.current
    if (svg) svg.remove()
    figRef.current = buildRef.current(el.clientWidth || 640)
    if (figRef.current) el.insertBefore(figRef.current, el.firstChild)
    placeLabels()
  }, [placeLabels])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { doRender() }, deps)

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
      const sx = fig.scale('x'), sy = fig.scale('y')
      if (!sx?.domain || !sx?.range) return
      pan = {
        startX: e.clientX, startY: e.clientY,
        xd: [...sx.domain], xPerPx: (sx.domain[1] - sx.domain[0]) / (sx.range[1] - sx.range[0]),
        yd: sy?.domain ? [...sy.domain] : null, yLog: sy?.type === 'log',
        yr: sy?.range || null,
      }
      dragged = false
    }
    const onMove = (e) => {
      if (!pan) return
      const dx = e.clientX - pan.startX, dy = e.clientY - pan.startY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragged = true
      if (!dragged) return
      const patch = { x: [pan.xd[0] - dx * pan.xPerPx, pan.xd[1] - dx * pan.xPerPx] }
      if (pan.yd && pan.yr) {
        if (pan.yLog && pan.yd[0] > 0 && pan.yd[1] > 0) {
          const l0 = Math.log(pan.yd[0]), l1 = Math.log(pan.yd[1])
          const lPerPx = (l1 - l0) / (pan.yr[1] - pan.yr[0])
          patch.y = [Math.exp(l0 - dy * lPerPx), Math.exp(l1 - dy * lPerPx)]
        } else {
          const yPerPx = (pan.yd[1] - pan.yd[0]) / (pan.yr[1] - pan.yr[0])
          patch.y = [pan.yd[0] - dy * yPerPx, pan.yd[1] - dy * yPerPx]
        }
      }
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => onViewRef.current(patch))
    }
    const onUp = () => { pan = null }
    const onClick = () => {
      if (dragged) { dragged = false; return }
      const fig = figRef.current
      if (onPickRef.current && fig && fig.value != null) onPickRef.current(fig.value)
    }
    const onDbl = () => { if (onViewRef.current) onViewRef.current(null) }

    // ---- Touch: 1 finger = pan (X+Y), 2 fingers = pinch-zoom, ----
    // ---- double-tap = reset, tap = pick ----
    let tpan = null, tpinch = null, tmoved = false, lastTap = 0
    const relXY = (t) => {
      const r = el.getBoundingClientRect()
      return { x: t.clientX - r.left, y: t.clientY - r.top }
    }
    const startPan = (t) => {
      const fig = figRef.current; if (!fig) return
      const sx = fig.scale('x'), sy = fig.scale('y')
      if (!sx?.domain || !sx?.range) return
      tpan = {
        startX: t.clientX, startY: t.clientY,
        xd: [...sx.domain], xPerPx: (sx.domain[1] - sx.domain[0]) / (sx.range[1] - sx.range[0]),
        yd: sy?.domain ? [...sy.domain] : null, yLog: sy?.type === 'log', yr: sy?.range || null,
      }
    }
    const onTouchStart = (e) => {
      if (!onViewRef.current || !figRef.current) return
      tmoved = false
      if (e.touches.length === 1) { startPan(e.touches[0]); tpinch = null }
      else if (e.touches.length === 2) {
        tpan = null
        const fig = figRef.current, sx = fig.scale('x'), sy = fig.scale('y')
        const a = relXY(e.touches[0]), b = relXY(e.touches[1])
        tpinch = {
          d0: touchDist(e.touches[0], e.touches[1]),
          cx: invertScale(sx, (a.x + b.x) / 2), cy: sy ? invertScale(sy, (a.y + b.y) / 2) : null,
          xd: [...sx.domain], yd: sy?.domain ? [...sy.domain] : null, yLog: sy?.type === 'log',
        }
      }
      e.preventDefault()
    }
    const onTouchMove = (e) => {
      if (!onViewRef.current) return
      e.preventDefault()
      if (e.touches.length === 2 && tpinch) {
        const d = touchDist(e.touches[0], e.touches[1]); if (!d) return
        const factor = Math.max(0.1, Math.min(6, tpinch.d0 / d))
        const patch = { x: zoomFrom(tpinch.xd, false, tpinch.cx, factor) }
        if (tpinch.yd && tpinch.cy != null) patch.y = zoomFrom(tpinch.yd, tpinch.yLog, tpinch.cy, factor)
        tmoved = true
        cancelAnimationFrame(raf); raf = requestAnimationFrame(() => onViewRef.current(patch))
      } else if (e.touches.length === 1 && tpan) {
        const t = e.touches[0]
        const dx = t.clientX - tpan.startX, dy = t.clientY - tpan.startY
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) tmoved = true
        if (!tmoved) return
        const patch = { x: [tpan.xd[0] - dx * tpan.xPerPx, tpan.xd[1] - dx * tpan.xPerPx] }
        if (tpan.yd && tpan.yr) {
          if (tpan.yLog && tpan.yd[0] > 0 && tpan.yd[1] > 0) {
            const l0 = Math.log(tpan.yd[0]), l1 = Math.log(tpan.yd[1]), lPerPx = (l1 - l0) / (tpan.yr[1] - tpan.yr[0])
            patch.y = [Math.exp(l0 - dy * lPerPx), Math.exp(l1 - dy * lPerPx)]
          } else {
            const yPerPx = (tpan.yd[1] - tpan.yd[0]) / (tpan.yr[1] - tpan.yr[0])
            patch.y = [tpan.yd[0] - dy * yPerPx, tpan.yd[1] - dy * yPerPx]
          }
        }
        cancelAnimationFrame(raf); raf = requestAnimationFrame(() => onViewRef.current(patch))
      }
    }
    const onTouchEnd = (e) => {
      if (e.touches.length < 2) tpinch = null
      if (e.touches.length === 0) {
        if (tpan && !tmoved) {
          const now = Date.now()
          if (now - lastTap < 320) { onViewRef.current?.(null); lastTap = 0 }
          else {
            lastTap = now
            const fig = figRef.current
            if (onPickRef.current && fig && fig.value != null) onPickRef.current(fig.value)
          }
        }
        tpan = null
      }
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    el.addEventListener('click', onClick)
    el.addEventListener('dblclick', onDbl)
    el.addEventListener('touchstart', onTouchStart, { passive: false })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
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
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.querySelectorAll('.linelabel').forEach((n) => n.remove())
    }
  }, [doRender])

  return (
    <div ref={elRef} className="w-full overflow-hidden select-none"
      style={{ position: 'relative', touchAction: onView ? 'none' : 'auto',
               cursor: onView ? 'grab' : onPick ? 'pointer' : 'default' }} />
  )
}

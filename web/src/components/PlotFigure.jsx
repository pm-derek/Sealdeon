import { useCallback, useEffect, useRef } from 'react'

// Touch-primary device? On phones/tablets the Plot hover tooltip actively
// fights pinch/drag/axis-zoom gestures, so we disable the SVG's pointer
// interaction entirely there and pick lines via our own hit-test instead.
const COARSE = typeof window !== 'undefined'
  && window.matchMedia && window.matchMedia('(pointer: coarse)').matches

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

// Which region of the chart a pointer is over, from the scale pixel ranges.
// Y-axis = the strip left of the plot area; X-axis = the strip below it.
function regionAt(px, py, sx, sy) {
  if (sx?.range && px < Math.min(sx.range[0], sx.range[1])) return 'yaxis'
  if (sy?.range && py > Math.max(sy.range[0], sy.range[1])) return 'xaxis'
  return 'plot'
}

// Observable Plot figure with TradingView / Robinhood navigation.
//   Desktop: wheel -> zoom X (Shift or over Y-axis -> zoom Y) · drag plot -> pan ·
//            drag Y-axis -> stretch Y · drag X-axis -> stretch X · dbl-click -> reset ·
//            hover -> tooltip · click line -> select
//   Touch:   1-finger drag on plot -> pan · drag on an axis -> stretch that axis ·
//            2-finger pinch -> zoom+pan both · double-tap -> reset · tap -> select line
// On touch devices the SVG's pointer interaction is switched OFF so the hover
// tooltip can never hijack a gesture; line selection is done by hit-testing
// `hitData` against the tap position instead.
// `labelData` (optional): [{groupId, text, color, points:[{x,value}]}] rendered as
// clickable HTML overlays -- an exact click target (no snapping) -> onLabelClick(id).
// `hitData` (optional): [{groupId, points:[{x,value}]}] in data coords, used for
// touch tap selection.
export default function PlotFigure({ build, deps = [], onPick, onView, labelData, onLabelClick, hitData }) {
  const elRef = useRef(null)
  const figRef = useRef(null)
  const buildRef = useRef(build); buildRef.current = build
  const onPickRef = useRef(onPick); onPickRef.current = onPick
  const onViewRef = useRef(onView); onViewRef.current = onView
  const labelRef = useRef(labelData); labelRef.current = labelData
  const onLabelClickRef = useRef(onLabelClick); onLabelClickRef.current = onLabelClick
  const hitRef = useRef(hitData); hitRef.current = hitData

  // On coarse-pointer devices, an interactive (pannable) chart keeps its SVG
  // pointer-events OFF by default so Plot.tip never fires during a gesture.
  const tipOffByDefault = () => COARSE && !!onViewRef.current

  const applyTip = (forceOff) => {
    const svg = figRef.current
    if (!svg) return
    const off = forceOff || tipOffByDefault()
    svg.style.pointerEvents = off ? 'none' : ''
    svg.querySelectorAll('[aria-label="tip"]').forEach((g) => { g.style.display = off ? 'none' : '' })
  }

  const placeLabels = useCallback(() => {
    const el = elRef.current, fig = figRef.current
    if (!el) return
    el.querySelectorAll('.linelabel').forEach((n) => n.remove())
    if (!fig || !labelRef.current) return
    const sx = fig.scale('x'), sy = fig.scale('y')
    if (!sx?.domain || !sy?.domain) return
    const [xlo, xhi] = sx.domain
    // plot-area pixel bounds for Y, so a label whose point is off the top/
    // bottom of the current zoom stays pinned to the edge (always visible)
    // rather than disappearing -- matching how the X side already behaves.
    const yr = sy.range || [0, 0]
    const pTop = Math.min(yr[0], yr[1]), pBot = Math.max(yr[0], yr[1])
    for (const L of labelRef.current) {
      // last point within the visible x-window
      let pt = null
      for (const p of L.points) if (p.x >= xlo && p.x <= xhi) pt = p
      if (!pt) continue
      const px = applyScale(sx, pt.x)
      const rawY = applyScale(sy, pt.value)
      // A label pinned to the edge sits at a value it does NOT have, which
      // reads as a wrong price. Keep it visible (so Y-zoom doesn't lose the
      // line) but mark it off-scale with an arrow + its real value.
      const off = rawY < pTop ? 'up' : rawY > pBot ? 'down' : null
      const py = Math.max(pTop, Math.min(pBot, rawY))
      const btn = document.createElement('button')
      btn.className = 'linelabel'
      btn.textContent = off ? `${off === 'up' ? '↑' : '↓'} ${L.text}` : L.text
      if (off) {
        btn.dataset.offscale = 'true'
        btn.title = `${L.text} is off-scale here (${L.fmt ? L.fmt(pt.value) : pt.value})`
      }
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
    applyTip(false)   // establish the default tip state for this device
    placeLabels()
  }, [placeLabels])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { doRender() }, deps)

  useEffect(() => {
    const el = elRef.current
    if (!el) return
    let raf = 0, pan = null, dragged = false

    const rel = (clientX, clientY) => {
      const r = el.getBoundingClientRect()
      return { x: clientX - r.left, y: clientY - r.top }
    }

    // Nearest line to a pixel position, using data-coord hitData. Returns a
    // groupId (or null) so touch taps can select without the Plot tooltip.
    const hitTest = (px, py) => {
      const fig = figRef.current, data = hitRef.current
      if (!fig || !data?.length) return null
      const sx = fig.scale('x'), sy = fig.scale('y')
      if (!sx || !sy) return null
      const TH = 36 * 36
      let bestGid = null, bestD = TH
      for (const L of data) {
        for (const p of L.points) {
          const dx = applyScale(sx, p.x) - px, dy = applyScale(sy, p.value) - py
          const dd = dx * dx + dy * dy
          if (dd < bestD) { bestD = dd; bestGid = L.groupId }
        }
      }
      return bestGid
    }
    const doPick = (px, py) => {
      const gid = hitTest(px, py)
      if (gid != null) { onPickRef.current?.({ groupId: gid }); return }
      const fig = figRef.current
      if (fig && fig.value != null) onPickRef.current?.(fig.value)
    }

    // Begin a gesture from a single pointer: pan on the plot body, or a
    // one-axis stretch when it starts on that axis' strip.
    const startGesture = (clientX, clientY) => {
      const fig = figRef.current
      if (!fig) return null
      const sx = fig.scale('x'), sy = fig.scale('y')
      if (!sx?.domain || !sx?.range) return null
      const { x: px, y: py } = rel(clientX, clientY)
      const region = regionAt(px, py, sx, sy)
      return {
        region, startX: clientX, startY: clientY,
        xd: [...sx.domain], xLog: sx.type === 'log', xr: [...sx.range],
        xPerPx: (sx.domain[1] - sx.domain[0]) / (sx.range[1] - sx.range[0]),
        yd: sy?.domain ? [...sy.domain] : null, yLog: sy?.type === 'log', yr: sy?.range || null,
        cx: invertScale(sx, px), cy: sy ? invertScale(sy, py) : null,
      }
    }

    // Turn an in-flight gesture + current pointer into a view patch.
    const gesturePatch = (g, clientX, clientY) => {
      const dx = clientX - g.startX, dy = clientY - g.startY
      if (g.region === 'yaxis' && g.yd && g.cy != null) {
        // vertical drag on Y-axis stretches Y: down = zoom out, up = zoom in
        return { y: zoomFrom(g.yd, g.yLog, g.cy, Math.exp(dy / 170)) }
      }
      if (g.region === 'xaxis' && g.cx != null) {
        // horizontal drag on X-axis stretches X: right = zoom out, left = zoom in
        const [n0, n1] = zoomFrom(g.xd, g.xLog, g.cx, Math.exp(dx / 170))
        return n1 - n0 < 1 ? null : { x: [n0, n1] }
      }
      // plot body: pan on both axes
      const patch = { x: [g.xd[0] - dx * g.xPerPx, g.xd[1] - dx * g.xPerPx] }
      if (g.yd && g.yr) {
        if (g.yLog && g.yd[0] > 0 && g.yd[1] > 0) {
          const l0 = Math.log(g.yd[0]), l1 = Math.log(g.yd[1]), lPerPx = (l1 - l0) / (g.yr[1] - g.yr[0])
          patch.y = [Math.exp(l0 - dy * lPerPx), Math.exp(l1 - dy * lPerPx)]
        } else {
          const yPerPx = (g.yd[1] - g.yd[0]) / (g.yr[1] - g.yr[0])
          patch.y = [g.yd[0] - dy * yPerPx, g.yd[1] - dy * yPerPx]
        }
      }
      return patch
    }

    const pushPatch = (patch) => {
      if (!patch) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => onViewRef.current(patch))
    }

    // ---------------- Mouse (desktop) ----------------
    const onWheel = (e) => {
      const fig = figRef.current
      if (!onViewRef.current || !fig) return
      e.preventDefault()
      const { x: px, y: py } = rel(e.clientX, e.clientY)
      const factor = e.deltaY < 0 ? 0.82 : 1.22
      const sx = fig.scale('x'), sy = fig.scale('y')
      const overYAxis = sx?.range && px < Math.min(sx.range[0], sx.range[1])
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
      if (!onViewRef.current || e.button !== 0) return
      pan = startGesture(e.clientX, e.clientY)
      dragged = false
    }
    const onMove = (e) => {
      if (!pan) return
      if (Math.abs(e.clientX - pan.startX) > 3 || Math.abs(e.clientY - pan.startY) > 3) {
        if (!dragged) applyTip(true)
        dragged = true
      }
      if (!dragged) return
      pushPatch(gesturePatch(pan, e.clientX, e.clientY))
    }
    const onUp = () => { pan = null; if (dragged) applyTip(false) }
    const onClick = () => {
      if (dragged) { dragged = false; return }
      const fig = figRef.current
      if (onPickRef.current && fig && fig.value != null) onPickRef.current(fig.value)
    }
    const onDbl = () => { if (onViewRef.current) onViewRef.current(null) }

    // ---------------- Touch ----------------
    // The container uses touch-action: pan-y, so the browser keeps vertical
    // scrolling. We only claim a one-finger gesture once it proves to be
    // horizontal (tdir==='h'); a vertical swipe scrolls the page as normal.
    // Two fingers always mean the chart (pinch-zoom).
    let tgest = null, tpinch = null, tmoved = false, lastTap = 0, tdir = null
    const onTouchStart = (e) => {
      if (!onViewRef.current || !figRef.current) return
      tmoved = false
      tdir = null
      if (e.touches.length === 1) {
        tgest = startGesture(e.touches[0].clientX, e.touches[0].clientY)
        tpinch = null
        return   // don't preventDefault yet -- direction is still unknown
      } else if (e.touches.length === 2) {
        tgest = null
        const fig = figRef.current, sx = fig.scale('x'), sy = fig.scale('y')
        const a = rel(e.touches[0].clientX, e.touches[0].clientY)
        const b = rel(e.touches[1].clientX, e.touches[1].clientY)
        tpinch = {
          d0: touchDist(e.touches[0], e.touches[1]),
          cx: invertScale(sx, (a.x + b.x) / 2), cy: sy ? invertScale(sy, (a.y + b.y) / 2) : null,
          xr: sx?.range ? [...sx.range] : null, yr: sy?.range ? [...sy.range] : null,
          xd: [...sx.domain], xLog: sx.type === 'log',
          yd: sy?.domain ? [...sy.domain] : null, yLog: sy?.type === 'log',
        }
      }
      applyTip(true)   // no tooltip for the duration of any touch
      e.preventDefault()
    }
    const onTouchMove = (e) => {
      if (!onViewRef.current) return
      // One finger: decide the axis once, then either claim the gesture
      // (horizontal -> chart) or bail out and let the page scroll (vertical).
      if (e.touches.length === 1 && tgest) {
        const t = e.touches[0]
        const dx = t.clientX - tgest.startX, dy = t.clientY - tgest.startY
        if (tdir === null) {
          if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return       // still ambiguous
          tdir = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'
          if (tdir === 'v') { tgest = null; return }             // page scrolls
          applyTip(true)
          tmoved = true
        }
      }
      if (e.cancelable) e.preventDefault()
      if (e.touches.length >= 2 && tpinch) {
        const d = touchDist(e.touches[0], e.touches[1]); if (!d) return
        const factor = Math.max(0.1, Math.min(6, tpinch.d0 / d))
        const a = rel(e.touches[0].clientX, e.touches[0].clientY)
        const b = rel(e.touches[1].clientX, e.touches[1].clientY)
        // zoom by finger spread, and pan so the data point under the initial
        // pinch centre tracks the CURRENT finger centre (natural pinch-drag).
        const patch = {}
        if (tpinch.cx != null && tpinch.xr) {
          const w = (tpinch.xd[1] - tpinch.xd[0]) * factor
          const fx = (((a.x + b.x) / 2) - tpinch.xr[0]) / (tpinch.xr[1] - tpinch.xr[0])
          patch.x = [tpinch.cx - fx * w, tpinch.cx + (1 - fx) * w]
        } else {
          patch.x = zoomFrom(tpinch.xd, tpinch.xLog, tpinch.cx, factor)
        }
        if (tpinch.yd && tpinch.cy != null) patch.y = zoomFrom(tpinch.yd, tpinch.yLog, tpinch.cy, factor)
        tmoved = true
        pushPatch(patch)
      } else if (e.touches.length === 1 && tgest && tdir === 'h') {
        const t = e.touches[0]
        pushPatch(gesturePatch(tgest, t.clientX, t.clientY))
      }
    }
    const onTouchEnd = (e) => {
      if (e.touches.length < 2) tpinch = null
      if (e.touches.length === 0) {
        if (tgest && !tmoved && tgest.region === 'plot') {
          const now = e.timeStamp || 0
          if (now - lastTap < 320) { onViewRef.current?.(null); lastTap = 0 }
          else {
            lastTap = now
            const { x, y } = rel(tgest.startX, tgest.startY)
            doPick(x, y)
          }
        }
        tgest = null
        tdir = null
        applyTip(false)   // back to device default (still off on coarse)
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
    // touch-action: pan-y keeps native vertical page scrolling over the chart
    // (a chart that swallows vertical swipes traps the page); horizontal
    // gestures and pinches are still ours.
    <div ref={elRef} className="w-full overflow-hidden select-none"
      style={{ position: 'relative', touchAction: onView ? 'pan-y' : 'auto',
               cursor: onView ? 'grab' : onPick ? 'pointer' : 'default' }} />
  )
}

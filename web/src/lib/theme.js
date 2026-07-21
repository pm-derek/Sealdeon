import { useEffect, useState } from 'react'

// Read the CSS role tokens at render time so Plot marks always match the
// active (light/dark) theme; re-render charts when the OS theme flips.
export function paletteFromCss() {
  const css = getComputedStyle(document.documentElement)
  const v = (name) => css.getPropertyValue(name).trim()
  return {
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--series-${i}`)),
    context: v('--context-line'),
    band: v('--band-fill'),
    grid: v('--grid'),
    text: v('--text-primary'),
    textSecondary: v('--text-secondary'),
    surface: v('--surface-1'),
    pos: v('--pos'),
    neg: v('--neg'),
  }
}

export function useTheme() {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setTick((t) => t + 1)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return { palette: paletteFromCss(), themeTick: tick }
}

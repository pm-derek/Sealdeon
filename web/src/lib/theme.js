import { useEffect, useState } from 'react'

const KEY = 'sealdeon-theme'

// Default to dark unless the user has explicitly chosen otherwise.
export function initTheme() {
  const saved = localStorage.getItem(KEY)
  document.documentElement.setAttribute('data-theme', saved || 'dark')
}

export function useThemeMode() {
  const [mode, setMode] = useState(
    () => document.documentElement.getAttribute('data-theme') || 'dark',
  )
  const set = (next) => {
    document.documentElement.setAttribute('data-theme', next)
    localStorage.setItem(KEY, next)
    setMode(next)
  }
  const toggle = () => set(mode === 'dark' ? 'light' : 'dark')
  return { mode, toggle }
}

// Read CSS role tokens at render time so Plot marks match the active theme.
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
    accent: v('--accent'),
    pos: v('--pos'),
    neg: v('--neg'),
  }
}

// Re-render charts when the theme changes (OS flip or manual toggle).
export function useTheme() {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setTick((t) => t + 1)
    mq.addEventListener('change', onChange)
    const obs = new MutationObserver(onChange)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => { mq.removeEventListener('change', onChange); obs.disconnect() }
  }, [])
  return { palette: paletteFromCss(), themeTick: tick }
}

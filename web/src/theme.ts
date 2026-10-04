export type AppTheme = 'edition' | 'night'
export const THEME_STORAGE_KEY = 'peufmreader.app-theme'
export const DEFAULT_THEME: AppTheme = 'edition'

// Keep the persisted IDs stable when the visual design and display names evolve.
export const APP_THEMES = {
  edition: { label: '青竹书院', themeColor: '#F2F3EA' },
  night: { label: '墨蓝星图', themeColor: '#101E2A' },
} as const satisfies Record<AppTheme, { label: string; themeColor: string }>

export function parseTheme(value: string | null): AppTheme {
  return value === 'night' ? 'night' : DEFAULT_THEME
}

export function loadTheme(): AppTheme {
  try { return parseTheme(window.localStorage.getItem(THEME_STORAGE_KEY)) } catch { return DEFAULT_THEME }
}

export function saveTheme(theme: AppTheme): void {
  // Storage can be disabled or full. Switching still works for the current page.
  try { window.localStorage.setItem(THEME_STORAGE_KEY, theme) } catch { /* best effort */ }
}

export function applyTheme(theme: AppTheme): void {
  document.documentElement.dataset.appTheme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', APP_THEMES[theme].themeColor)
}

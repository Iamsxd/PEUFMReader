// Concrete skins. Persisted IDs stay stable when visual design and labels evolve.
export type AppTheme = 'edition' | 'night' | 'sakura' | 'amber' | 'ink' | 'ocean' | 'aurora'
// A stored preference may also follow the operating system light/dark setting.
export type AppThemePreference = AppTheme | 'auto'
export type AppThemeTone = 'light' | 'dark'
// "classic" keeps the editorial square/serif layout; "modern" uses rounded pills and glow.
export type AppThemeStyle = 'classic' | 'modern'

export const THEME_STORAGE_KEY = 'peufmreader.app-theme'
export const DEFAULT_THEME: AppTheme = 'edition'

export interface AppThemeDefinition {
  label: string
  description: string
  themeColor: string
  tone: AppThemeTone
  style: AppThemeStyle
  /** page, surface, accent: used for the picker swatch only. */
  swatch: readonly [string, string, string]
}

export const APP_THEMES = {
  edition: { label: '青竹书院', description: '竹青宣纸·宋体', themeColor: '#F2F3EA', tone: 'light', style: 'classic', swatch: ['#f2f3ea', '#e7ebdf', '#2d6a4f'] },
  sakura: { label: '樱雪信笺', description: '樱粉信纸·玫红', themeColor: '#F8F1F0', tone: 'light', style: 'classic', swatch: ['#f8f1f0', '#f2e2e3', '#a8435f'] },
  amber: { label: '暖阳书房', description: '木色琥珀·暖调', themeColor: '#F6EFE4', tone: 'light', style: 'classic', swatch: ['#f6efe4', '#ecdfca', '#9a4a16'] },
  ink: { label: '素墨极简', description: '黑白灰·专注', themeColor: '#F6F6F4', tone: 'light', style: 'modern', swatch: ['#f6f6f4', '#ebebe8', '#18181b'] },
  ocean: { label: '海盐晴空', description: '蓝白通透·清爽', themeColor: '#EEF4F8', tone: 'light', style: 'modern', swatch: ['#eef4f8', '#dfeaf3', '#1f64a8'] },
  night: { label: '墨蓝星图', description: '深海墨蓝·星光', themeColor: '#101E2A', tone: 'dark', style: 'modern', swatch: ['#101e2a', '#243b4c', '#8fc9ee'] },
  aurora: { label: '极光紫夜', description: '暗夜紫调·极光', themeColor: '#14111F', tone: 'dark', style: 'modern', swatch: ['#14111f', '#2a2440', '#b9a2ff'] },
} as const satisfies Record<AppTheme, AppThemeDefinition>

export const APP_THEME_IDS = Object.keys(APP_THEMES) as AppTheme[]
export const AUTO_THEME = { label: '跟随系统', description: '浅色用青竹书院，深色用墨蓝星图' } as const
const AUTO_LIGHT: AppTheme = 'edition'
const AUTO_DARK: AppTheme = 'night'

export function isAppTheme(value: unknown): value is AppTheme {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(APP_THEMES, value)
}

export function parseThemePreference(value: string | null): AppThemePreference {
  if (value === 'auto') return 'auto'
  return isAppTheme(value) ? value : DEFAULT_THEME
}

/** Concrete theme for a stored value; `auto` resolves with the current system tone. */
export function parseTheme(value: string | null, prefersDark = systemPrefersDark()): AppTheme {
  return resolveTheme(parseThemePreference(value), prefersDark)
}

export function resolveTheme(preference: AppThemePreference, prefersDark = systemPrefersDark()): AppTheme {
  if (preference !== 'auto') return preference
  return prefersDark ? AUTO_DARK : AUTO_LIGHT
}

export function systemPrefersDark(): boolean {
  try { return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true } catch { return false }
}

export function loadThemePreference(): AppThemePreference {
  try { return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY)) } catch { return DEFAULT_THEME }
}

export function loadTheme(): AppTheme {
  return resolveTheme(loadThemePreference())
}

export function saveTheme(theme: AppThemePreference): void {
  // Storage can be disabled or full. Switching still works for the current page.
  try { window.localStorage.setItem(THEME_STORAGE_KEY, theme) } catch { /* best effort */ }
}

export function applyTheme(theme: AppTheme): void {
  const definition = APP_THEMES[theme]
  const { dataset } = document.documentElement
  dataset.appTheme = theme
  dataset.appTone = definition.tone
  dataset.appStyle = definition.style
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', definition.themeColor)
}

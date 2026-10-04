import { afterEach, describe, expect, it, vi } from 'vitest'
import initialHTML from '../index.html?raw'
import manifestJSON from '../public/site.webmanifest?raw'
import { APP_THEMES, applyTheme, DEFAULT_THEME, loadTheme, parseTheme, saveTheme, THEME_STORAGE_KEY } from './theme'
import { EPUB_PREFERENCES_KEY } from './epub'
import { PDF_PREFERENCES_KEY } from './pdf'

afterEach(() => vi.unstubAllGlobals())
describe('application theme preferences', () => {
  it('only accepts supported themes and keeps the existing default and preference key', () => {
    expect(DEFAULT_THEME).toBe('edition')
    expect(THEME_STORAGE_KEY).toBe('peufmreader.app-theme')
    expect(parseTheme('night')).toBe('night')
    for (const value of [null, '', 'edition', 'invalid', '__proto__']) expect(parseTheme(value)).toBe(DEFAULT_THEME)
  })
  it.each(['edition', 'night'] as const)('restores the existing %s preference with the new display design', theme => {
    vi.stubGlobal('window', { localStorage: { getItem: vi.fn(() => theme) } })
    expect(loadTheme()).toBe(theme)
    expect(APP_THEMES[theme].label).toBe(theme === 'edition' ? '青竹书院' : '墨蓝星图')
  })
  it('loads and stores the preference without touching reader settings', () => {
    const getItem = vi.fn(() => 'night')
    const setItem = vi.fn()
    vi.stubGlobal('window', { localStorage: { getItem, setItem } })
    expect(loadTheme()).toBe('night')
    expect(getItem).toHaveBeenCalledWith(THEME_STORAGE_KEY)
    saveTheme('edition')
    expect(setItem).toHaveBeenCalledExactlyOnceWith(THEME_STORAGE_KEY, 'edition')
  })
  it('keeps saved EPUB and PDF preferences untouched by interface theme changes', () => {
    const epubPreference = JSON.stringify({ flow: 'continuous', layout: 'single', fontSize: 125, theme: 'sepia' })
    const pdfPreference = JSON.stringify({ flow: 'paged', layout: 'spread', zoomMode: 'custom', zoomPercent: 150 })
    const storage = new Map([[EPUB_PREFERENCES_KEY, epubPreference], [PDF_PREFERENCES_KEY, pdfPreference]])
    vi.stubGlobal('window', { localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    } })
    saveTheme('night')
    expect(loadTheme()).toBe('night')
    saveTheme('edition')
    expect(loadTheme()).toBe('edition')
    expect(storage.get(EPUB_PREFERENCES_KEY)).toBe(epubPreference)
    expect(storage.get(PDF_PREFERENCES_KEY)).toBe(pdfPreference)
    expect(storage.size).toBe(3)
  })
  it.each(['edition', 'night'] as const)('applies %s to the application and browser chrome only', theme => {
    const setAttribute = vi.fn()
    const querySelector = vi.fn(() => ({ setAttribute }))
    const dataset = { appTheme: 'edition', readerTheme: 'sepia' }
    vi.stubGlobal('document', { documentElement: { dataset }, querySelector })
    applyTheme(theme)
    expect(dataset).toEqual({ appTheme: theme, readerTheme: 'sepia' })
    expect(querySelector).toHaveBeenCalledExactlyOnceWith('meta[name="theme-color"]')
    expect(setAttribute).toHaveBeenCalledExactlyOnceWith('content', theme === 'edition' ? '#F2F3EA' : '#101E2A')
  })
  it('can apply an interface theme without a theme-color meta tag', () => {
    const dataset: Record<string, string> = {}
    vi.stubGlobal('document', { documentElement: { dataset }, querySelector: () => null })
    expect(() => applyTheme('night')).not.toThrow()
    expect(dataset.appTheme).toBe('night')
  })
  it('uses the day theme for the initial HTML and PWA launch metadata', () => {
    const manifest = JSON.parse(manifestJSON) as { theme_color: string; background_color: string }
    expect(initialHTML).toContain(`<meta name="theme-color" content="${APP_THEMES.edition.themeColor}"`)
    expect(initialHTML).toContain(`html { background: ${APP_THEMES.edition.themeColor}; }`)
    expect(manifest.theme_color).toBe(APP_THEMES.edition.themeColor)
    expect(manifest.background_color).toBe(APP_THEMES.edition.themeColor)
  })
  it('survives storage being denied', () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('SecurityError') } })
    expect(loadTheme()).toBe(DEFAULT_THEME)
    expect(() => saveTheme('night')).not.toThrow()
  })
})

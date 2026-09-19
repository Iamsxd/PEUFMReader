import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_THEME, loadTheme, parseTheme, saveTheme, THEME_STORAGE_KEY } from './theme'

afterEach(() => vi.unstubAllGlobals())
describe('application theme preferences', () => {
  it('only accepts supported themes and defaults to the literary edition', () => {
    expect(parseTheme('night')).toBe('night')
    for (const value of [null, '', 'edition', 'invalid', '__proto__']) expect(parseTheme(value)).toBe(DEFAULT_THEME)
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
  it('survives storage being denied', () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('SecurityError') } })
    expect(loadTheme()).toBe(DEFAULT_THEME)
    expect(() => saveTheme('night')).not.toThrow()
  })
})

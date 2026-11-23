import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  APP_THEME_IDS, APP_THEMES, applyTheme, AUTO_THEME, loadThemePreference, parseThemePreference, resolveTheme,
  saveTheme, systemPrefersDark, THEME_STORAGE_KEY, type AppTheme, type AppThemePreference,
} from '../theme'

interface ThemeContextValue {
  /** Concrete skin currently painted. */
  theme: AppTheme
  /** Stored choice, which may be `auto`. */
  preference: AppThemePreference
  setTheme: (theme: AppThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue>({ theme: 'edition', preference: 'edition', setTheme: () => {} })

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, updatePreference] = useState(loadThemePreference)
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark)
  const theme = resolveTheme(preference, prefersDark)
  useLayoutEffect(() => applyTheme(theme), [theme])
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) updatePreference(parseThemePreference(event.newValue))
    }
    window.addEventListener('storage', sync)
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    const followSystem = (event: MediaQueryListEvent) => setPrefersDark(event.matches)
    media?.addEventListener?.('change', followSystem)
    return () => {
      window.removeEventListener('storage', sync)
      media?.removeEventListener?.('change', followSystem)
    }
  }, [])
  function setTheme(next: AppThemePreference) {
    saveTheme(next)
    updatePreference(next)
  }
  return <ThemeContext.Provider value={{ theme, preference, setTheme }}>{children}</ThemeContext.Provider>
}

export const useAppTheme = () => useContext(ThemeContext)

function ThemeSwatch({ colors }: { colors: readonly [string, string, string] }) {
  const [page, surface, accent] = colors
  return (
    <span className="theme-swatch" aria-hidden="true" style={{ background: page }}>
      <i style={{ background: surface }} />
      <b style={{ background: accent }} />
    </span>
  )
}

const AUTO_SWATCH = [`linear-gradient(135deg, ${APP_THEMES.edition.swatch[0]} 50%, ${APP_THEMES.night.swatch[0]} 50%)`, APP_THEMES.edition.swatch[1], APP_THEMES.night.swatch[2]] as const

/** Visual skin gallery. Only the application shell changes; reader colours are set inside the reader. */
export function ThemeSwitch() {
  const { theme, preference, setTheme } = useAppTheme()
  const menuRef = useRef<HTMLDetailsElement>(null)
  const current = preference === 'auto' ? AUTO_THEME : APP_THEMES[theme]

  useEffect(() => {
    const close = (event: Event) => {
      const menu = menuRef.current
      if (!menu?.open) return
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return
        menu.open = false
        menu.querySelector('summary')?.focus()
        return
      }
      if (!menu.contains(event.target as Node)) menu.open = false
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [])


  return (
    <details className="theme-switch" ref={menuRef}>
      <summary aria-label={`界面主题：${current.label}`} title="切换界面皮肤；阅读器配色可在阅读工具“外观”中独立设置">
        <ThemeSwatch colors={preference === 'auto' ? AUTO_SWATCH : APP_THEMES[theme].swatch} />
        <span className="theme-switch-label">{current.label}</span>
        <span aria-hidden="true" className="theme-switch-caret">⌄</span>
      </summary>
      <div className="theme-gallery" role="radiogroup" aria-label="界面主题">
        <p className="theme-gallery-title">界面皮肤<small>只影响书库界面，不改变阅读器配色</small></p>
        {APP_THEME_IDS.map((id) => {
          const item = APP_THEMES[id]
          return (
            <label key={id} className={`theme-option${preference === id ? ' active' : ''}`}>
              <input type="radio" name="app-theme" value={id} checked={preference === id} onChange={() => setTheme(id)} aria-label={item.label} />
              <ThemeSwatch colors={item.swatch} />
              <span><strong>{item.label}</strong><small>{item.description}</small></span>
            </label>
          )
        })}
        <label className={`theme-option theme-option-auto${preference === 'auto' ? ' active' : ''}`}>
          <input type="radio" name="app-theme" value="auto" checked={preference === 'auto'} onChange={() => setTheme('auto')} aria-label={AUTO_THEME.label} />
          <ThemeSwatch colors={AUTO_SWATCH} />
          <span><strong>{AUTO_THEME.label}</strong><small>{AUTO_THEME.description}</small></span>
        </label>
      </div>
    </details>
  )
}

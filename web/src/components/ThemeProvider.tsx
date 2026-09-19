import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { applyTheme, loadTheme, parseTheme, saveTheme, THEME_STORAGE_KEY, type AppTheme } from '../theme'

const ThemeContext = createContext<{ theme: AppTheme; setTheme: (theme: AppTheme) => void }>({ theme: 'edition', setTheme: () => {} })

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, updateTheme] = useState(loadTheme)
  useLayoutEffect(() => applyTheme(theme), [theme])
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) updateTheme(parseTheme(event.newValue))
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])
  function setTheme(next: AppTheme) {
    saveTheme(next)
    updateTheme(next)
  }
  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>
}

export const useAppTheme = () => useContext(ThemeContext)

export function ThemeSwitch() {
  const { theme, setTheme } = useAppTheme()
  return <label className="theme-switch"><span>界面主题</span><select aria-label="界面主题" value={theme} onChange={(event) => setTheme(parseTheme(event.target.value))}><option value="edition">文学杂志</option><option value="night">深夜书房</option></select></label>
}

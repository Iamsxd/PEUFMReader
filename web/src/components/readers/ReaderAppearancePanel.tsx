import type { CSSProperties, ReactNode } from 'react'
import { getReaderComfortOverlay, READER_THEME_IDS, READER_THEMES, type ReaderComfort, type ReaderTheme } from '../../readerAppearance'

interface Props {
  label: string
  theme: ReaderTheme
  onThemeChange: (theme: ReaderTheme) => void
  comfort: ReaderComfort
  onComfortChange: (comfort: ReaderComfort) => void
  onClose: () => void
  onChromeActivity: () => void
  /** Format-specific note shown under the skin grid. */
  themeNote?: string
  /** Format-specific rows (font size, etc.) shown above the comfort sliders. */
  children?: ReactNode
}

export function ReaderAppearancePanel({ label, theme, onThemeChange, comfort, onComfortChange, onClose, onChromeActivity, themeNote, children }: Props) {
  return (
    <aside className="reader-side-panel reader-appearance-panel" aria-label={label} onPointerDown={onChromeActivity} onFocusCapture={onChromeActivity}>
      <header>
        <strong>阅读外观</strong>
        <button onClick={onClose} aria-label="关闭侧栏">×</button>
      </header>
      <div className="reader-appearance-controls">
        <section>
          <h3>阅读皮肤</h3>
          <div className="reader-theme-grid" role="group" aria-label="阅读主题">
            {READER_THEME_IDS.map((id) => {
              const item = READER_THEMES[id]
              return (
                <button
                  key={id}
                  className={`reader-theme-card${theme === id ? ' active' : ''}`}
                  aria-pressed={theme === id}
                  aria-label={item.label}
                  title={item.description}
                  onClick={() => onThemeChange(id)}
                  style={{ '--card-page': item.page, '--card-ink': item.ink, '--card-link': item.link } as CSSProperties}
                >
                  <span className="reader-theme-sample" aria-hidden="true"><b>Aa</b><i /><i /></span>
                  <span className="reader-theme-name">{item.label}</span>
                </button>
              )
            })}
          </div>
          {themeNote && <p className="epub-settings-scope">{themeNote}</p>}
        </section>
        {children}
        <section>
          <h3>护眼调节</h3>
          <label className="reader-range">
            <span>亮度 <output>{comfort.brightness}%</output></span>
            <input aria-label="屏幕亮度" type="range" min="40" max="100" step="5" value={comfort.brightness} onChange={(event) => onComfortChange({ ...comfort, brightness: Number(event.target.value) })} />
          </label>
          <label className="reader-range">
            <span>暖色滤镜 <output>{comfort.warmth === 0 ? '关闭' : `${comfort.warmth}%`}</output></span>
            <input aria-label="暖色滤镜" type="range" min="0" max="60" step="5" value={comfort.warmth} onChange={(event) => onComfortChange({ ...comfort, warmth: Number(event.target.value) })} />
          </label>
          <p className="epub-settings-scope">亮度与暖色只在本应用内叠加一层滤镜，不改变系统亮度；设置保存在当前设备，对 PDF 和 EPUB 通用。</p>
          {(comfort.brightness !== 100 || comfort.warmth !== 0) && <button className="reader-appearance-reset" onClick={() => onComfortChange({ brightness: 100, warmth: 0 })}>恢复默认亮度</button>}
        </section>
      </div>
    </aside>
  )
}

/** Dimming and night-light layer above the page, below every reader control. */
export function ReaderComfortLayer({ comfort }: { comfort: ReaderComfort }) {
  const overlay = getReaderComfortOverlay(comfort)
  if (overlay.dim === 0 && overlay.warmth === 0) return null
  return (
    <div className="reader-comfort-layer" aria-hidden="true">
      {overlay.warmth > 0 && <i className="reader-comfort-warmth" style={{ opacity: overlay.warmth }} />}
      {overlay.dim > 0 && <i className="reader-comfort-dim" style={{ opacity: overlay.dim }} />}
    </div>
  )
}

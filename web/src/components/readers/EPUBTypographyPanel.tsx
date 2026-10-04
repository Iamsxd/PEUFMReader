import { useEffect, useRef } from 'react'
import type { EPUBFontFamily, EPUBTypographyPreferences } from '../../epub'
import './EPUBTypographyPanel.css'

interface Props {
  preferences: EPUBTypographyPreferences
  onChange: (preferences: EPUBTypographyPreferences) => void
  onReset: () => void
  onClose: () => void
  onChromeActivity: () => void
}

export function EPUBTypographyPanel({ preferences, onChange, onReset, onClose, onChromeActivity }: Props) {
  const firstControlRef = useRef<HTMLInputElement>(null)
  useEffect(() => { firstControlRef.current?.focus({ preventScroll: true }) }, [])

  function updateNumber(name: 'lineHeight' | 'paragraphSpacing' | 'sideMargin' | 'maxLineWidth', value: number) {
    onChange({ ...preferences, [name]: value })
  }

  return (
    <aside className="reader-side-panel epub-typography-panel" aria-label="EPUB 排版设置" onPointerDown={onChromeActivity} onFocusCapture={onChromeActivity}>
      <header>
        <strong>正文排版</strong>
        <button onClick={onClose} aria-label="关闭侧栏">×</button>
      </header>
      <div className="epub-typography-controls">
        <p className="epub-settings-scope">保存为当前浏览器的 EPUB 默认设置，不同步到其他设备。不会重新下载书籍；调整排版会停止当前朗读。</p>
        <label className="epub-book-styles-toggle">
          <input ref={firstControlRef} type="checkbox" checked={preferences.respectBookStyles} onChange={(event) => onChange({ ...preferences, respectBookStyles: event.target.checked })} />
          <span>尊重原书排版</span>
        </label>
        <p className="epub-settings-scope">开启后保留作者字体、行距、段距和留白；工具栏的字号与阅读主题仍可独立调整。</p>
        <fieldset disabled={preferences.respectBookStyles}>
          <label>
            <span>正文字体</span>
            <select aria-label="正文字体" value={preferences.fontFamily} onChange={(event) => onChange({ ...preferences, fontFamily: event.target.value as EPUBFontFamily })}>
              <option value="serif">宋体 / 衬线</option>
              <option value="sans">黑体 / 无衬线</option>
              <option value="system">系统默认</option>
            </select>
          </label>
          <p className="epub-settings-scope">使用设备已有字体；缺少中文字体时由系统回退，不下载网络字体。</p>
          <label>
            <span>行距 <output>{preferences.lineHeight.toFixed(1)} 倍</output></span>
            <input aria-label="行距" type="range" min="1.2" max="2.4" step="0.1" value={preferences.lineHeight} onChange={(event) => updateNumber('lineHeight', Number(event.target.value))} />
          </label>
          <label>
            <span>段距 <output>{preferences.paragraphSpacing.toFixed(1)} em</output></span>
            <input aria-label="段距" type="range" min="0" max="2" step="0.1" value={preferences.paragraphSpacing} onChange={(event) => updateNumber('paragraphSpacing', Number(event.target.value))} />
          </label>
          <label>
            <span>左右留白 <output>{preferences.sideMargin}%</output></span>
            <input aria-label="左右留白" type="range" min="0" max="12" step="1" value={preferences.sideMargin} onChange={(event) => updateNumber('sideMargin', Number(event.target.value))} />
          </label>
          <label>
            <span>最大行宽 <output>{preferences.maxLineWidth} ch</output></span>
            <input aria-label="最大行宽" type="range" min="36" max="96" step="2" value={preferences.maxLineWidth} onChange={(event) => updateNumber('maxLineWidth', Number(event.target.value))} />
          </label>
        </fieldset>
        <button className="epub-reset-typography" onClick={onReset}>重置排版</button>
        <p className="epub-settings-scope">重置只恢复本面板；不会清除阅读进度、字号、主题、书签或笔记。</p>
      </div>
    </aside>
  )
}

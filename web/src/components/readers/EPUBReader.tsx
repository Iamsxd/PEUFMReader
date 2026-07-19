import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ePub, { type Book, type Contents, type Rendition } from 'epubjs'
import { api } from '../../api'
import {
  clampEPUBFontSize,
  EPUB_PREFERENCES_KEY,
  normalizeEPUBWheelDelta,
  parseEPUBPreferences,
} from '../../epub'
import type { EPUBPageFlow, EPUBPageLayout, EPUBReaderPreferences, EPUBTheme } from '../../epub'
import type { BookFile, ReadingState } from '../../types'
import { clampProgress } from '../../utils'

interface Props {
  book: BookFile
  initialState: ReadingState
  chromeVisible: boolean
  onChromeActivity: () => void
  onHideChrome: () => void
  onProgress: (position: Record<string, unknown>, progress: number) => Promise<void>
}

interface RelocatedLocation {
  start: { cfi: string; href?: string; percentage?: number }
  atStart?: boolean
  atEnd?: boolean
}

const EPUB_THEMES: Record<EPUBTheme, Record<string, Record<string, string>>> = {
  paper: {
    'html, body': { color: '#19231d', background: '#f8f5ed' },
    a: { color: '#27613f' },
  },
  sepia: {
    'html, body': { color: '#3d3022', background: '#eee2c8' },
    a: { color: '#765322' },
  },
  night: {
    'html, body': { color: '#d8ded9', background: '#18211c' },
    a: { color: '#91c8a1' },
  },
}

function readPreferences(): EPUBReaderPreferences {
  try {
    return parseEPUBPreferences(window.localStorage.getItem(EPUB_PREFERENCES_KEY))
  } catch {
    return parseEPUBPreferences(null)
  }
}

export function EPUBReader({ book, initialState, chromeVisible, onChromeActivity, onHideChrome, onProgress }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const bookRef = useRef<Book | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const wheelResetTimerRef = useRef<number | null>(null)
  const wheelAccumulatorRef = useRef(0)
  const wheelLockedUntilRef = useRef(0)
  const [preferences, setPreferences] = useState(readPreferences)
  const preferencesRef = useRef(preferences)
  const [isNarrow, setIsNarrow] = useState(window.innerWidth <= 780)
  const [progress, setProgress] = useState(clampProgress(initialState.overallProgress))
  const [atStart, setAtStart] = useState(initialState.overallProgress <= 0)
  const [atEnd, setAtEnd] = useState(initialState.overallProgress >= 0.999)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  preferencesRef.current = preferences

  const effectiveLayout: EPUBPageLayout = preferences.flow === 'continuous' || isNarrow ? 'single' : preferences.layout

  const turnPage = useCallback((direction: -1 | 1) => {
    const rendition = renditionRef.current
    if (!rendition) return
    void (direction < 0 ? rendition.prev() : rendition.next()).catch(() => setError('EPUB 翻页失败。'))
  }, [])

  const updateFontSize = useCallback((delta: number) => {
    setPreferences((current) => ({ ...current, fontSize: clampEPUBFontSize(current.fontSize + delta) }))
  }, [])

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null
    if (target?.matches('input, select, textarea, button')) return
    if (event.key === 'Tab') {
      onChromeActivity()
      return
    }
    if (event.key === 'Escape') {
      onHideChrome()
      return
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      updateFontSize(10)
    } else if (event.key === '-') {
      event.preventDefault()
      updateFontSize(-10)
    } else if (event.key === 'ArrowLeft' || (preferencesRef.current.flow === 'paged' && event.key === 'PageUp')) {
      event.preventDefault()
      turnPage(-1)
    } else if (event.key === 'ArrowRight' || (preferencesRef.current.flow === 'paged' && (event.key === 'PageDown' || event.key === ' '))) {
      event.preventDefault()
      turnPage(1)
    }
  }, [onChromeActivity, onHideChrome, turnPage, updateFontSize])

  const handleWheel = useCallback((event: WheelEvent) => {
    if (preferencesRef.current.flow !== 'paged' || event.ctrlKey) return
    event.preventDefault()
    if (Date.now() < wheelLockedUntilRef.current) return

    wheelAccumulatorRef.current += normalizeEPUBWheelDelta(
      event.deltaX,
      event.deltaY,
      event.deltaMode,
      event.view?.innerHeight ?? window.innerHeight,
    )
    if (wheelResetTimerRef.current !== null) window.clearTimeout(wheelResetTimerRef.current)
    wheelResetTimerRef.current = window.setTimeout(() => {
      wheelAccumulatorRef.current = 0
      wheelResetTimerRef.current = null
    }, 180)
    if (Math.abs(wheelAccumulatorRef.current) < 80) return

    const direction = wheelAccumulatorRef.current > 0 ? 1 : -1
    wheelAccumulatorRef.current = 0
    wheelLockedUntilRef.current = Date.now() + 420
    turnPage(direction)
  }, [turnPage])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    host.innerHTML = ''
    setError('')
    setLoading(true)
    setProgress(clampProgress(initialState.overallProgress))
    setAtStart(initialState.overallProgress <= 0)
    setAtEnd(initialState.overallProgress >= 0.999)
    const epub = ePub(api.contentURL(book.id), { requestCredentials: true })
    const initialPreferences = preferencesRef.current
    const rendition = epub.renderTo(host, {
      width: '100%',
      height: '100%',
      manager: 'continuous',
      flow: initialPreferences.flow === 'continuous' ? 'scrolled-continuous' : 'paginated',
      spread: initialPreferences.layout === 'spread' ? 'auto' : 'none',
      minSpreadWidth: 780,
      snap: true,
      allowScriptedContent: false,
    })
    bookRef.current = epub
    renditionRef.current = rendition

    rendition.themes.default({
      'html, body': { 'box-sizing': 'border-box', 'font-family': 'Literata, Georgia, serif', 'line-height': '1.7' },
      body: { padding: '2% 4%' },
      p: { 'max-width': '72ch', 'margin-left': 'auto', 'margin-right': 'auto' },
      img: { 'max-width': '100%', height: 'auto' },
    })
    for (const [name, rules] of Object.entries(EPUB_THEMES)) rendition.themes.register(name, rules)
    rendition.themes.select(initialPreferences.theme)
    rendition.themes.fontSize(`${initialPreferences.fontSize}%`)

    const wheelCleanups: Array<() => void> = []
    const attachContentEvents = (contents: Contents) => {
      contents.document.addEventListener('wheel', handleWheel, { passive: false })
      wheelCleanups.push(() => contents.document.removeEventListener('wheel', handleWheel))
    }
    rendition.hooks.content.register(attachContentEvents)

    const initialCFI = typeof initialState.position.cfi === 'string' ? initialState.position.cfi : undefined
    void epub.ready.then(async () => {
      await epub.locations.generate(1600)
      if (disposed) return
      await rendition.display(initialCFI)
      if (disposed) return
      setLoading(false)
    }).catch((reason: unknown) => {
      if (disposed) return
      console.error('EPUB loading failed', reason)
      setLoading(false)
      setError('EPUB 加载失败。')
    })

    const relocated = (location: RelocatedLocation) => {
      if (disposed) return
      const cfi = location.start.cfi
      let nextProgress = location.start.percentage ?? 0
      try {
        nextProgress = epub.locations.percentageFromCfi(cfi)
      } catch {
        // Some fixed-layout EPUBs do not expose generated locations.
      }
      nextProgress = clampProgress(nextProgress)
      setProgress(nextProgress)
      setAtStart(Boolean(location.atStart) || nextProgress <= 0)
      setAtEnd(Boolean(location.atEnd) || nextProgress >= 0.999)
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = window.setTimeout(() => {
        void onProgress({ cfi, href: location.start.href ?? '', progression: nextProgress }, nextProgress).catch(() => setError('阅读位置保存失败。'))
      }, 500)
    }
    const contentPointerMove = (event: MouseEvent) => {
      if (event.clientY <= 100) onChromeActivity()
    }
    rendition.on('relocated', relocated)
    rendition.on('keydown', handleKeyDown)
    rendition.on('mousemove', contentPointerMove)
    host.addEventListener('wheel', handleWheel, { passive: false })

    return () => {
      disposed = true
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      if (wheelResetTimerRef.current !== null) window.clearTimeout(wheelResetTimerRef.current)
      wheelCleanups.forEach((cleanup) => cleanup())
      host.removeEventListener('wheel', handleWheel)
      rendition.hooks.content.deregister(attachContentEvents)
      rendition.off('relocated', relocated)
      rendition.off('keydown', handleKeyDown)
      rendition.off('mousemove', contentPointerMove)
      rendition.destroy()
      epub.destroy()
      renditionRef.current = null
      bookRef.current = null
      host.innerHTML = ''
    }
  }, [book.id])

  useEffect(() => {
    try {
      window.localStorage.setItem(EPUB_PREFERENCES_KEY, JSON.stringify(preferences))
    } catch {
      // Private browsing or a locked-down browser can reject local storage.
    }
  }, [preferences])

  useEffect(() => {
    const rendition = renditionRef.current
    if (!rendition) return
    rendition.flow(preferences.flow === 'continuous' ? 'scrolled-continuous' : 'paginated')
  }, [preferences.flow])

  useEffect(() => {
    const rendition = renditionRef.current
    if (!rendition) return
    rendition.spread(effectiveLayout === 'spread' ? 'auto' : 'none', 780)
  }, [effectiveLayout])

  useEffect(() => {
    renditionRef.current?.themes.fontSize(`${preferences.fontSize}%`)
  }, [preferences.fontSize])

  useEffect(() => {
    renditionRef.current?.themes.select(preferences.theme)
  }, [preferences.theme])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = () => setIsNarrow((host.clientWidth || window.innerWidth) <= 780)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const progressLabel = useMemo(() => `${Math.round(progress * 100)}%`, [progress])

  function setFlow(flow: EPUBPageFlow) {
    setPreferences((current) => ({ ...current, flow }))
  }

  function setLayout(layout: EPUBPageLayout) {
    setPreferences((current) => ({ ...current, layout }))
  }

  function setTheme(theme: EPUBTheme) {
    setPreferences((current) => ({ ...current, theme }))
  }

  return (
    <div className={`epub-reader theme-${preferences.theme}`}>
      <div
        className={`reader-toolbar epub-toolbar${chromeVisible ? '' : ' is-hidden'}`}
        role="toolbar"
        aria-label="EPUB 阅读工具"
        aria-hidden={!chromeVisible}
        onPointerDown={onChromeActivity}
        onFocusCapture={onChromeActivity}
      >
        <button className="reader-toolbar-collapse" onClick={onHideChrome} title="收起阅读工具" aria-label="收起阅读工具">收起</button>
        <div className="reader-tool-group" aria-label="阅读方式">
          <button className={preferences.flow === 'paged' ? 'active' : ''} aria-pressed={preferences.flow === 'paged'} onClick={() => setFlow('paged')}>分页</button>
          <button className={preferences.flow === 'continuous' ? 'active' : ''} aria-pressed={preferences.flow === 'continuous'} onClick={() => setFlow('continuous')}>连续滚动</button>
        </div>
        <span className="reader-toolbar-divider" />
        <div className="reader-tool-group" aria-label="页面版式">
          <button className={effectiveLayout === 'single' ? 'active' : ''} aria-pressed={effectiveLayout === 'single'} onClick={() => setLayout('single')}>单页</button>
          <button
            className={effectiveLayout === 'spread' ? 'active' : ''}
            aria-pressed={effectiveLayout === 'spread'}
            disabled={preferences.flow === 'continuous' || isNarrow}
            title={preferences.flow === 'continuous' ? '连续滚动模式使用单页版式' : isNarrow ? '窄屏设备使用单页显示' : '双页书籍模式'}
            onClick={() => setLayout('spread')}
          >双页书籍</button>
        </div>
        <span className="reader-toolbar-divider" />
        <div className="reader-tool-group reader-font-tools" aria-label="正文字号">
          <button title="缩小字号（-）" aria-label="缩小字号" onClick={() => updateFontSize(-10)}>A−</button>
          <button className="reader-font-value" title="恢复默认字号" onClick={() => setPreferences((current) => ({ ...current, fontSize: 100 }))}>{preferences.fontSize}%</button>
          <button title="放大字号（+）" aria-label="放大字号" onClick={() => updateFontSize(10)}>A＋</button>
        </div>
        <span className="reader-toolbar-divider" />
        <div className="reader-tool-group" aria-label="阅读主题">
          <button className={preferences.theme === 'paper' ? 'active' : ''} aria-pressed={preferences.theme === 'paper'} onClick={() => setTheme('paper')}>日间</button>
          <button className={preferences.theme === 'sepia' ? 'active' : ''} aria-pressed={preferences.theme === 'sepia'} onClick={() => setTheme('sepia')}>护眼</button>
          <button className={preferences.theme === 'night' ? 'active' : ''} aria-pressed={preferences.theme === 'night'} onClick={() => setTheme('night')}>夜间</button>
        </div>
        <span className="reader-shortcuts">{preferences.flow === 'paged' ? '滚轮 / ← → 翻页 · + − 字号' : '滚轮连续阅读 · + − 字号'}</span>
      </div>

      {error && <div className="notice error epub-error">{error}</div>}
      {loading && !error && <div className="epub-loading">正在加载 EPUB…</div>}
      <div className="epub-host" ref={hostRef} aria-busy={loading} />

      {!loading && !error && (
        <nav className="epub-navigation" aria-label="EPUB 翻页">
          <button disabled={atStart} onClick={() => turnPage(-1)} aria-label="上一页" title={preferences.flow === 'paged' ? '上一页（←）' : '向上翻页'}>←</button>
          <span>{progressLabel}</span>
          <button disabled={atEnd} onClick={() => turnPage(1)} aria-label="下一页" title={preferences.flow === 'paged' ? '下一页（→）' : '向下翻页'}>→</button>
        </nav>
      )}
    </div>
  )
}

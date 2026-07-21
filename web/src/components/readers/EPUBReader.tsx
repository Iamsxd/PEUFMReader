import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ePub, { type Book, type Contents, type Rendition } from 'epubjs'
import { api } from '../../api'
import {
  clampEPUBFontSize,
  EPUB_PREFERENCES_KEY,
  flattenEPUBNavigation,
  getEPUBRestoreTargets,
  normalizeEPUBWheelDelta,
  parseEPUBPreferences,
  resolveEPUBProgress,
} from '../../epub'
import type { EPUBPageFlow, EPUBPageLayout, EPUBReaderPreferences, EPUBTheme, EPUBTOCEntry } from '../../epub'
import type { BookFile, HighlightColor, ReadingMark, ReadingState } from '../../types'
import { clampProgress } from '../../utils'
import { createEPUBReadingMarkLocation, getReadingMarkNavigationTarget, upsertReadingMark, type ReadingMarkLocation } from '../../readingMarks'
import { ReadingMarksPanel } from './ReadingMarksPanel'
import { HighlightComposer, type PendingHighlight } from './HighlightComposer'

interface Props {
  book: BookFile
  initialState: ReadingState
  chromeVisible: boolean
  onChromeActivity: () => void
  onHideChrome: () => void
  onProgress: (position: Record<string, unknown>, progress: number) => Promise<void>
  readingStatus: ReadingState['status']
  onStatusChange: (status: ReadingState['status']) => Promise<void>
}

interface RelocatedLocation {
  start: { cfi: string; href?: string; index?: number; percentage?: number }
  atStart?: boolean
  atEnd?: boolean
}

interface EPUBSearchResult {
  cfi: string
  excerpt: string
  sectionLabel: string
}

type EPUBSidePanel = 'toc' | 'search' | 'marks' | null

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

const EPUB_DISPLAY_TIMEOUT_MS = 15_000

const EPUB_HIGHLIGHT_COLORS: Record<HighlightColor, string> = {
  yellow: '#f4d35e', green: '#76c893', blue: '#6ea8fe', pink: '#f49ac2', purple: '#b197fc',
}

function readPreferences(): EPUBReaderPreferences {
  try {
    return parseEPUBPreferences(window.localStorage.getItem(EPUB_PREFERENCES_KEY))
  } catch {
    return parseEPUBPreferences(null)
  }
}

export function EPUBReader({ book, initialState, chromeVisible, onChromeActivity, onHideChrome, onProgress, readingStatus, onStatusChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const bookRef = useRef<Book | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const wheelResetTimerRef = useRef<number | null>(null)
  const wheelAccumulatorRef = useRef(0)
  const wheelLockedUntilRef = useRef(0)
  const locationsReadyRef = useRef(false)
  const searchRunRef = useRef(0)
  const renderedHighlightCFIsRef = useRef<string[]>([])
  const highlightsRef = useRef<ReadingMark[]>([])
  const lastProgressRef = useRef(clampProgress(initialState.overallProgress))
  const [preferences, setPreferences] = useState(readPreferences)
  const preferencesRef = useRef(preferences)
  const [isNarrow, setIsNarrow] = useState(window.innerWidth <= 780)
  const [progress, setProgress] = useState(clampProgress(initialState.overallProgress))
  const [markLocation, setMarkLocation] = useState<ReadingMarkLocation>({
    position: initialState.position,
    overallProgress: clampProgress(initialState.overallProgress),
    label: `阅读进度 ${Math.round(clampProgress(initialState.overallProgress) * 100)}%`,
  })
  const [atStart, setAtStart] = useState(initialState.overallProgress <= 0)
  const [atEnd, setAtEnd] = useState(initialState.overallProgress >= 0.999)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sidePanel, setSidePanel] = useState<EPUBSidePanel>(null)
  const [toc, setTOC] = useState<EPUBTOCEntry[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<EPUBSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchProgress, setSearchProgress] = useState('')
  const [searchError, setSearchError] = useState('')
  const [highlights, setHighlights] = useState<ReadingMark[]>([])
  const [pendingHighlight, setPendingHighlight] = useState<PendingHighlight | null>(null)
  const [savingHighlight, setSavingHighlight] = useState(false)
  preferencesRef.current = preferences
  highlightsRef.current = highlights

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

  const renderHighlights = useCallback((rendition: Rendition, marks: ReadingMark[]) => {
    for (const cfi of renderedHighlightCFIsRef.current) rendition.annotations.remove(cfi, 'highlight')
    const rendered: string[] = []
    for (const mark of marks) {
      const cfi = typeof mark.position.cfi === 'string' ? mark.position.cfi : ''
      if (!cfi || !mark.color) continue
      rendition.annotations.highlight(cfi, { id: mark.id }, () => setSidePanel('marks'), 'peufm-highlight', {
        fill: EPUB_HIGHLIGHT_COLORS[mark.color],
        'fill-opacity': '0.42',
        'mix-blend-mode': 'multiply',
      })
      rendered.push(cfi)
    }
    renderedHighlightCFIsRef.current = rendered
  }, [])

  useEffect(() => {
    let disposed = false
    void api.listReadingMarks(book.id).then((marks) => {
      if (!disposed) setHighlights(marks.filter((mark) => mark.kind === 'highlight'))
    }).catch(() => {
      if (!disposed) setError('文本高亮加载失败。')
    })
    return () => { disposed = true }
  }, [book.id])

  useEffect(() => {
    const rendition = renditionRef.current
    if (rendition) renderHighlights(rendition, highlights)
  }, [highlights, renderHighlights])

  const syncHighlights = useCallback((marks: ReadingMark[]) => {
    setHighlights(marks.filter((mark) => mark.kind === 'highlight'))
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    host.innerHTML = ''
    setError('')
    setLoading(true)
    setProgress(clampProgress(initialState.overallProgress))
    setMarkLocation({
      position: initialState.position,
      overallProgress: clampProgress(initialState.overallProgress),
      label: `阅读进度 ${Math.round(clampProgress(initialState.overallProgress) * 100)}%`,
    })
    lastProgressRef.current = clampProgress(initialState.overallProgress)
    locationsReadyRef.current = false
    searchRunRef.current += 1
    setTOC([])
    setSearchResults([])
    setSearching(false)
    setSearchProgress('')
    setSearchError('')
    setAtStart(initialState.overallProgress <= 0)
    setAtEnd(initialState.overallProgress >= 0.999)
    const epub = ePub(api.contentURL(book.id), { requestCredentials: true, openAs: 'epub' })
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

    const displayTimeout = window.setTimeout(() => {
      if (disposed) return
      setLoading(false)
      setError('EPUB 加载时间过长，请返回后重试。')
    }, EPUB_DISPLAY_TIMEOUT_MS)
    void epub.ready.then(async () => {
      if (disposed) return
      let restored = false
      for (const target of getEPUBRestoreTargets(initialState.position)) {
        try {
          await rendition.display(target)
          restored = true
          break
        } catch (reason) {
          console.warn('Saved EPUB restore target is no longer valid.', target, reason)
        }
      }
      if (!restored && initialState.overallProgress > 0) {
        try {
          await epub.locations.generate(1600)
          locationsReadyRef.current = true
          await rendition.display(epub.locations.cfiFromPercentage(clampProgress(initialState.overallProgress)))
          restored = true
        } catch (reason) {
          console.warn('EPUB percentage restore failed; opening the first section.', reason)
        }
      }
      if (!restored) await rendition.display()
      if (disposed) return
      window.clearTimeout(displayTimeout)
      setError('')
      setLoading(false)
      renderHighlights(rendition, highlightsRef.current)

      if (!locationsReadyRef.current) {
        void epub.locations.generate(1600).then(() => {
          if (!disposed) locationsReadyRef.current = true
        }).catch((reason: unknown) => {
          if (!disposed) console.warn('EPUB location generation failed; using rendition progress.', reason)
        })
      }
    }).catch((reason: unknown) => {
      if (disposed) return
      window.clearTimeout(displayTimeout)
      console.error('EPUB loading failed', reason)
      setLoading(false)
      setError('EPUB 加载失败。')
    })

    const relocated = (location: RelocatedLocation) => {
      if (disposed) return
      const cfi = location.start.cfi
      let generatedProgress: number | undefined
      if (locationsReadyRef.current) {
        try {
          generatedProgress = epub.locations.percentageFromCfi(cfi)
        } catch {
          // Some fixed-layout EPUBs do not expose generated locations.
        }
      }
      const nextProgress = clampProgress(resolveEPUBProgress(generatedProgress, location.start.percentage, lastProgressRef.current))
      lastProgressRef.current = nextProgress
      setProgress(nextProgress)
      setMarkLocation(createEPUBReadingMarkLocation({
        cfi,
        href: location.start.href,
        chapterIndex: location.start.index,
        progression: nextProgress,
      }))
      setAtStart(Boolean(location.atStart) || nextProgress <= 0)
      setAtEnd(Boolean(location.atEnd) || nextProgress >= 0.999)
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = window.setTimeout(() => {
        void onProgress({
          cfi,
          href: location.start.href ?? '',
          chapterIndex: location.start.index,
          progression: nextProgress,
        }, nextProgress).catch(() => setError('阅读位置保存失败。'))
      }, 500)
    }
    const contentPointerMove = (event: MouseEvent) => {
      if (event.clientY <= 100) onChromeActivity()
    }
    const selected = (cfiRange: string, contents: Contents) => {
      const quote = contents.document.getSelection()?.toString().replace(/\s+/g, ' ').trim() ?? ''
      if (!quote) return
      const currentProgress = clampProgress(lastProgressRef.current)
      setPendingHighlight({
        position: { cfi: cfiRange, progression: currentProgress },
        overallProgress: currentProgress,
        label: `阅读进度 ${Math.round(currentProgress * 100)}%高亮`,
        quote: quote.slice(0, 4000),
      })
      onChromeActivity()
    }
    rendition.on('relocated', relocated)
    rendition.on('selected', selected)
    rendition.on('keydown', handleKeyDown)
    rendition.on('mousemove', contentPointerMove)
    host.addEventListener('wheel', handleWheel, { passive: false })
    void epub.loaded.navigation.then((navigation) => {
      if (!disposed) setTOC(flattenEPUBNavigation(navigation.toc))
    }).catch((reason: unknown) => {
      if (!disposed) console.warn('EPUB navigation loading failed.', reason)
    })

    return () => {
      disposed = true
      searchRunRef.current += 1
      window.clearTimeout(displayTimeout)
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      if (wheelResetTimerRef.current !== null) window.clearTimeout(wheelResetTimerRef.current)
      wheelCleanups.forEach((cleanup) => cleanup())
      host.removeEventListener('wheel', handleWheel)
      rendition.hooks.content.deregister(attachContentEvents)
      rendition.off('relocated', relocated)
      rendition.off('selected', selected)
      rendition.off('keydown', handleKeyDown)
      rendition.off('mousemove', contentPointerMove)
      rendition.destroy()
      epub.destroy()
      renditionRef.current = null
      bookRef.current = null
      renderedHighlightCFIsRef.current = []
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

  function toggleSidePanel(panel: Exclude<EPUBSidePanel, null>) {
    setSidePanel((current) => current === panel ? null : panel)
    onChromeActivity()
  }

  function displayLocation(target: string | number) {
    void renditionRef.current?.display(target).then(() => setSidePanel(null)).catch(() => setSearchError('无法定位到该内容。'))
  }

  async function saveHighlight(color: HighlightColor, body: string) {
    if (!pendingHighlight) return
    setSavingHighlight(true)
    try {
      const mark = await api.createReadingMark(book.id, {
        kind: 'highlight', ...pendingHighlight, body, quote: pendingHighlight.quote, color,
      })
      setHighlights((items) => upsertReadingMark(items, mark))
      setPendingHighlight(null)
      hostRef.current?.querySelectorAll('iframe').forEach((frame) => frame.contentDocument?.getSelection()?.removeAllRanges())
    } catch {
      setError('文本高亮保存失败。')
    } finally {
      setSavingHighlight(false)
    }
  }

  async function searchEPUB(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const query = searchQuery.trim()
    const epub = bookRef.current
    if (!epub || !query) return

    const run = ++searchRunRef.current
    setSearching(true)
    setSearchError('')
    setSearchResults([])
    const results: EPUBSearchResult[] = []
    const sections = epub.spine.spineItems.filter((section) => section.linear !== false)
    const tocLabels = new Map(toc.map((entry) => [entry.href.split('#')[0], entry.label]))
    try {
      for (const [index, section] of sections.entries()) {
        if (run !== searchRunRef.current) return
        setSearchProgress(`正在搜索 ${index + 1} / ${sections.length}`)
        await section.load(epub.load.bind(epub))
        try {
          for (const match of section.find(query)) {
            results.push({
              cfi: match.cfi,
              excerpt: match.excerpt,
              sectionLabel: tocLabels.get(section.href.split('#')[0]) ?? `第 ${section.index + 1} 章`,
            })
            if (results.length >= 100) break
          }
        } finally {
          section.unload()
        }
        if (results.length >= 100) break
      }
      if (run !== searchRunRef.current) return
      setSearchResults(results)
      setSearchProgress(results.length >= 100 ? '已显示前 100 条结果' : `找到 ${results.length} 条结果`)
    } catch (reason) {
      console.error('EPUB search failed', reason)
      if (run === searchRunRef.current) setSearchError('书内搜索失败，请稍后重试。')
    } finally {
      if (run === searchRunRef.current) setSearching(false)
    }
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
        <div className="reader-tool-group" aria-label="书籍导航">
          <button className={sidePanel === 'toc' ? 'active' : ''} aria-pressed={sidePanel === 'toc'} onClick={() => toggleSidePanel('toc')}>目录</button>
          <button className={sidePanel === 'search' ? 'active' : ''} aria-pressed={sidePanel === 'search'} onClick={() => toggleSidePanel('search')}>书内搜索</button>
          <button className={sidePanel === 'marks' ? 'active' : ''} aria-pressed={sidePanel === 'marks'} onClick={() => toggleSidePanel('marks')}>书签/高亮</button>
        </div>
        <span className="reader-toolbar-divider" />
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
        <label className="reader-status-control">
          <span>状态</span>
          <select value={readingStatus} onChange={(event) => void onStatusChange(event.target.value as ReadingState['status'])}>
            <option value="unread">未读</option><option value="reading">在读</option><option value="paused">暂停</option><option value="finished">读完</option><option value="abandoned">放弃</option>
          </select>
        </label>
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

      {sidePanel === 'marks' ? (
        <ReadingMarksPanel
          bookFileID={book.id}
          current={markLocation}
          onNavigate={(position) => {
            const target = getReadingMarkNavigationTarget(book.format, position)
            if (target !== null) displayLocation(target)
          }}
          onClose={() => setSidePanel(null)}
          onChromeActivity={onChromeActivity}
          onMarksChange={syncHighlights}
        />
      ) : sidePanel && (
        <aside className="reader-side-panel" aria-label={sidePanel === 'toc' ? 'EPUB 目录' : 'EPUB 书内搜索'} onPointerDown={onChromeActivity}>
          <header>
            <strong>{sidePanel === 'toc' ? '目录' : '书内搜索'}</strong>
            <button onClick={() => setSidePanel(null)} aria-label="关闭侧栏">×</button>
          </header>
          {sidePanel === 'toc' ? (
            <div className="reader-toc-list">
              {toc.length === 0 && <p className="reader-panel-empty">这本书没有可用目录。</p>}
              {toc.map((entry) => (
                <button key={entry.id} style={{ paddingLeft: `${14 + entry.depth * 16}px` }} onClick={() => displayLocation(entry.href)}>{entry.label}</button>
              ))}
            </div>
          ) : (
            <div className="reader-search-panel">
              <form onSubmit={(event) => void searchEPUB(event)}>
                <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索正文" aria-label="搜索 EPUB 正文" />
                <button type="submit" disabled={searching || !searchQuery.trim()}>{searching ? '搜索中' : '搜索'}</button>
              </form>
              {(searchProgress || searchError) && <p className={searchError ? 'reader-panel-error' : 'reader-search-progress'}>{searchError || searchProgress}</p>}
              <div className="reader-search-results">
                {searchResults.map((result, index) => (
                  <button key={`${result.cfi}-${index}`} onClick={() => displayLocation(result.cfi)}>
                    <strong>{result.sectionLabel}</strong>
                    <span>{result.excerpt}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>
      )}

      {pendingHighlight && (
        <HighlightComposer selection={pendingHighlight} busy={savingHighlight} onSave={(color, body) => void saveHighlight(color, body)} onCancel={() => setPendingHighlight(null)} />
      )}

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

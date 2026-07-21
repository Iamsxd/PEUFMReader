import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerURL from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { api } from '../../api'
import {
  calculatePDFScale,
  clampPDFPage,
  clampPDFZoom,
  createPDFSearchSnippet,
  describePDFError,
  fetchPDFBytes,
  getPDFJSAssetOptions,
  getPDFViewPages,
  movePDFPage,
  normalizePDFWheelDelta,
  parsePDFPreferences,
  PDF_PREFERENCES_KEY,
} from '../../pdf'
import type { PDFPageFlow, PDFPageLayout, PDFReaderPreferences } from '../../pdf'
import type { BookFile, ReadingState } from '../../types'
import { clampProgress } from '../../utils'
import { createPDFReadingMarkLocation, getReadingMarkNavigationTarget } from '../../readingMarks'
import { PDFPageCanvas } from './PDFPageCanvas'
import { ReadingMarksPanel } from './ReadingMarksPanel'

pdfjs.GlobalWorkerOptions.workerSrc = workerURL

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

type PDFOutlineNode = Awaited<ReturnType<pdfjs.PDFDocumentProxy['getOutline']>>[number]

interface PDFOutlineEntry {
  id: string
  title: string
  page: number | null
  depth: number
}

interface PDFSearchResult {
  page: number
  excerpt: string
}

type PDFSidePanel = 'toc' | 'search' | 'marks' | null

async function resolvePDFOutline(document: pdfjs.PDFDocumentProxy, nodes: PDFOutlineNode[], depth = 0): Promise<PDFOutlineEntry[]> {
  const entries: PDFOutlineEntry[] = []
  for (const [index, node] of nodes.entries()) {
    let destination = node.dest
    if (typeof destination === 'string') destination = await document.getDestination(destination)
    let page: number | null = null
    if (Array.isArray(destination) && destination[0]) {
      try {
        page = await document.getPageIndex(destination[0]) + 1
      } catch {
        // Some documents contain stale or external outline destinations.
      }
    }
    entries.push({ id: `${depth}-${index}-${node.title}`, title: node.title || `第 ${page ?? '?'} 页`, page, depth })
    if (node.items?.length) entries.push(...await resolvePDFOutline(document, node.items, depth + 1))
  }
  return entries
}

function readPreferences(): PDFReaderPreferences {
  try {
    return parsePDFPreferences(window.localStorage.getItem(PDF_PREFERENCES_KEY))
  } catch {
    return parsePDFPreferences(null)
  }
}

export function PDFReader({ book, initialState, chromeVisible, onChromeActivity, onHideChrome, onProgress, readingStatus, onStatusChange }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const loadingTaskRef = useRef<pdfjs.PDFDocumentLoadingTask | null>(null)
  const visiblePagesRef = useRef(new Map<number, number>())
  const searchRunRef = useRef(0)
  const wheelZoomAccumulatorRef = useRef(0)
  const wheelZoomResetTimerRef = useRef<number | null>(null)
  const initialPage = typeof initialState.position.pageIndex === 'number' ? Number(initialState.position.pageIndex) + 1 : 1
  const [pdfDocument, setPDFDocument] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [pageNumber, setPageNumber] = useState(Math.max(1, initialPage))
  const [basePageSize, setBasePageSize] = useState({ width: 612, height: 792 })
  const [containerWidth, setContainerWidth] = useState(window.innerWidth)
  const [availableHeight, setAvailableHeight] = useState(Math.max(320, window.innerHeight - 96))
  const [isNarrow, setIsNarrow] = useState(window.innerWidth <= 720)
  const [preferences, setPreferences] = useState(readPreferences)
  const [error, setError] = useState('')
  const [sidePanel, setSidePanel] = useState<PDFSidePanel>(null)
  const [outline, setOutline] = useState<PDFOutlineEntry[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<PDFSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchProgress, setSearchProgress] = useState('')
  const [searchError, setSearchError] = useState('')

  const pageCount = pdfDocument?.numPages ?? 0
  const effectiveLayout: PDFPageLayout = isNarrow ? 'single' : preferences.layout
  const scale = useMemo(() => calculatePDFScale({
    zoomMode: preferences.zoomMode,
    zoomPercent: preferences.zoomPercent,
    pageWidth: basePageSize.width,
    pageHeight: basePageSize.height,
    containerWidth,
    availableHeight,
    layout: effectiveLayout,
  }), [availableHeight, basePageSize, containerWidth, effectiveLayout, preferences.zoomMode, preferences.zoomPercent])
  const displayedZoom = preferences.zoomMode === 'custom' ? preferences.zoomPercent : Math.round(scale * 100)
  const pages = useMemo(() => {
    if (!pageCount) return []
    if (preferences.flow === 'continuous') return Array.from({ length: pageCount }, (_, index) => index + 1)
    return getPDFViewPages(pageNumber, pageCount, effectiveLayout)
  }, [effectiveLayout, pageCount, pageNumber, preferences.flow])

  useEffect(() => {
    let disposed = false
    const controller = new AbortController()
    visiblePagesRef.current.clear()
    searchRunRef.current += 1
    setError('')
    setPDFDocument(null)
    setOutline([])
    setSearchResults([])
    setSearching(false)
    setSearchProgress('')
    setSearchError('')

    void fetchPDFBytes(api.contentURL(book.id), controller.signal).then((bytes) => {
      if (disposed) return null
      const task = pdfjs.getDocument({
        data: bytes,
        ...getPDFJSAssetOptions(import.meta.env.BASE_URL),
      })
      loadingTaskRef.current = task
      return task.promise
    }).then(async (document) => {
      if (!document || disposed) return
      const firstPage = await document.getPage(1)
      if (disposed) return
      const viewport = firstPage.getViewport({ scale: 1 })
      setBasePageSize({ width: viewport.width, height: viewport.height })
      setPageNumber(clampPDFPage(initialPage, document.numPages))
      setPDFDocument(document)
      void document.getOutline().then((nodes) => resolvePDFOutline(document, nodes)).then((entries) => {
        if (!disposed) setOutline(entries)
      }).catch((reason: unknown) => {
        if (!disposed) console.warn('PDF outline loading failed.', reason)
      })
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      console.error('PDF loading failed', reason)
      setError(describePDFError(reason))
    })

    return () => {
      disposed = true
      searchRunRef.current += 1
      controller.abort()
      const document = loadingTaskRef.current
      loadingTaskRef.current = null
      void document?.destroy()
    }
  }, [book.id])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const measure = () => {
      setContainerWidth(viewport.clientWidth || window.innerWidth)
      setAvailableHeight(Math.max(320, window.innerHeight - 96))
      setIsNarrow(window.innerWidth <= 720)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(PDF_PREFERENCES_KEY, JSON.stringify(preferences))
    } catch {
      // Private browsing or a locked-down browser can reject local storage.
    }
  }, [preferences])

  const goToPage = useCallback((requestedPage: number) => {
    const requestedTarget = clampPDFPage(requestedPage, pageCount)
    const target = preferences.flow === 'paged' && effectiveLayout === 'spread'
      ? getPDFViewPages(requestedTarget, pageCount, effectiveLayout)[0]
      : requestedTarget
    setPageNumber(target)
    if (preferences.flow === 'continuous') {
      window.requestAnimationFrame(() => {
        globalThis.document.querySelector<HTMLElement>(`[data-pdf-page="${target}"]`)?.scrollIntoView({ block: 'start' })
      })
    }
  }, [effectiveLayout, pageCount, preferences.flow])

  const movePage = useCallback((direction: -1 | 1) => {
    goToPage(movePDFPage(pageNumber, pageCount, effectiveLayout, direction))
  }, [effectiveLayout, goToPage, pageCount, pageNumber])

  useEffect(() => {
    if (!pdfDocument || preferences.flow !== 'continuous') return
    const timer = window.setTimeout(() => goToPage(pageNumber), 0)
    return () => window.clearTimeout(timer)
  }, [effectiveLayout, pdfDocument, preferences.flow])

  useEffect(() => {
    if (pageCount === 0) return
    const timer = window.setTimeout(() => {
      void onProgress(
        { pageIndex: pageNumber - 1, yRatio: 0 },
        clampProgress(pageNumber / pageCount),
      ).catch(() => setError('阅读位置保存失败。'))
    }, 600)
    return () => window.clearTimeout(timer)
  }, [pageCount, pageNumber])

  const updateZoom = useCallback((delta: number) => {
    setPreferences((current) => ({
      ...current,
      zoomMode: 'custom',
      zoomPercent: clampPDFZoom((current.zoomMode === 'custom' ? current.zoomPercent : Math.round(scale * 100)) + delta),
    }))
  }, [scale])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const handleWheelZoom = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      onChromeActivity()
      wheelZoomAccumulatorRef.current += normalizePDFWheelDelta(
        event.deltaY,
        event.deltaMode,
        viewport.clientHeight || window.innerHeight,
      )
      if (wheelZoomResetTimerRef.current !== null) window.clearTimeout(wheelZoomResetTimerRef.current)
      wheelZoomResetTimerRef.current = window.setTimeout(() => {
        wheelZoomAccumulatorRef.current = 0
        wheelZoomResetTimerRef.current = null
      }, 180)
      if (Math.abs(wheelZoomAccumulatorRef.current) < 60) return

      const zoomDelta = wheelZoomAccumulatorRef.current < 0 ? 10 : -10
      wheelZoomAccumulatorRef.current = 0
      updateZoom(zoomDelta)
    }
    viewport.addEventListener('wheel', handleWheelZoom, { passive: false })
    return () => {
      if (wheelZoomResetTimerRef.current !== null) window.clearTimeout(wheelZoomResetTimerRef.current)
      wheelZoomAccumulatorRef.current = 0
      wheelZoomResetTimerRef.current = null
      viewport.removeEventListener('wheel', handleWheelZoom)
    }
  }, [onChromeActivity, updateZoom])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, select, textarea, button')) return
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        updateZoom(10)
      } else if (event.key === '-') {
        event.preventDefault()
        updateZoom(-10)
      } else if (event.key === 'ArrowLeft' || (preferences.flow === 'paged' && event.key === 'PageUp')) {
        event.preventDefault()
        movePage(-1)
      } else if (event.key === 'ArrowRight' || (preferences.flow === 'paged' && (event.key === 'PageDown' || event.key === ' '))) {
        event.preventDefault()
        movePage(1)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [movePage, preferences.flow, updateZoom])

  const handleVisibilityChange = useCallback((visiblePage: number, ratio: number) => {
    if (ratio > 0) visiblePagesRef.current.set(visiblePage, ratio)
    else visiblePagesRef.current.delete(visiblePage)
    if (preferences.flow !== 'continuous' || visiblePagesRef.current.size === 0) return
    const [bestPage] = [...visiblePagesRef.current.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]
    setPageNumber((current) => current === bestPage ? current : bestPage)
  }, [preferences.flow])

  const handleRenderError = useCallback((message: string) => {
    setError(`PDF 页面渲染失败（${message}）。`)
  }, [])

  function setFlow(flow: PDFPageFlow) {
    setPreferences((current) => ({ ...current, flow }))
  }

  function setLayout(layout: PDFPageLayout) {
    setPreferences((current) => ({ ...current, layout }))
    if (layout === 'spread' && pageCount > 0) {
      setPageNumber(getPDFViewPages(pageNumber, pageCount, 'spread')[0])
    }
  }

  function toggleSidePanel(panel: Exclude<PDFSidePanel, null>) {
    setSidePanel((current) => current === panel ? null : panel)
    onChromeActivity()
  }

  function selectPage(page: number) {
    goToPage(page)
    setSidePanel(null)
  }

  async function searchPDF(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const query = searchQuery.trim()
    if (!pdfDocument || !query) return

    const run = ++searchRunRef.current
    const results: PDFSearchResult[] = []
    setSearching(true)
    setSearchResults([])
    setSearchError('')
    try {
      for (let page = 1; page <= pdfDocument.numPages; page += 1) {
        if (run !== searchRunRef.current) return
        setSearchProgress(`正在搜索 ${page} / ${pdfDocument.numPages}`)
        const pageProxy = await pdfDocument.getPage(page)
        const content = await pageProxy.getTextContent()
        const text = content.items.map((item) => 'str' in item ? item.str : '').join(' ')
        pageProxy.cleanup()
        const excerpt = createPDFSearchSnippet(text, query)
        if (excerpt) results.push({ page, excerpt })
        if (results.length >= 100) break
      }
      if (run !== searchRunRef.current) return
      setSearchResults(results)
      setSearchProgress(results.length >= 100 ? '已显示前 100 条结果' : `找到 ${results.length} 页匹配内容`)
    } catch (reason) {
      console.error('PDF search failed', reason)
      if (run === searchRunRef.current) setSearchError('书内搜索失败，请稍后重试。')
    } finally {
      if (run === searchRunRef.current) setSearching(false)
    }
  }

  return (
    <div className="pdf-reader">
      <div
        className={`reader-toolbar pdf-toolbar${chromeVisible ? '' : ' is-hidden'}`}
        role="toolbar"
        aria-label="PDF 阅读工具"
        aria-hidden={!chromeVisible}
        onPointerDown={onChromeActivity}
        onFocusCapture={onChromeActivity}
      >
        <button className="reader-toolbar-collapse" onClick={onHideChrome} title="收起阅读工具" aria-label="收起阅读工具">收起</button>
        <div className="reader-tool-group" aria-label="书籍导航">
          <button className={sidePanel === 'toc' ? 'active' : ''} aria-pressed={sidePanel === 'toc'} onClick={() => toggleSidePanel('toc')}>目录</button>
          <button className={sidePanel === 'search' ? 'active' : ''} aria-pressed={sidePanel === 'search'} onClick={() => toggleSidePanel('search')}>书内搜索</button>
          <button className={sidePanel === 'marks' ? 'active' : ''} aria-pressed={sidePanel === 'marks'} onClick={() => toggleSidePanel('marks')}>书签/笔记</button>
        </div>
        <span className="reader-toolbar-divider" />
        <div className="reader-tool-group" aria-label="阅读方式">
          <button className={preferences.flow === 'paged' ? 'active' : ''} aria-pressed={preferences.flow === 'paged'} onClick={() => setFlow('paged')}>分页</button>
          <button className={preferences.flow === 'continuous' ? 'active' : ''} aria-pressed={preferences.flow === 'continuous'} onClick={() => setFlow('continuous')}>连续滚动</button>
        </div>
        <span className="reader-toolbar-divider" />
        <div className="reader-tool-group" aria-label="页面版式">
          <button className={preferences.layout === 'single' ? 'active' : ''} aria-pressed={preferences.layout === 'single'} onClick={() => setLayout('single')}>单页</button>
          <button className={preferences.layout === 'spread' ? 'active' : ''} aria-pressed={preferences.layout === 'spread'} disabled={isNarrow} title={isNarrow ? '窄屏设备使用单页显示' : '双页书籍模式'} onClick={() => setLayout('spread')}>双页书籍</button>
        </div>
        <span className="reader-toolbar-divider" />
        <label className="reader-status-control">
          <span>状态</span>
          <select value={readingStatus} onChange={(event) => void onStatusChange(event.target.value as ReadingState['status'])}>
            <option value="unread">未读</option><option value="reading">在读</option><option value="paused">暂停</option><option value="finished">读完</option><option value="abandoned">放弃</option>
          </select>
        </label>
        <span className="reader-toolbar-divider" />
        <div className="reader-tool-group reader-zoom-tools" aria-label="页面缩放">
          <button title="缩小（-）" aria-label="缩小" onClick={() => updateZoom(-10)}>−</button>
          <button className="reader-zoom-value" title="恢复 100%" onClick={() => setPreferences((current) => ({ ...current, zoomMode: 'custom', zoomPercent: 100 }))}>{displayedZoom}%</button>
          <button title="放大（+）" aria-label="放大" onClick={() => updateZoom(10)}>＋</button>
          <button className={preferences.zoomMode === 'fit-width' ? 'active' : ''} aria-pressed={preferences.zoomMode === 'fit-width'} onClick={() => setPreferences((current) => ({ ...current, zoomMode: 'fit-width' }))}>适宽</button>
          <button className={preferences.zoomMode === 'fit-page' ? 'active' : ''} aria-pressed={preferences.zoomMode === 'fit-page'} onClick={() => setPreferences((current) => ({ ...current, zoomMode: 'fit-page' }))}>适页</button>
        </div>
        <span className="reader-shortcuts">← → 翻页 · + − / Ctrl+滚轮缩放</span>
      </div>

      {sidePanel === 'marks' ? (
        <ReadingMarksPanel
          bookFileID={book.id}
          current={createPDFReadingMarkLocation(pageNumber, pageCount)}
          onNavigate={(position) => {
            const target = getReadingMarkNavigationTarget(book.format, position)
            if (typeof target === 'number') {
              goToPage(target)
              setSidePanel(null)
            }
          }}
          onClose={() => setSidePanel(null)}
          onChromeActivity={onChromeActivity}
        />
      ) : sidePanel && (
        <aside className="reader-side-panel" aria-label={sidePanel === 'toc' ? 'PDF 目录' : 'PDF 书内搜索'} onPointerDown={onChromeActivity}>
          <header>
            <strong>{sidePanel === 'toc' ? '目录' : '书内搜索'}</strong>
            <button onClick={() => setSidePanel(null)} aria-label="关闭侧栏">×</button>
          </header>
          {sidePanel === 'toc' ? (
            <div className="reader-toc-list">
              {outline.length === 0 && <p className="reader-panel-empty">这份 PDF 没有可用目录。</p>}
              {outline.map((entry) => (
                <button key={entry.id} disabled={entry.page === null} style={{ paddingLeft: `${14 + entry.depth * 16}px` }} onClick={() => entry.page && selectPage(entry.page)}>
                  <span>{entry.title}</span>{entry.page && <small>{entry.page}</small>}
                </button>
              ))}
            </div>
          ) : (
            <div className="reader-search-panel">
              <form onSubmit={(event) => void searchPDF(event)}>
                <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索正文" aria-label="搜索 PDF 正文" />
                <button type="submit" disabled={searching || !searchQuery.trim()}>{searching ? '搜索中' : '搜索'}</button>
              </form>
              {(searchProgress || searchError) && <p className={searchError ? 'reader-panel-error' : 'reader-search-progress'}>{searchError || searchProgress}</p>}
              <div className="reader-search-results">
                {searchResults.map((result) => (
                  <button key={result.page} onClick={() => selectPage(result.page)}>
                    <strong>第 {result.page} 页</strong>
                    <span>{result.excerpt}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>
      )}

      {error && <div className="notice error pdf-error">{error}</div>}
      {!pdfDocument && !error && <div className="pdf-loading">正在加载 PDF…</div>}

      <div ref={viewportRef} className="pdf-reader-viewport">
        {pdfDocument && (
          <div className={`pdf-pages ${preferences.flow} ${effectiveLayout}`}>
            {pages.map((number) => (
              <PDFPageCanvas
                key={number}
                document={pdfDocument}
                pageNumber={number}
                scale={scale}
                lazy={preferences.flow === 'continuous'}
                observerRoot={viewportRef.current}
                fallbackSize={basePageSize}
                onVisibilityChange={handleVisibilityChange}
                onRenderError={handleRenderError}
              />
            ))}
          </div>
        )}
      </div>

      {pageCount > 0 && (
        <nav className="pdf-navigation" aria-label="PDF 翻页">
          <button disabled={pageNumber <= 1} onClick={() => movePage(-1)} aria-label="上一页" title="上一页（←）">←</button>
          <label>
            <span className="visually-hidden">页码</span>
            <input
              type="number"
              min={1}
              max={pageCount}
              value={pageNumber}
              onChange={(event) => goToPage(Number(event.target.value))}
              aria-label="当前页码"
            />
            <span>/ {pageCount}</span>
          </label>
          <button disabled={(preferences.flow === 'paged' ? pages.at(-1) ?? pageNumber : pageNumber) >= pageCount} onClick={() => movePage(1)} aria-label="下一页" title="下一页（→）">→</button>
        </nav>
      )}
    </div>
  )
}

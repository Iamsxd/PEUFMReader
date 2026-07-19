import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerURL from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { api } from '../../api'
import {
  calculatePDFScale,
  clampPDFPage,
  clampPDFZoom,
  describePDFError,
  fetchPDFBytes,
  getPDFViewPages,
  movePDFPage,
  parsePDFPreferences,
  PDF_PREFERENCES_KEY,
} from '../../pdf'
import type { PDFPageFlow, PDFPageLayout, PDFReaderPreferences } from '../../pdf'
import type { BookFile, ReadingState } from '../../types'
import { clampProgress } from '../../utils'
import { PDFPageCanvas } from './PDFPageCanvas'

pdfjs.GlobalWorkerOptions.workerSrc = workerURL

interface Props {
  book: BookFile
  initialState: ReadingState
  chromeVisible: boolean
  onChromeActivity: () => void
  onHideChrome: () => void
  onProgress: (position: Record<string, unknown>, progress: number) => Promise<void>
}

function readPreferences(): PDFReaderPreferences {
  try {
    return parsePDFPreferences(window.localStorage.getItem(PDF_PREFERENCES_KEY))
  } catch {
    return parsePDFPreferences(null)
  }
}

export function PDFReader({ book, initialState, chromeVisible, onChromeActivity, onHideChrome, onProgress }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const loadingTaskRef = useRef<pdfjs.PDFDocumentLoadingTask | null>(null)
  const visiblePagesRef = useRef(new Map<number, number>())
  const initialPage = typeof initialState.position.pageIndex === 'number' ? Number(initialState.position.pageIndex) + 1 : 1
  const [pdfDocument, setPDFDocument] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [pageNumber, setPageNumber] = useState(Math.max(1, initialPage))
  const [basePageSize, setBasePageSize] = useState({ width: 612, height: 792 })
  const [containerWidth, setContainerWidth] = useState(window.innerWidth)
  const [availableHeight, setAvailableHeight] = useState(Math.max(320, window.innerHeight - 96))
  const [isNarrow, setIsNarrow] = useState(window.innerWidth <= 720)
  const [preferences, setPreferences] = useState(readPreferences)
  const [error, setError] = useState('')

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
    setError('')
    setPDFDocument(null)

    void fetchPDFBytes(api.contentURL(book.id), controller.signal).then((bytes) => {
      if (disposed) return null
      const task = pdfjs.getDocument({ data: bytes })
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
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      console.error('PDF loading failed', reason)
      setError(describePDFError(reason))
    })

    return () => {
      disposed = true
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
        <div className="reader-tool-group reader-zoom-tools" aria-label="页面缩放">
          <button title="缩小（-）" aria-label="缩小" onClick={() => updateZoom(-10)}>−</button>
          <button className="reader-zoom-value" title="恢复 100%" onClick={() => setPreferences((current) => ({ ...current, zoomMode: 'custom', zoomPercent: 100 }))}>{displayedZoom}%</button>
          <button title="放大（+）" aria-label="放大" onClick={() => updateZoom(10)}>＋</button>
          <button className={preferences.zoomMode === 'fit-width' ? 'active' : ''} aria-pressed={preferences.zoomMode === 'fit-width'} onClick={() => setPreferences((current) => ({ ...current, zoomMode: 'fit-width' }))}>适宽</button>
          <button className={preferences.zoomMode === 'fit-page' ? 'active' : ''} aria-pressed={preferences.zoomMode === 'fit-page'} onClick={() => setPreferences((current) => ({ ...current, zoomMode: 'fit-page' }))}>适页</button>
        </div>
        <span className="reader-shortcuts">← → 翻页 · + − 缩放</span>
      </div>

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

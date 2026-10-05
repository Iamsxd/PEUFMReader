import { type FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerURL from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import {
  calculatePDFScale,
  calculatePDFYRatio,
  calculatePDFAnchorScrollTop,
  calculatePDFPageScrollLeft,
  clampPDFPage,
  clampPDFZoom,
  createPDFSearchSnippet,
  describePDFError,
  getPDFJSAssetOptions,
  getPDFViewPages,
  getPDFReadingAnchor,
  movePDFPage,
  normalizePDFWheelDelta,
  parsePDFPreferences,
  PDF_PREFERENCES_KEY,
  PDF_READING_ANCHOR_INSET,
} from '../../pdf'
import type { PDFPageFlow, PDFPageLayout, PDFReaderPreferences, PDFReadingAnchor } from '../../pdf'
import type { BookFile, HighlightColor, ReadingMark, ReadingState } from '../../types'
import { clampProgress } from '../../utils'
import { createPDFHighlightLocation, createPDFReadingMarkLocation, getReadingMarkNavigationTarget, pdfHighlightsForPage, upsertReadingMark } from '../../readingMarks'
import { PDFPageCanvas } from './PDFPageCanvas'
import { ReadingMarksPanel } from './ReadingMarksPanel'
import { HighlightComposer, type PendingHighlight } from './HighlightComposer'
import { SpeechPanel } from './SpeechPanel'
import { ScreenWakeLockControl } from './ScreenWakeLockControl'
import { useSpeechSynthesis } from '../../hooks/useSpeechSynthesis'
import { useReadingProgressPersistence } from '../../hooks/useReadingProgressPersistence'
import { isInteractiveReaderTarget, isReaderCenterTap, MOBILE_READER_CHROME_QUERY } from '../../readerChrome'
import { createReaderNavigationHistory } from '../../readerNavigation'
import { cachedReadingMarks, canonicalMarkID, createLocalReadingMark, loadReadingMarks, OFFLINE_MARKS_EVENT } from '../../offlineMarks'
import { confirmLeaveDrafts } from '../../draftGuard'
import { PDFTextPanel } from './PDFTextPanel'
import { PDFCropPanel } from './PDFCropPanel'
import { fullPDFPageBounds, NO_PDF_CROP, parsePDFCrop, type PDFCrop } from '../../pdfCrop'

pdfjs.GlobalWorkerOptions.workerSrc = workerURL

interface Props {
  book: BookFile
  userID: number
  contentURL: string
  contentData?: ArrayBuffer
  offlineMode: boolean
  initialState: ReadingState
  chromeVisible: boolean
  onChromeActivity: () => void
  onHideChrome: () => void
  onToggleChrome: () => void
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

type PDFSidePanel = 'toc' | 'search' | 'marks' | 'speech' | 'text' | 'crop' | null

interface PendingPDFAnchor {
  target: PDFReadingAnchor
  persist: boolean
  source?: PDFReadingAnchor
  history?: 'record' | 'back' | 'forward'
}

const samePDFAnchor = (left: PDFReadingAnchor, right: PDFReadingAnchor) => left.page === right.page && Math.abs(left.yRatio - right.yRatio) < .001

async function resolvePDFOutline(document: pdfjs.PDFDocumentProxy, nodes: PDFOutlineNode[], depth = 0, ancestry = ''): Promise<PDFOutlineEntry[]> {
  const entries: PDFOutlineEntry[] = []
  for (const [index, node] of nodes.entries()) {
    const path = ancestry ? `${ancestry}.${index}` : String(index)
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
    entries.push({ id: path, title: node.title || `第 ${page ?? '?'} 页`, page, depth })
    if (node.items?.length) entries.push(...await resolvePDFOutline(document, node.items, depth + 1, path))
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

export function PDFReader({ book, userID, contentURL, contentData, offlineMode, initialState, chromeVisible, onChromeActivity, onHideChrome, onToggleChrome, onProgress, readingStatus, onStatusChange }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const loadingTaskRef = useRef<pdfjs.PDFDocumentLoadingTask | null>(null)
  const visiblePagesRef = useRef(new Map<number, number>())
  const searchRunRef = useRef(0)
  const wheelZoomAccumulatorRef = useRef(0)
  const wheelZoomResetTimerRef = useRef<number | null>(null)
  const contentPointerStartRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)
  const initialAnchor = getPDFReadingAnchor(initialState.position, Number.MAX_SAFE_INTEGER)
  const initialPage = initialAnchor.page
  const currentAnchorRef = useRef<PDFReadingAnchor>(initialAnchor)
  const pendingAnchorRef = useRef<PendingPDFAnchor | null>({ target: initialAnchor, persist: false })
  const positionFrameRef = useRef<number | null>(null)
  const lastViewportSizeRef = useRef({ width: 0, height: 0 })
  const navigationRef = useRef(createReaderNavigationHistory<PDFReadingAnchor>({
    equals: samePDFAnchor,
    isValid: anchor => Number.isInteger(anchor.page) && anchor.page >= 1 && Number.isFinite(anchor.yRatio) && anchor.yRatio >= 0 && anchor.yRatio <= 1,
  }))
  const [navigationState, setNavigationState] = useState({ canBack: false, canForward: false })
  const [restoreRevision, setRestoreRevision] = useState(0)
  const [pdfDocument, setPDFDocument] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [pageNumber, setPageNumber] = useState(Math.max(1, initialPage))
  const [basePageSize, setBasePageSize] = useState({ width: 612, height: 792 })
  const [containerWidth, setContainerWidth] = useState(window.innerWidth)
  const [availableHeight, setAvailableHeight] = useState(Math.max(320, window.innerHeight - 96))
  const [isNarrow, setIsNarrow] = useState(window.innerWidth <= 720)
  const [preferences, setPreferences] = useState(readPreferences)
  const cropKey = `peufmreader.pdf.crop.v1.${userID}.${book.id}`
  const [crop, setCrop] = useState<PDFCrop>(() => { try { return parsePDFCrop(localStorage.getItem(cropKey)) } catch { return { ...NO_PDF_CROP } } })
  useEffect(() => { try { localStorage.setItem(cropKey, JSON.stringify(crop)) } catch { /* Cosmetic preference only. */ } }, [crop, cropKey])
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const [loadingStatus, setLoadingStatus] = useState('正在连接书库…')
  const [loadingProgress, setLoadingProgress] = useState<number | null>(null)
  const [sidePanel, setSidePanel] = useState<PDFSidePanel>(null)
  const [outline, setOutline] = useState<PDFOutlineEntry[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<PDFSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchProgress, setSearchProgress] = useState('')
  const [searchError, setSearchError] = useState('')
  const [highlights, setHighlights] = useState<ReadingMark[]>([])
  const [editingMarkID, setEditingMarkID] = useState<number | undefined>()
  const [pendingHighlight, setPendingHighlight] = useState<PendingHighlight | null>(null)
  const [savingHighlight, setSavingHighlight] = useState(false)
  const { schedule: scheduleProgress } = useReadingProgressPersistence({
    onProgress,
    onError: () => setError('阅读位置保存失败。'),
  })

  const pageCount = pdfDocument?.numPages ?? 0
  const pageCountRef = useRef(pageCount)
  pageCountRef.current = pageCount
  const effectiveLayout: PDFPageLayout = isNarrow ? 'single' : preferences.layout
  const scale = useMemo(() => calculatePDFScale({
    zoomMode: preferences.zoomMode,
    zoomPercent: preferences.zoomPercent,
    pageWidth: basePageSize.width * (1 - crop.left - crop.right),
    pageHeight: basePageSize.height * (1 - crop.top - crop.bottom),
    containerWidth,
    availableHeight,
    layout: effectiveLayout,
  }), [availableHeight, basePageSize, containerWidth, effectiveLayout, preferences.zoomMode, preferences.zoomPercent, crop])
  const displayedZoom = preferences.zoomMode === 'custom' ? preferences.zoomPercent : Math.round(scale * 100)
  const pages = useMemo(() => {
    if (!pageCount) return []
    if (preferences.flow === 'continuous') return Array.from({ length: pageCount }, (_, index) => index + 1)
    return getPDFViewPages(pageNumber, pageCount, effectiveLayout)
  }, [effectiveLayout, pageCount, pageNumber, preferences.flow])
  const speechPages = useMemo(() => {
    if (!pageCount) return []
    return preferences.flow === 'paged'
      ? getPDFViewPages(pageNumber, pageCount, effectiveLayout)
      : [pageNumber]
  }, [effectiveLayout, pageCount, pageNumber, preferences.flow])
  const requestAnchor = useCallback((target: PDFReadingAnchor, options: Omit<PendingPDFAnchor, 'target'>) => {
    const safeTarget = { page: clampPDFPage(target.page, pageCount), yRatio: target.yRatio }
    pendingAnchorRef.current = { ...options, target: safeTarget }
    setPageNumber(safeTarget.page)
    setRestoreRevision(revision => revision + 1)
  }, [pageCount])
  const loadSpeechPages = useCallback(async (targetPages: number[]) => {
    if (!pdfDocument || targetPages.length === 0) return { text: '', label: '当前 PDF 页面' }
    const pageTexts: string[] = []
    for (const page of targetPages) {
      const pageProxy = await pdfDocument.getPage(page)
      try {
        const content = await pageProxy.getTextContent()
        pageTexts.push(content.items.map((item) => {
          if (!('str' in item)) return ''
          return `${item.str}${'hasEOL' in item && item.hasEOL ? '\n' : ' '}`
        }).join(''))
      } finally {
        pageProxy.cleanup()
      }
    }
    const label = targetPages.length > 1
      ? `第 ${targetPages[0]}–${targetPages.at(-1)} 页`
      : `第 ${targetPages[0]} 页`
    return { text: pageTexts.join('\n\n'), label, cursor: targetPages.at(-1) }
  }, [pdfDocument])
  const loadSpeechSource = useCallback(() => loadSpeechPages(speechPages), [loadSpeechPages, speechPages])
  const loadNextSpeechSource = useCallback(async (source: { cursor?: number }) => {
    const lastPage = source.cursor ?? speechPages.at(-1) ?? pageNumber
    if (!pdfDocument || lastPage >= pageCount) return null
    const nextPage = lastPage + 1
    const nextPages = preferences.flow === 'paged'
      ? getPDFViewPages(nextPage, pageCount, effectiveLayout)
      : [nextPage]
    const nextSource = await loadSpeechPages(nextPages)
    return {
      source: nextSource,
      sourceKey: `${book.id}:${nextPages.join('-')}`,
      activate: () => {
        requestAnchor({ page: nextPages[0], yRatio: 0 }, { persist: true })
      },
    }
  }, [book.id, effectiveLayout, loadSpeechPages, pageCount, pageNumber, pdfDocument, preferences.flow, requestAnchor, speechPages])
  const speech = useSpeechSynthesis({
    loadSource: loadSpeechSource,
    loadNextSource: loadNextSpeechSource,
    sourceKey: `${book.id}:${speechPages.join('-')}`,
  })

  const readVisibleAnchor = useCallback((): PDFReadingAnchor => {
    const viewport = viewportRef.current
    if (!viewport) return currentAnchorRef.current
    const bounds = viewport.getBoundingClientRect()
    const line = bounds.top + PDF_READING_ANCHOR_INSET
    const visibleNumbers = new Set([...visiblePagesRef.current.keys(), currentAnchorRef.current.page])
    let candidates = [...visibleNumbers].flatMap(number => {
      const element = viewport.querySelector<HTMLElement>(`[data-pdf-page="${number}"]`)
      return element ? [{ number, bounds: element.getBoundingClientRect() }] : []
    }).filter(item => item.bounds.bottom > line && item.bounds.top < bounds.bottom && item.bounds.right > bounds.left && item.bounds.left < bounds.right)
    // A fast scrollbar jump can precede IntersectionObserver delivery.
    if (!candidates.length) candidates = Array.from(viewport.querySelectorAll<HTMLElement>('[data-pdf-page]')).map(element => ({
      number: Number(element.dataset.pdfPage), bounds: element.getBoundingClientRect(),
    })).filter(item => item.bounds.bottom > line && item.bounds.top < bounds.bottom && item.bounds.right > bounds.left && item.bounds.left < bounds.right)
    candidates.sort((left, right) => Math.max(0, left.bounds.top - line) - Math.max(0, right.bounds.top - line)
      || (left.number === currentAnchorRef.current.page ? -1 : right.number === currentAnchorRef.current.page ? 1 : left.number - right.number))
    const selected = candidates[0]
    const selectedPage = selected ? viewport.querySelector(`[data-pdf-page="${selected.number}"]`) : null
    const fullBounds = selectedPage ? fullPDFPageBounds(selectedPage) : null
    return selected && fullBounds ? { page: selected.number, yRatio: calculatePDFYRatio(fullBounds.top, fullBounds.height, bounds.top) } : currentAnchorRef.current
  }, [])

  const applyPendingAnchor = useCallback(() => {
    const pending = pendingAnchorRef.current
    const viewport = viewportRef.current
    if (!pending || !viewport) return
    const page = viewport.querySelector<HTMLElement>(`[data-pdf-page="${pending.target.page}"]`)
    if (!page) return
    const viewportBounds = viewport.getBoundingClientRect()
    const bounds = page.getBoundingClientRect()
    // A spread's right page can be wholly outside a zoomed viewport. Reveal
    // the placeholder too, so horizontal lazy visibility can load real size.
    viewport.scrollLeft = calculatePDFPageScrollLeft(viewport.scrollLeft, viewportBounds.left, viewport.clientWidth, bounds.left, bounds.width)
    const contentBounds = fullPDFPageBounds(page)
    viewport.scrollTop = calculatePDFAnchorScrollTop(viewport.scrollTop, viewportBounds.top, contentBounds.top, contentBounds.height, pending.target.yRatio)
    currentAnchorRef.current = pending.target
    // Lazy placeholders may have the first page's size. Keep the pending
    // request until this page's intrinsic dimensions have reached the DOM.
    if (page.dataset.geometryReady !== 'true') return
    const finalBounds = page.getBoundingClientRect()
    if (finalBounds.right <= viewportBounds.left || finalBounds.left >= viewportBounds.left + viewport.clientWidth) return
    const finalContentBounds = fullPDFPageBounds(page)
    const actual = { page: pending.target.page, yRatio: calculatePDFYRatio(finalContentBounds.top, finalContentBounds.height, viewportBounds.top) }
    currentAnchorRef.current = actual
    pendingAnchorRef.current = null
    if (pending.source && pending.history) {
      const history = navigationRef.current
      if (pending.history === 'record') history.record(pending.source, actual)
      else if (pending.history === 'back') history.goBack(pending.source)
      else history.goForward(pending.source)
    }
    setNavigationState({ canBack: navigationRef.current.canBack, canForward: navigationRef.current.canForward })
    if (pending.persist) scheduleProgress({ position: { pageIndex: actual.page - 1, yRatio: actual.yRatio }, overallProgress: clampProgress(actual.page / pageCount) }, 600)
  }, [pageCount, scheduleProgress])

  const captureVisiblePosition = useCallback(() => {
    if (!pageCount || pendingAnchorRef.current) return
    const anchor = readVisibleAnchor()
    if (samePDFAnchor(anchor, currentAnchorRef.current)) return
    currentAnchorRef.current = anchor
    setPageNumber(anchor.page)
    scheduleProgress({ position: { pageIndex: anchor.page - 1, yRatio: anchor.yRatio }, overallProgress: clampProgress(anchor.page / pageCount) }, 600)
  }, [pageCount, readVisibleAnchor, scheduleProgress])

  const schedulePositionCapture = useCallback(() => {
    if (positionFrameRef.current !== null) return
    positionFrameRef.current = window.requestAnimationFrame(() => {
      positionFrameRef.current = null
      if (pendingAnchorRef.current) applyPendingAnchor()
      else captureVisiblePosition()
    })
  }, [applyPendingAnchor, captureVisiblePosition])

  const handleGeometryReady = useCallback(() => {
    schedulePositionCapture()
  }, [schedulePositionCapture])

  useLayoutEffect(() => {
    if (!pdfDocument) return
    if (!pendingAnchorRef.current) pendingAnchorRef.current = { target: currentAnchorRef.current, persist: false }
    applyPendingAnchor()
  }, [applyPendingAnchor, containerWidth, effectiveLayout, pdfDocument, preferences.flow, restoreRevision, scale, availableHeight])

  useEffect(() => () => {
    if (positionFrameRef.current !== null) window.cancelAnimationFrame(positionFrameRef.current)
  }, [])

  useEffect(() => {
    let disposed = false
    visiblePagesRef.current.clear()
    currentAnchorRef.current = initialAnchor
    pendingAnchorRef.current = { target: initialAnchor, persist: false }
    navigationRef.current.clear()
    setNavigationState({ canBack: false, canForward: false })
    searchRunRef.current += 1
    setError('')
    setWarning('')
    setLoadingStatus(contentData ? '正在读取设备副本…' : '正在按需加载 PDF…')
    setLoadingProgress(contentData ? 100 : null)
    setPDFDocument(null)
    setOutline([])
    setSearchResults([])
    setSearching(false)
    setSearchProgress('')
    setSearchError('')

    // Online files use PDF.js' authenticated range transport. Disabling the
    // full stream and speculative fetch avoids retaining duplicate full buffers.
    // Servers without Range support automatically fall back to a normal GET.
    const task = pdfjs.getDocument({
      ...(contentData ? { data: new Uint8Array(contentData) } : {
        url: contentURL,
        withCredentials: true,
        rangeChunkSize: 256 * 1024,
        disableStream: true,
        disableAutoFetch: true,
      }),
      ...getPDFJSAssetOptions(import.meta.env.BASE_URL),
    })
    loadingTaskRef.current = task
    task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
      if (disposed) return
      setLoadingStatus(total ? `正在加载阅读所需页面 · ${Math.round((loaded / total) * 100)}%` : '正在加载阅读所需页面…')
      setLoadingProgress(total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : null)
    }
    void task.promise.then(async (document) => {
      if (!document || disposed) return
      const firstPage = await document.getPage(1)
      if (disposed) return
      const viewport = firstPage.getViewport({ scale: 1 })
      setBasePageSize({ width: viewport.width, height: viewport.height })
      const restoredAnchor = getPDFReadingAnchor(initialState.position, document.numPages)
      currentAnchorRef.current = restoredAnchor
      pendingAnchorRef.current = { target: restoredAnchor, persist: false }
      setPageNumber(clampPDFPage(initialPage, document.numPages))
      setPDFDocument(document)
      setLoadingStatus('')
      void document.getOutline().then((nodes) => resolvePDFOutline(document, nodes)).then((entries) => {
        if (!disposed) setOutline(entries)
      }).catch((reason: unknown) => {
        if (!disposed) console.warn('PDF outline loading failed.', reason)
      })
    }).catch((reason: unknown) => {
      if (disposed) return
      console.error('PDF loading failed', reason)
      setError(describePDFError(reason))
    })

    return () => {
      disposed = true
      searchRunRef.current += 1
      pendingAnchorRef.current = null
      const document = loadingTaskRef.current
      loadingTaskRef.current = null
      void document?.destroy()
    }
  }, [book.id, contentData, contentURL])

  useEffect(() => {
    let disposed = false
    const updateCache = () => { if (!disposed) setHighlights(cachedReadingMarks(userID, book.id).filter(mark => mark.kind === 'highlight')) }
    window.addEventListener(OFFLINE_MARKS_EVENT, updateCache)
    void loadReadingMarks(userID, book.id, offlineMode).then((marks) => {
      if (!disposed) setHighlights(marks.filter((mark) => mark.kind === 'highlight'))
    }).catch(() => {
      if (!disposed) setError('文本高亮加载失败。')
    })
    return () => { disposed = true; window.removeEventListener(OFFLINE_MARKS_EVENT, updateCache) }
  }, [book.id, offlineMode, userID])

  const syncHighlights = useCallback((marks: ReadingMark[]) => {
    setHighlights(marks.filter((mark) => mark.kind === 'highlight'))
  }, [])

  const handleTextSelection = useCallback((selectedPage: number, pageBounds: DOMRect, selectionRects: DOMRect[], quote: string) => {
    const shells = Array.from(viewportRef.current?.querySelectorAll<HTMLElement>('.pdf-page-shell') ?? [])
    const selectedRange = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : undefined
    const selectedQuotes: string[] = []
    const segments = shells.flatMap(shell => {
      const layer = shell.querySelector('.pdf-text-layer')
      if (!layer || !selectedRange?.intersectsNode(layer)) return []
      // A cross-page range also contains canvases and page chrome. Clip each
      // sub-range to the text layer to highlight only selected words.
      const clipped = document.createRange()
      clipped.selectNodeContents(layer)
      if (layer.contains(selectedRange.startContainer)) clipped.setStart(selectedRange.startContainer, selectedRange.startOffset)
      if (layer.contains(selectedRange.endContainer)) clipped.setEnd(selectedRange.endContainer, selectedRange.endOffset)
      const segment = createPDFHighlightLocation(Number(shell.dataset.pdfPage), pageCount, fullPDFPageBounds(shell), Array.from(clipped.getClientRects()))
      selectedQuotes.push(clipped.toString().replace(/\s+/g, ' ').trim())
      return Array.isArray(segment.position.rects) && segment.position.rects.length ? [segment.position] : []
    })
    const location = segments.length > 1 ? {
      ...createPDFReadingMarkLocation(Number(segments[0].pageIndex) + 1, pageCount),
      position: { ...segments[0], segments },
      label: `第 ${Number(segments[0].pageIndex) + 1}–${Number(segments.at(-1)!.pageIndex) + 1} 页高亮`,
    } : createPDFHighlightLocation(selectedPage, pageCount, pageBounds, selectionRects)
    if (!Array.isArray(location.position.rects) || location.position.rects.length === 0) return
    if (new TextEncoder().encode(JSON.stringify(location.position)).byteLength > 8 * 1024) { setError('选区过大，请分段创建高亮。'); return }
    setPendingHighlight({ ...location, quote: (segments.length > 1 ? selectedQuotes.join('\n') : quote).slice(0, 4000) })
    onChromeActivity()
  }, [onChromeActivity, pageCount])

  async function saveHighlight(color: HighlightColor, body: string) {
    if (!pendingHighlight) return
    setSavingHighlight(true)
    try {
      const mark = await createLocalReadingMark(userID, book.id, {
        kind: 'highlight',
        ...pendingHighlight,
        body,
        quote: pendingHighlight.quote,
        color,
      }, offlineMode)
      setHighlights((items) => upsertReadingMark(items, mark))
      setPendingHighlight(null)
      window.getSelection()?.removeAllRanges()
    } catch {
      setError('文本高亮保存失败。')
    } finally {
      setSavingHighlight(false)
    }
  }

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const measure = () => {
      const width = viewport.clientWidth || window.innerWidth
      const height = Math.max(320, window.innerHeight - 96)
      const previous = lastViewportSizeRef.current
      if (pageCountRef.current && (previous.width !== width || previous.height !== height) && !pendingAnchorRef.current) {
        pendingAnchorRef.current = { target: currentAnchorRef.current, persist: false }
      }
      lastViewportSizeRef.current = { width, height }
      setContainerWidth(width)
      setAvailableHeight(height)
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

  const goToPage = useCallback((requestedPage: number, yRatio = 0, remember = false) => {
    speech.stop()
    const source = pendingAnchorRef.current?.source ?? readVisibleAnchor()
    requestAnchor({ page: requestedPage, yRatio }, { persist: true, ...(remember ? { source, history: 'record' as const } : {}) })
  }, [readVisibleAnchor, requestAnchor, speech.stop])

  const navigateHistory = useCallback((direction: 'back' | 'forward') => {
    if (pendingAnchorRef.current) return
    const source = readVisibleAnchor()
    const target = direction === 'back' ? navigationRef.current.peekBack(source) : navigationRef.current.peekForward(source)
    if (!target) return
    speech.stop()
    requestAnchor(target, { persist: true, source, history: direction })
  }, [readVisibleAnchor, requestAnchor, speech.stop])

  const movePage = useCallback((direction: -1 | 1) => {
    goToPage(movePDFPage(pageNumber, pageCount, effectiveLayout, direction))
  }, [effectiveLayout, goToPage, pageCount, pageNumber])

  const changePreferences = useCallback((update: (current: PDFReaderPreferences) => PDFReaderPreferences) => {
    const next = update(preferences)
    if (next.flow === preferences.flow && next.layout === preferences.layout && next.zoomMode === preferences.zoomMode && next.zoomPercent === preferences.zoomPercent) return
    if (!pendingAnchorRef.current) pendingAnchorRef.current = { target: readVisibleAnchor(), persist: false }
    setPreferences(next)
  }, [preferences, readVisibleAnchor])

  const updateZoom = useCallback((delta: number) => {
    changePreferences((current) => ({
      ...current,
      zoomMode: 'custom',
      zoomPercent: clampPDFZoom((current.zoomMode === 'custom' ? current.zoomPercent : Math.round(scale * 100)) + delta),
    }))
  }, [changePreferences, scale])

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
    if (visiblePagesRef.current.size > 0) schedulePositionCapture()
  }, [schedulePositionCapture])

  const handleRenderError = useCallback((message: string) => {
    setError(`PDF 页面渲染失败（${message}）。`)
  }, [])

  const handleTextLayerError = useCallback((failedPage: number, message: string) => {
    console.warn(`PDF text layer rendering failed on page ${failedPage}.`, message)
    setWarning('PDF 页面已显示，但当前浏览器无法建立文字层；文字选择和高亮可能不可用。')
  }, [])

  const handleContentPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!window.matchMedia(MOBILE_READER_CHROME_QUERY).matches || !event.isPrimary) return
    const bounds = event.currentTarget.getBoundingClientRect()
    contentPointerStartRef.current = {
      pointerId: event.pointerId,
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    }
  }, [])

  const handleContentPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = contentPointerStartRef.current
    contentPointerStartRef.current = null
    if (!window.matchMedia(MOBILE_READER_CHROME_QUERY).matches || !event.isPrimary || !start || start.pointerId !== event.pointerId) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (isReaderCenterTap({
      startX: start.x,
      startY: start.y,
      endX: event.clientX - bounds.left,
      endY: event.clientY - bounds.top,
      viewportWidth: bounds.width,
      viewportHeight: bounds.height,
      hasSelection: Boolean(window.getSelection()?.toString().trim()),
      interactiveTarget: isInteractiveReaderTarget(event.target),
    })) onToggleChrome()
  }, [onToggleChrome])

  function setFlow(flow: PDFPageFlow) {
    changePreferences((current) => ({ ...current, flow }))
  }

  function setLayout(layout: PDFPageLayout) {
    changePreferences((current) => ({ ...current, layout }))
  }

  function toggleSidePanel(panel: Exclude<PDFSidePanel, null>) {
    if (!confirmLeaveDrafts()) return
    setSidePanel((current) => current === panel ? null : panel)
    onChromeActivity()
  }

  function selectPage(page: number) {
    goToPage(page, 0, true)
    setSidePanel(null)
  }

  const currentOutlineID = [...outline].reverse().find(entry => entry.page !== null && entry.page <= pageNumber)?.id
  useEffect(() => {
    if (sidePanel !== 'toc') return
    viewportRef.current?.parentElement?.querySelector<HTMLElement>('.reader-toc-list [aria-current="location"]')?.scrollIntoView({ block: 'nearest' })
  }, [currentOutlineID, sidePanel])

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
          <button className={sidePanel === 'marks' ? 'active' : ''} aria-pressed={sidePanel === 'marks'} onClick={() => { setEditingMarkID(undefined); toggleSidePanel('marks') }}>书签/高亮</button>
          <button className={sidePanel === 'speech' || speech.status === 'speaking' || speech.status === 'paused' ? 'active' : ''} aria-pressed={sidePanel === 'speech'} onClick={() => toggleSidePanel('speech')}>朗读</button>
          <button aria-pressed={sidePanel === 'text'} disabled={!pdfDocument} onClick={() => toggleSidePanel('text')}>文字阅读</button>
          <button aria-pressed={sidePanel === 'crop'} disabled={!pdfDocument} onClick={() => toggleSidePanel('crop')}>裁边</button>
        </div>
        <div className="reader-tool-group" aria-label="阅读位置">
          <button aria-label="返回刚才位置" title="返回上一次跳转前的位置，不是退出阅读器" disabled={!navigationState.canBack || Boolean(pendingAnchorRef.current)} onClick={() => navigateHistory('back')}>返回刚才</button>
          <button aria-label="前进到跳转位置" disabled={!navigationState.canForward || Boolean(pendingAnchorRef.current)} onClick={() => navigateHistory('forward')}>前进</button>
        </div>
        <ScreenWakeLockControl onChromeActivity={onChromeActivity} />
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
          <button className="reader-zoom-value" title="恢复 100%" onClick={() => changePreferences((current) => ({ ...current, zoomMode: 'custom', zoomPercent: 100 }))}>{displayedZoom}%</button>
          <button title="放大（+）" aria-label="放大" onClick={() => updateZoom(10)}>＋</button>
          <button className={preferences.zoomMode === 'fit-width' ? 'active' : ''} aria-pressed={preferences.zoomMode === 'fit-width'} onClick={() => changePreferences((current) => ({ ...current, zoomMode: 'fit-width' }))}>适宽</button>
          <button className={preferences.zoomMode === 'fit-page' ? 'active' : ''} aria-pressed={preferences.zoomMode === 'fit-page'} onClick={() => changePreferences((current) => ({ ...current, zoomMode: 'fit-page' }))}>适页</button>
        </div>
        <span className="reader-shortcuts">← → 翻页 · + − / Ctrl+滚轮缩放</span>
      </div>

      {sidePanel === 'crop' && <PDFCropPanel crop={crop} onChange={next => {
        if (!pendingAnchorRef.current) pendingAnchorRef.current = { target: readVisibleAnchor(), persist: false }
        setCrop(next)
      }} onClose={() => setSidePanel(null)} onChromeActivity={onChromeActivity} />}
      {sidePanel === 'speech' ? (
        <SpeechPanel
          controls={speech}
          sourceDescription={speechPages.length > 1 ? `当前第 ${speechPages[0]}–${speechPages.at(-1)} 页` : `当前第 ${speechPages[0] ?? pageNumber} 页`}
          onClose={() => setSidePanel(null)}
          onChromeActivity={onChromeActivity}
        />
      ) : sidePanel === 'text' && pdfDocument ? (
        <PDFTextPanel document={pdfDocument} pageNumber={pageNumber} onPageChange={page => goToPage(page, 0, true)} onClose={() => setSidePanel(null)} />
      ) : sidePanel === 'marks' ? (
        <ReadingMarksPanel
          bookFileID={book.id}
          userID={userID}
          offlineMode={offlineMode}
          initialEditingID={editingMarkID}
          current={createPDFReadingMarkLocation(pageNumber, pageCount, currentAnchorRef.current.yRatio)}
          onNavigate={(position) => {
            const target = getReadingMarkNavigationTarget(book.format, position)
            if (typeof target === 'number') {
              const anchor = getPDFReadingAnchor(position, pageCount)
              goToPage(anchor.page, anchor.yRatio, true)
              setSidePanel(null)
            }
          }}
          onClose={() => setSidePanel(null)}
          onChromeActivity={onChromeActivity}
          onMarksChange={syncHighlights}
        />
      ) : (sidePanel === 'toc' || sidePanel === 'search') && (
        <aside className="reader-side-panel" aria-label={sidePanel === 'toc' ? 'PDF 目录' : 'PDF 书内搜索'} onPointerDown={onChromeActivity}>
          <header>
            <strong>{sidePanel === 'toc' ? '目录' : '书内搜索'}</strong>
            <button onClick={() => setSidePanel(null)} aria-label="关闭侧栏">×</button>
          </header>
          {sidePanel === 'toc' ? (
            <div className="reader-toc-list">
              {outline.length === 0 && <p className="reader-panel-empty">这份 PDF 没有可用目录。</p>}
              {outline.map((entry) => (
                <button key={entry.id} aria-current={entry.id === currentOutlineID ? 'location' : undefined} disabled={entry.page === null} style={{ paddingLeft: `${14 + entry.depth * 16}px` }} onClick={() => entry.page && selectPage(entry.page)}>
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

      {pendingHighlight && (
        <HighlightComposer selection={pendingHighlight} busy={savingHighlight} onSave={(color, body) => void saveHighlight(color, body)} onCancel={() => { setPendingHighlight(null); window.getSelection()?.removeAllRanges() }} onSpeak={speech.supported ? () => { void speech.start({ text: pendingHighlight.quote, label: '选中文字', selectionOnly: true }); setPendingHighlight(null); setSidePanel('speech') } : undefined} />
      )}

      {error && <div className="notice error pdf-error">{error}</div>}
      {warning && !error && <div className="notice warning pdf-warning" role="status">{warning}</div>}
      {!pdfDocument && !error && <div className="pdf-loading"><span className="loading-spinner" /><strong>{loadingStatus}</strong>{loadingProgress !== null && <span className="reader-load-progress" aria-label={`PDF 加载进度 ${loadingProgress}%`}><i style={{ width: `${loadingProgress}%` }} /></span>}<small>大文件首次打开可能需要一些时间，后续页面会按可见区域渲染。</small></div>}

      <div
        ref={viewportRef}
        className="pdf-reader-viewport"
        onScroll={schedulePositionCapture}
        onPointerDown={handleContentPointerDown}
        onPointerUp={handleContentPointerUp}
        onPointerCancel={() => { contentPointerStartRef.current = null }}
      >
        {pdfDocument && (
          <div className={`pdf-pages ${preferences.flow} ${effectiveLayout}`}>
            {pages.map((number) => (
              <PDFPageCanvas
                key={number}
                document={pdfDocument}
                pageNumber={number}
                scale={scale}
                crop={crop}
                lazy={preferences.flow === 'continuous'}
                observerRoot={viewportRef.current}
                fallbackSize={basePageSize}
                onVisibilityChange={handleVisibilityChange}
                onGeometryReady={handleGeometryReady}
                onRenderError={handleRenderError}
                onTextLayerError={handleTextLayerError}
                highlights={pdfHighlightsForPage(highlights, number)}
                onHighlightClick={id => { if (confirmLeaveDrafts()) { setEditingMarkID(canonicalMarkID(userID, id)); setSidePanel('marks'); onChromeActivity() } }}
                onTextSelection={handleTextSelection}
              />
            ))}
          </div>
        )}
      </div>

      {pageCount > 0 && (
        <nav className={`pdf-navigation${chromeVisible ? '' : ' is-hidden'}`} aria-label="PDF 翻页" aria-hidden={!chromeVisible}>
          <button disabled={pageNumber <= 1} onClick={() => movePage(-1)} aria-label="上一页" title="上一页（←）">←</button>
          <label>
            <span className="visually-hidden">页码</span>
            <input
              type="number"
              min={1}
              max={pageCount}
              value={pageNumber}
              onChange={(event) => goToPage(Number(event.target.value), 0, true)}
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

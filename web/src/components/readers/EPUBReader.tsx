import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ePub, { type Book, type Contents, type Rendition } from 'epubjs'
import { api } from '../../api'
import {
  clampEPUBFontSize,
  DEFAULT_EPUB_TYPOGRAPHY,
  EPUB_PREFERENCES_KEY,
  EPUB_TYPOGRAPHY_KEY,
  findCurrentEPUBTOCEntry,
  flattenEPUBNavigation,
  getEPUBTypographyRules,
  getEPUBRestoreTargets,
  normalizeEPUBWheelDelta,
  parseEPUBPreferences,
  parseEPUBTypography,
  resolveEPUBOpenAs,
  resolveEPUBProgress,
} from '../../epub'
import type { EPUBPageFlow, EPUBPageLayout, EPUBReaderPreferences, EPUBTheme, EPUBTOCEntry, EPUBTypographyPreferences } from '../../epub'
import type { BookFile, HighlightColor, ReadingMark, ReadingState } from '../../types'
import { clampProgress } from '../../utils'
import { createEPUBReadingMarkLocation, getReadingMarkNavigationTarget, upsertReadingMark, type ReadingMarkLocation } from '../../readingMarks'
import { ReadingMarksPanel } from './ReadingMarksPanel'
import { HighlightComposer, type PendingHighlight } from './HighlightComposer'
import { SpeechPanel } from './SpeechPanel'
import { ScreenWakeLockControl } from './ScreenWakeLockControl'
import { useSpeechSynthesis } from '../../hooks/useSpeechSynthesis'
import { useReadingProgressPersistence } from '../../hooks/useReadingProgressPersistence'
import { extractReadableDocumentText } from '../../speech'
import { isInteractiveReaderTarget, isReaderCenterTap, MOBILE_READER_CHROME_QUERY } from '../../readerChrome'
import { createReaderNavigationHistory } from '../../readerNavigation'
import { EPUBTypographyPanel } from './EPUBTypographyPanel'

interface Props {
  book: BookFile
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

type EPUBSidePanel = 'toc' | 'search' | 'marks' | 'speech' | 'typography' | 'progress' | null

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

function readTypography(): EPUBTypographyPreferences {
  try {
    return parseEPUBTypography(window.localStorage.getItem(EPUB_TYPOGRAPHY_KEY))
  } catch {
    return parseEPUBTypography(null)
  }
}

function applyTypography(rendition: Rendition, preferences: EPUBTypographyPreferences) {
  // epub.js addStylesheetRules() appends CSSOM rules even for an existing key.
  // Replace only our default sheet; otherwise "respect original" would leave
  // previous !important overrides active and repeated slider drags grow CSS.
  for (const contents of rendition.getContents()) {
    contents.document.getElementById('epubjs-inserted-css-default')?.remove()
  }
  rendition.themes.default(getEPUBTypographyRules(preferences))
}

function readVisibleLocation(rendition: Rendition): RelocatedLocation | undefined {
  // The default/continuous manager used here computes its visible mapping
  // synchronously. rendition.reportLocation() is instead queued and then
  // RAF-based; a resolved display() does not mean its relocated event arrived.
  try {
    const location = rendition.currentLocation()
    if (!location?.start?.cfi?.startsWith('epubcfi(')) return undefined
    return { ...location, start: location.start }
  } catch {
    return undefined
  }
}

export function EPUBReader({ book, contentURL, contentData, offlineMode, initialState, chromeVisible, onChromeActivity, onHideChrome, onToggleChrome, onProgress, readingStatus, onStatusChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const bookRef = useRef<Book | null>(null)
  const wheelResetTimerRef = useRef<number | null>(null)
  const wheelAccumulatorRef = useRef(0)
  const wheelLockedUntilRef = useRef(0)
  const locationsReadyRef = useRef(false)
  const searchRunRef = useRef(0)
  const renderedHighlightCFIsRef = useRef<string[]>([])
  const highlightsRef = useRef<ReadingMark[]>([])
  const lastProgressRef = useRef(clampProgress(initialState.overallProgress))
  const currentCFIRef = useRef(typeof initialState.position.cfi === 'string' ? initialState.position.cfi : '')
  const publishLocationRef = useRef<(location: RelocatedLocation) => void>(() => {})
  const navigationHistoryRef = useRef(createReaderNavigationHistory<string>({ isValid: (cfi) => cfi.startsWith('epubcfi(') }))
  const navigationRunRef = useRef(0)
  const navigatingRef = useRef(false)
  const readerReadyRef = useRef(false)
  const reflowingRef = useRef(false)
  const reflowAnchorRef = useRef('')
  const reflowRunRef = useRef(0)
  const appliedLayoutRef = useRef<{ flow: EPUBPageFlow; layout: EPUBPageLayout; fontSize: number; typography: EPUBTypographyPreferences } | null>(null)
  const sidePanelTriggerRef = useRef<HTMLButtonElement | null>(null)
  const sidePanelRef = useRef<EPUBSidePanel>(null)
  const tocListRef = useRef<HTMLDivElement>(null)
  const [preferences, setPreferences] = useState(readPreferences)
  const preferencesRef = useRef(preferences)
  const [typography, setTypography] = useState(readTypography)
  const typographyRef = useRef(typography)
  const [historyState, setHistoryState] = useState({ canBack: false, canForward: false })
  const [navigating, setNavigating] = useState(false)
  const [reflowing, setReflowing] = useState(false)
  const [navigationError, setNavigationError] = useState('')
  const [locationsReady, setLocationsReady] = useState(false)
  const [previewProgress, setPreviewProgress] = useState(Math.round(clampProgress(initialState.overallProgress) * 100))
  const [isNarrow, setIsNarrow] = useState(window.innerWidth <= 780)
  const [progress, setProgress] = useState(clampProgress(initialState.overallProgress))
  const [currentChapter, setCurrentChapter] = useState({
    href: typeof initialState.position.href === 'string' ? initialState.position.href : '',
    index: typeof initialState.position.chapterIndex === 'number' ? initialState.position.chapterIndex : -1,
  })
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
  const { schedule: scheduleProgress } = useReadingProgressPersistence({
    onProgress,
    onError: () => setError('阅读位置保存失败。'),
  })
  preferencesRef.current = preferences
  typographyRef.current = typography
  highlightsRef.current = highlights
  sidePanelRef.current = sidePanel

  const effectiveLayout: EPUBPageLayout = preferences.flow === 'continuous' || isNarrow ? 'single' : preferences.layout
  const loadSpeechSource = useCallback(async () => {
    const rendition = renditionRef.current
    if (!rendition) return { text: '', label: '当前 EPUB 章节' }
    const contents = rendition.getContents()
    const matchingContents = currentChapter.index >= 0
      ? contents.filter((content) => content.sectionIndex === currentChapter.index)
      : contents
    const activeContents = matchingContents.length > 0 ? matchingContents : contents
    const text = activeContents.map((content) => extractReadableDocumentText(content.document)).filter(Boolean).join('\n\n')
    const normalizedHref = currentChapter.href.split('#')[0]
    const chapterLabel = toc.find((entry) => entry.href.split('#')[0] === normalizedHref)?.label
      ?? (currentChapter.index >= 0 ? `第 ${currentChapter.index + 1} 章` : '当前章节')
    const language = activeContents[0]?.document.documentElement.lang || undefined
    return { text, label: chapterLabel, language, cursor: activeContents[0]?.sectionIndex ?? currentChapter.index }
  }, [currentChapter, toc])
  const loadNextSpeechSource = useCallback(async (source: { cursor?: number }) => {
    const epub = bookRef.current
    const rendition = renditionRef.current
    if (!epub || !rendition) return null
    const currentIndex = source.cursor ?? currentChapter.index
    const section = epub.spine.spineItems.find((candidate) => candidate.linear !== false && candidate.index > currentIndex)
    if (!section) return null
    await section.load(epub.load.bind(epub))
    try {
      const text = extractReadableDocumentText(section.document)
      const normalizedHref = section.href.split('#')[0]
      const chapterLabel = toc.find((entry) => entry.href.split('#')[0] === normalizedHref)?.label ?? `第 ${section.index + 1} 章`
      const language = section.document.documentElement.lang || undefined
      return {
        source: { text, label: chapterLabel, language, cursor: section.index },
        sourceKey: `${book.id}:${section.index}`,
        activate: async () => {
          if (renditionRef.current !== rendition || reflowingRef.current || navigatingRef.current) throw new Error('Reader layout or navigation is changing.')
          const run = ++navigationRunRef.current
          navigatingRef.current = true
          setNavigating(true)
          try {
            await rendition.display(section.href)
            if (navigationRunRef.current !== run || renditionRef.current !== rendition) return
            const location = readVisibleLocation(rendition)
            if (location) publishLocationRef.current(location)
          } finally {
            if (navigationRunRef.current === run && renditionRef.current === rendition) {
              navigatingRef.current = false
              setNavigating(false)
            }
          }
        },
      }
    } finally {
      section.unload()
    }
  }, [book.id, currentChapter.index, toc])
  const speech = useSpeechSynthesis({
    loadSource: loadSpeechSource,
    loadNextSource: loadNextSpeechSource,
    sourceKey: `${book.id}:${currentChapter.index}`,
  })

  const turnPage = useCallback((direction: -1 | 1) => {
    const rendition = renditionRef.current
    if (!rendition || !readerReadyRef.current || navigatingRef.current || reflowingRef.current) return
    const run = ++navigationRunRef.current
    navigatingRef.current = true
    setNavigating(true)
    setNavigationError('')
    speech.stop()
    void (direction < 0 ? rendition.prev() : rendition.next()).then(() => {
      if (navigationRunRef.current !== run || renditionRef.current !== rendition) return
      const location = readVisibleLocation(rendition)
      if (location) publishLocationRef.current(location)
    }).catch(() => {
      if (navigationRunRef.current === run && renditionRef.current === rendition) setNavigationError('EPUB 翻页失败，请稍后重试。')
    }).finally(() => {
      if (navigationRunRef.current !== run || renditionRef.current !== rendition) return
      navigatingRef.current = false
      setNavigating(false)
    })
  }, [speech.stop])

  const captureReflowAnchor = useCallback(() => {
    if (reflowAnchorRef.current) return
    // Continuous scrolling reports relocated after a debounce. Capture what
    // is visible now, rather than restoring the last earlier scroll report.
    const rendition = renditionRef.current
    reflowAnchorRef.current = (rendition ? readVisibleLocation(rendition)?.start.cfi : undefined) ?? currentCFIRef.current
  }, [])

  const updateFontSize = useCallback((delta: number) => {
    if (navigatingRef.current) return
    setPreferences((current) => {
      const fontSize = clampEPUBFontSize(current.fontSize + delta)
      if (fontSize === current.fontSize) return current
      captureReflowAnchor()
      return { ...current, fontSize }
    })
  }, [captureReflowAnchor])

  const closeSidePanel = useCallback(() => {
    setSidePanel(null)
    sidePanelTriggerRef.current?.focus({ preventScroll: true })
  }, [])

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null
    if (event.key === 'Escape') {
      event.preventDefault()
      if (sidePanelRef.current) closeSidePanel()
      else onHideChrome()
      return
    }
    if (target?.matches('input, select, textarea, button')) return
    if (event.key === 'Tab') {
      onChromeActivity()
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
  }, [closeSidePanel, onChromeActivity, onHideChrome, turnPage, updateFontSize])

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
    if (offlineMode) {
      setHighlights([])
      setSidePanel((current) => current === 'marks' ? null : current)
      return
    }
    let disposed = false
    void api.listReadingMarks(book.id).then((marks) => {
      if (!disposed) setHighlights(marks.filter((mark) => mark.kind === 'highlight'))
    }).catch(() => {
      if (!disposed) setError('文本高亮加载失败。')
    })
    return () => { disposed = true }
  }, [book.id, offlineMode])

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
    readerReadyRef.current = false
    navigationRunRef.current += 1
    reflowRunRef.current += 1
    navigationHistoryRef.current.clear()
    setHistoryState({ canBack: false, canForward: false })
    navigatingRef.current = false
    reflowingRef.current = false
    reflowAnchorRef.current = ''
    setNavigating(false)
    setReflowing(false)
    setNavigationError('')
    currentCFIRef.current = typeof initialState.position.cfi === 'string' ? initialState.position.cfi : ''
    setProgress(clampProgress(initialState.overallProgress))
    setCurrentChapter({
      href: typeof initialState.position.href === 'string' ? initialState.position.href : '',
      index: typeof initialState.position.chapterIndex === 'number' ? initialState.position.chapterIndex : -1,
    })
    setMarkLocation({
      position: initialState.position,
      overallProgress: clampProgress(initialState.overallProgress),
      label: `阅读进度 ${Math.round(clampProgress(initialState.overallProgress) * 100)}%`,
    })
    lastProgressRef.current = clampProgress(initialState.overallProgress)
    locationsReadyRef.current = false
    setLocationsReady(false)
    searchRunRef.current += 1
    setTOC([])
    setSearchResults([])
    setSearching(false)
    setSearchProgress('')
    setSearchError('')
    setAtStart(initialState.overallProgress <= 0)
    setAtEnd(initialState.overallProgress >= 0.999)
    const epub = ePub(contentData ?? contentURL, { requestCredentials: !contentData, openAs: resolveEPUBOpenAs(contentData) })
    const initialPreferences = preferencesRef.current
    const initialTypography = typographyRef.current
    const initialLayout = initialPreferences.flow === 'continuous' || (host.clientWidth || window.innerWidth) <= 780 ? 'single' : initialPreferences.layout
    appliedLayoutRef.current = { flow: initialPreferences.flow, layout: initialLayout, fontSize: initialPreferences.fontSize, typography: initialTypography }
    const rendition = epub.renderTo(host, {
      width: '100%',
      height: '100%',
      manager: 'continuous',
      flow: initialPreferences.flow === 'continuous' ? 'scrolled-continuous' : 'paginated',
      spread: initialLayout === 'spread' ? 'auto' : 'none',
      minSpreadWidth: 780,
      snap: true,
      allowScriptedContent: false,
    })
    bookRef.current = epub
    renditionRef.current = rendition

    applyTypography(rendition, initialTypography)
    for (const [name, rules] of Object.entries(EPUB_THEMES)) rendition.themes.register(name, rules)
    rendition.themes.select(initialPreferences.theme)
    rendition.themes.fontSize(`${initialPreferences.fontSize}%`)

    const contentEventCleanups: Array<() => void> = []
    const attachContentEvents = (contents: Contents) => {
      let pointerStart: { pointerId: number; x: number; y: number } | null = null
      const handleContentPointerDown = (event: PointerEvent) => {
        if (!window.matchMedia(MOBILE_READER_CHROME_QUERY).matches || !event.isPrimary) return
        pointerStart = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
      }
      const handleContentPointerUp = (event: PointerEvent) => {
        const start = pointerStart
        pointerStart = null
        if (!window.matchMedia(MOBILE_READER_CHROME_QUERY).matches || !event.isPrimary || !start || start.pointerId !== event.pointerId) return
        const viewport = contents.document.documentElement
        if (isReaderCenterTap({
          startX: start.x,
          startY: start.y,
          endX: event.clientX,
          endY: event.clientY,
          viewportWidth: viewport.clientWidth,
          viewportHeight: viewport.clientHeight,
          hasSelection: Boolean(contents.document.getSelection()?.toString().trim()),
          interactiveTarget: isInteractiveReaderTarget(event.target),
        })) onToggleChrome()
      }
      const clearContentPointer = () => { pointerStart = null }
      contents.document.addEventListener('wheel', handleWheel, { passive: false })
      contents.document.addEventListener('pointerdown', handleContentPointerDown, { passive: true })
      contents.document.addEventListener('pointerup', handleContentPointerUp, { passive: true })
      contents.document.addEventListener('pointercancel', clearContentPointer, { passive: true })
      contentEventCleanups.push(() => {
        contents.document.removeEventListener('wheel', handleWheel)
        contents.document.removeEventListener('pointerdown', handleContentPointerDown)
        contents.document.removeEventListener('pointerup', handleContentPointerUp)
        contents.document.removeEventListener('pointercancel', clearContentPointer)
      })
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
          if (disposed) return
          setLocationsReady(true)
          await rendition.display(epub.locations.cfiFromPercentage(clampProgress(initialState.overallProgress)))
          restored = true
        } catch (reason) {
          console.warn('EPUB percentage restore failed; opening the first section.', reason)
        }
      }
      if (!restored) await rendition.display()
      if (disposed) return
      const restoredLocation = readVisibleLocation(rendition)
      if (restoredLocation) publishLocationRef.current(restoredLocation)
      window.clearTimeout(displayTimeout)
      setError('')
      readerReadyRef.current = true
      setLoading(false)
      renderHighlights(rendition, highlightsRef.current)

      if (!locationsReadyRef.current) {
        void epub.locations.generate(1600).then(() => {
          if (!disposed) {
            locationsReadyRef.current = true
            setLocationsReady(true)
          }
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
      // Reflow briefly emits transient page starts. Do not persist those in
      // place of the original stable CFI while its layout is being restored.
      if (disposed || reflowingRef.current) return
      const cfi = location.start.cfi
      currentCFIRef.current = cfi
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
      setCurrentChapter({ href: location.start.href ?? '', index: location.start.index ?? -1 })
      setAtStart(Boolean(location.atStart) || nextProgress <= 0)
      setAtEnd(Boolean(location.atEnd) || nextProgress >= 0.999)
      scheduleProgress({
        position: {
          cfi,
          href: location.start.href ?? '',
          chapterIndex: location.start.index,
          progression: nextProgress,
        },
        overallProgress: nextProgress,
      }, 500)
    }
    publishLocationRef.current = relocated
    const contentPointerMove = (event: MouseEvent) => {
      if (event.clientY <= 100) onChromeActivity()
    }
    const selected = (cfiRange: string, contents: Contents) => {
      if (offlineMode) return
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
      navigationRunRef.current += 1
      reflowRunRef.current += 1
      navigationHistoryRef.current.clear()
      appliedLayoutRef.current = null
      searchRunRef.current += 1
      window.clearTimeout(displayTimeout)
      if (wheelResetTimerRef.current !== null) window.clearTimeout(wheelResetTimerRef.current)
      contentEventCleanups.forEach((cleanup) => cleanup())
      host.removeEventListener('wheel', handleWheel)
      rendition.hooks.content.deregister(attachContentEvents)
      rendition.off('relocated', relocated)
      rendition.off('selected', selected)
      rendition.off('keydown', handleKeyDown)
      rendition.off('mousemove', contentPointerMove)
      rendition.destroy()
      epub.destroy()
      renditionRef.current = null
      readerReadyRef.current = false
      publishLocationRef.current = () => {}
      bookRef.current = null
      renderedHighlightCFIsRef.current = []
      host.innerHTML = ''
    }
  }, [book.id, contentData, contentURL, offlineMode])

  useEffect(() => {
    try {
      window.localStorage.setItem(EPUB_PREFERENCES_KEY, JSON.stringify(preferences))
    } catch {
      // Private browsing or a locked-down browser can reject local storage.
    }
  }, [preferences])

  useEffect(() => {
    try {
      window.localStorage.setItem(EPUB_TYPOGRAPHY_KEY, JSON.stringify(typography))
    } catch {
      // A storage failure must not disable in-session reading customization.
    }
  }, [typography])

  useEffect(() => {
    const rendition = renditionRef.current
    const previous = appliedLayoutRef.current
    // Screen rotation can change effectiveLayout during an explicit jump.
    // Wait for its destination before capturing the reflow anchor.
    if (!rendition || !previous || loading || navigating) return
    const next = { flow: preferences.flow, layout: effectiveLayout, fontSize: preferences.fontSize, typography }
    // A slider can move away and return to its starting value before debounce.
    // If a prior reflow is pending, still finish its anchor restoration rather
    // than leaving the reader permanently marked busy after effect cleanup.
    if (JSON.stringify(previous) === JSON.stringify(next) && !reflowingRef.current) {
      reflowAnchorRef.current = ''
      return
    }
    const anchor = reflowAnchorRef.current || currentCFIRef.current
    reflowAnchorRef.current = anchor
    reflowingRef.current = true
    setReflowing(true)
    setNavigationError('')
    speech.stop()
    const run = ++reflowRunRef.current
    let firstFrame: number | undefined
    let secondFrame: number | undefined
    const isCurrent = () => reflowRunRef.current === run && renditionRef.current === rendition
    const finish = () => {
      if (!isCurrent()) return
      reflowingRef.current = false
      reflowAnchorRef.current = ''
      setReflowing(false)
      const restoredLocation = readVisibleLocation(rendition)
      if (restoredLocation) publishLocationRef.current(restoredLocation)
      // display() resolves before its RAF-based location report. Request a
      // fresh report after unfreezing progress so the final visible CFI saves.
      void rendition.reportLocation()
    }
    // Coalesce range drags; each change uses the anchor captured before reflow.
    const timer = window.setTimeout(() => {
      if (!isCurrent()) return
      if (previous.flow !== next.flow) rendition.flow(next.flow === 'continuous' ? 'scrolled-continuous' : 'paginated')
      if (previous.layout !== next.layout) rendition.spread(next.layout === 'spread' ? 'auto' : 'none', 780)
      applyTypography(rendition, next.typography)
      rendition.themes.fontSize(`${next.fontSize}%`)
      appliedLayoutRef.current = next
      firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(() => {
          if (!isCurrent()) return
          void rendition.display(anchor || undefined).then(finish).catch(() => {
            if (isCurrent()) setNavigationError('排版已更新，但阅读位置恢复失败，请使用目录重新定位。')
            finish()
          })
        })
      })
    }, 120)
    return () => {
      window.clearTimeout(timer)
      if (firstFrame !== undefined) window.cancelAnimationFrame(firstFrame)
      if (secondFrame !== undefined) window.cancelAnimationFrame(secondFrame)
      if (isCurrent()) reflowRunRef.current += 1
    }
  }, [effectiveLayout, loading, navigating, preferences.flow, preferences.fontSize, speech.stop, typography])

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
  const currentTOCEntry = useMemo(() => findCurrentEPUBTOCEntry(toc, currentChapter.href), [toc, currentChapter.href])

  useEffect(() => {
    if (sidePanel !== 'toc') return
    tocListRef.current?.querySelector<HTMLElement>('[aria-current="location"]')?.scrollIntoView({ block: 'nearest' })
  }, [currentTOCEntry?.id, sidePanel])

  function setFlow(flow: EPUBPageFlow) {
    if (navigatingRef.current || preferences.flow === flow) return
    captureReflowAnchor()
    setPreferences((current) => ({ ...current, flow }))
  }

  function setLayout(layout: EPUBPageLayout) {
    if (navigatingRef.current || preferences.layout === layout) return
    captureReflowAnchor()
    setPreferences((current) => ({ ...current, layout }))
  }

  function setTheme(theme: EPUBTheme) {
    setPreferences((current) => ({ ...current, theme }))
  }

  function changeTypography(next: EPUBTypographyPreferences) {
    if (navigatingRef.current || JSON.stringify(typography) === JSON.stringify(next)) return
    captureReflowAnchor()
    setTypography(next)
  }

  function toggleSidePanel(panel: Exclude<EPUBSidePanel, null>, trigger: HTMLButtonElement) {
    sidePanelTriggerRef.current = trigger
    if (panel === 'progress') setPreviewProgress(Math.round(progress * 100))
    setSidePanel((current) => current === panel ? null : panel)
    onChromeActivity()
  }

  async function displayLocation(target: string | number, direction?: 'back' | 'forward') {
    const rendition = renditionRef.current
    if (!rendition || !readerReadyRef.current || navigatingRef.current || reflowingRef.current || loading) return
    let source = currentCFIRef.current
    try {
      const visible = readVisibleLocation(rendition)
      if (visible) {
        source = visible.start.cfi
        publishLocationRef.current(visible)
      }
    } catch {
      // Keep the most recent published anchor for EPUBs without a mapping.
    }
    const panelAtStart = sidePanelRef.current
    const run = ++navigationRunRef.current
    navigatingRef.current = true
    setNavigating(true)
    setNavigationError('')
    speech.stop()
    try {
      await rendition.display(target)
      if (navigationRunRef.current !== run || renditionRef.current !== rendition) return
      const destination = readVisibleLocation(rendition)
      if (!destination) throw new Error('EPUB display did not yield a visible location.')
      publishLocationRef.current(destination)
      const history = navigationHistoryRef.current
      if (direction === 'back') history.goBack(source)
      else if (direction === 'forward') history.goForward(source)
      else history.record(source, destination.start.cfi)
      setHistoryState({ canBack: history.canBack, canForward: history.canForward })
      // A user may open another panel while the asynchronous jump renders.
      // Close only the originating panel, not that newer navigation request.
      if (sidePanelRef.current === panelAtStart) closeSidePanel()
    } catch {
      if (navigationRunRef.current === run && renditionRef.current === rendition) setNavigationError('无法定位到该内容，原跳转历史已保留。')
    } finally {
      if (navigationRunRef.current === run && renditionRef.current === rendition) {
        navigatingRef.current = false
        setNavigating(false)
      }
    }
  }

  function navigateHistory(direction: 'back' | 'forward') {
    const history = navigationHistoryRef.current
    let source = currentCFIRef.current
    const rendition = renditionRef.current
    if (rendition) {
      try { source = readVisibleLocation(rendition)?.start.cfi ?? source } catch { /* use the last published CFI */ }
    }
    const target = direction === 'back' ? history.peekBack(source) : history.peekForward(source)
    if (target) void displayLocation(target, direction)
  }

  function jumpToPreviewProgress() {
    const epub = bookRef.current
    if (!epub || !locationsReadyRef.current) return
    try {
      void displayLocation(epub.locations.cfiFromPercentage(previewProgress / 100))
    } catch {
      setNavigationError('这本书暂时不能按百分比定位，请使用目录。')
    }
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
    <div className={`epub-reader theme-${preferences.theme}`} aria-busy={loading || navigating || reflowing}>
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
          <button className={sidePanel === 'toc' ? 'active' : ''} aria-pressed={sidePanel === 'toc'} onClick={(event) => toggleSidePanel('toc', event.currentTarget)}>目录</button>
          <button className={sidePanel === 'search' ? 'active' : ''} aria-pressed={sidePanel === 'search'} onClick={(event) => toggleSidePanel('search', event.currentTarget)}>书内搜索</button>
          <button className={sidePanel === 'marks' ? 'active' : ''} aria-pressed={sidePanel === 'marks'} disabled={offlineMode} title={offlineMode ? '离线状态下书签与高亮只读' : undefined} onClick={(event) => toggleSidePanel('marks', event.currentTarget)}>书签/高亮</button>
          <button className={sidePanel === 'speech' || speech.status === 'speaking' || speech.status === 'paused' ? 'active' : ''} aria-pressed={sidePanel === 'speech'} onClick={(event) => toggleSidePanel('speech', event.currentTarget)}>朗读</button>
        </div>
        <ScreenWakeLockControl onChromeActivity={onChromeActivity} />
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
          <button disabled={navigating} title="缩小字号（-）" aria-label="缩小字号" onClick={() => updateFontSize(-10)}>A−</button>
          <button disabled={navigating} className="reader-font-value" title="恢复默认字号" onClick={() => updateFontSize(100 - preferences.fontSize)}>{preferences.fontSize}%</button>
          <button disabled={navigating} title="放大字号（+）" aria-label="放大字号" onClick={() => updateFontSize(10)}>A＋</button>
          <button className={sidePanel === 'typography' ? 'active' : ''} aria-pressed={sidePanel === 'typography'} onClick={(event) => toggleSidePanel('typography', event.currentTarget)}>排版</button>
        </div>
        <span className="reader-toolbar-divider" />
        <div className="reader-tool-group" aria-label="阅读主题">
          <button className={preferences.theme === 'paper' ? 'active' : ''} aria-pressed={preferences.theme === 'paper'} onClick={() => setTheme('paper')}>日间</button>
          <button className={preferences.theme === 'sepia' ? 'active' : ''} aria-pressed={preferences.theme === 'sepia'} onClick={() => setTheme('sepia')}>护眼</button>
          <button className={preferences.theme === 'night' ? 'active' : ''} aria-pressed={preferences.theme === 'night'} onClick={() => setTheme('night')}>夜间</button>
        </div>
        <span className="reader-shortcuts">{preferences.flow === 'paged' ? '滚轮 / ← → 翻页 · + − 字号' : '滚轮连续阅读 · + − 字号'}</span>
      </div>

      {sidePanel === 'typography' ? (
        <EPUBTypographyPanel
          preferences={typography}
          onChange={changeTypography}
          onReset={() => changeTypography({ ...DEFAULT_EPUB_TYPOGRAPHY })}
          onClose={closeSidePanel}
          onChromeActivity={onChromeActivity}
        />
      ) : sidePanel === 'progress' ? (
        <aside className="reader-side-panel" aria-label="EPUB 进度跳转" onPointerDown={onChromeActivity} onFocusCapture={onChromeActivity}>
          <header><strong>跳转阅读进度</strong><button onClick={closeSidePanel} aria-label="关闭侧栏">×</button></header>
          <div className="epub-progress-preview">
            <p className="epub-settings-scope">当前进度 {progressLabel}。拖动只预览目标，确认后才跳转；可随时返回刚才位置。</p>
            <label><span>目标阅读进度</span><output>{previewProgress}%</output><input autoFocus aria-label="目标阅读进度" type="range" min="0" max="100" step="1" value={previewProgress} onChange={(event) => setPreviewProgress(Number(event.target.value))} /></label>
            <p className="epub-settings-scope">{locationsReady ? '百分比按正文位置估算，可能与纸书页数不同。' : '正在生成正文定位索引，完成后可跳转。'}</p>
            <button disabled={!locationsReady || navigating || reflowing} onClick={jumpToPreviewProgress}>确认跳转</button>
          </div>
        </aside>
      ) : sidePanel === 'speech' ? (
        <SpeechPanel
          controls={speech}
          sourceDescription={currentChapter.index >= 0 ? `当前第 ${currentChapter.index + 1} 章` : '当前 EPUB 章节'}
          onClose={closeSidePanel}
          onChromeActivity={onChromeActivity}
        />
      ) : sidePanel === 'marks' ? (
        !offlineMode && <ReadingMarksPanel
          bookFileID={book.id}
          current={markLocation}
          onNavigate={(position) => {
            const target = getReadingMarkNavigationTarget(book.format, position)
            if (target !== null) void displayLocation(target)
          }}
          onClose={closeSidePanel}
          onChromeActivity={onChromeActivity}
          onMarksChange={syncHighlights}
        />
      ) : sidePanel && (
        <aside className="reader-side-panel" aria-label={sidePanel === 'toc' ? 'EPUB 目录' : 'EPUB 书内搜索'} onPointerDown={onChromeActivity} onFocusCapture={onChromeActivity}>
          <header>
            <strong>{sidePanel === 'toc' ? '目录' : '书内搜索'}</strong>
            <button onClick={closeSidePanel} aria-label="关闭侧栏">×</button>
          </header>
          {sidePanel === 'toc' ? (
            <div className="reader-toc-list" ref={tocListRef}>
              {toc.length === 0 && <p className="reader-panel-empty">这本书没有可用目录。</p>}
              {toc.map((entry) => (
                <button key={entry.id} aria-label={entry.label} aria-current={currentTOCEntry?.id === entry.id ? 'location' : undefined} disabled={navigating || reflowing} style={{ paddingLeft: `${14 + entry.depth * 16}px` }} onClick={() => void displayLocation(entry.href)}>{entry.label}</button>
              ))}
            </div>
          ) : (
            <div className="reader-search-panel">
              <form onSubmit={(event) => void searchEPUB(event)}>
                <input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索正文" aria-label="搜索 EPUB 正文" />
                <button type="submit" disabled={searching || !searchQuery.trim()}>{searching ? '搜索中' : '搜索'}</button>
              </form>
              {(searchProgress || searchError) && <p className={searchError ? 'reader-panel-error' : 'reader-search-progress'}>{searchError || searchProgress}</p>}
              <div className="reader-search-results">
                {searchResults.map((result, index) => (
                  <button key={`${result.cfi}-${index}`} disabled={navigating || reflowing} onClick={() => void displayLocation(result.cfi)}>
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
      {(navigationError || reflowing) && <div className="epub-reader-feedback" role="status" aria-live="polite">{navigationError || '正在应用排版，保留当前阅读位置…'}</div>}
      <div className="epub-host" ref={hostRef} aria-busy={loading} />

      {!loading && !error && (
        <nav className={`epub-navigation${chromeVisible ? '' : ' is-hidden'}`} aria-label="EPUB 翻页" aria-hidden={!chromeVisible}>
          <button className="epub-history-button" disabled={!historyState.canBack || navigating || reflowing} onClick={() => navigateHistory('back')} aria-label="返回刚才位置" title="返回刚才位置">↶</button>
          <button disabled={atStart || navigating || reflowing} onClick={() => turnPage(-1)} aria-label="上一页" title={preferences.flow === 'paged' ? '上一页（←）' : '向上翻页'}>←</button>
          <button className="epub-progress-button" onClick={(event) => toggleSidePanel('progress', event.currentTarget)} aria-label="跳转阅读进度" title="预览并跳转阅读进度">{progressLabel}</button>
          <button disabled={atEnd || navigating || reflowing} onClick={() => turnPage(1)} aria-label="下一页" title={preferences.flow === 'paged' ? '下一页（→）' : '向下翻页'}>→</button>
          <button className="epub-history-button" disabled={!historyState.canForward || navigating || reflowing} onClick={() => navigateHistory('forward')} aria-label="前进到跳转位置" title="前进到跳转位置">↷</button>
        </nav>
      )}
    </div>
  )
}

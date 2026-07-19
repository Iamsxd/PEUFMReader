import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useReadingSession } from '../hooks/useReadingSession'
import type { BookFile, ReadingState } from '../types'
import { formatDuration } from '../utils'

const EPUBReader = lazy(() => import('./readers/EPUBReader').then((module) => ({ default: module.EPUBReader })))
const PDFReader = lazy(() => import('./readers/PDFReader').then((module) => ({ default: module.PDFReader })))

interface Props {
  book: BookFile
  onClose: () => void
}

export function Reader({ book, onClose }: Props) {
  const [state, setState] = useState<ReadingState | null>(null)
  const [error, setError] = useState('')
  const [pdfChromeVisible, setPDFChromeVisible] = useState(book.format === 'pdf')
  const pdfChromeTimerRef = useRef<number | null>(null)
  const isPDF = book.format === 'pdf'
  useReadingSession(book.id)

  const clearPDFChromeTimer = useCallback(() => {
    if (pdfChromeTimerRef.current !== null) {
      window.clearTimeout(pdfChromeTimerRef.current)
      pdfChromeTimerRef.current = null
    }
  }, [])

  const hidePDFChrome = useCallback(() => {
    clearPDFChromeTimer()
    setPDFChromeVisible(false)
  }, [clearPDFChromeTimer])

  const showPDFChrome = useCallback(() => {
    if (!isPDF) return
    clearPDFChromeTimer()
    setPDFChromeVisible(true)
    pdfChromeTimerRef.current = window.setTimeout(() => {
      pdfChromeTimerRef.current = null
      setPDFChromeVisible(false)
    }, 3500)
  }, [clearPDFChromeTimer, isPDF])

  useEffect(() => {
    void api.getProgress(book.id).then(setState).catch(() => setError('无法读取上次阅读位置。'))
  }, [book.id])

  useEffect(() => {
    if (!isPDF) {
      clearPDFChromeTimer()
      return
    }

    showPDFChrome()
    const handlePointerMove = (event: PointerEvent) => {
      if (event.clientY <= 120) showPDFChrome()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hidePDFChrome()
      else if (event.key === 'Tab') showPDFChrome()
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      clearPDFChromeTimer()
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [book.id, clearPDFChromeTimer, hidePDFChrome, isPDF, showPDFChrome])

  async function save(position: Record<string, unknown>, overallProgress: number) {
    const next = await api.saveProgress(book.id, {
      position,
      overallProgress,
      status: overallProgress >= 0.999 ? 'finished' : 'reading',
    })
    setState(next)
  }

  return (
    <main className={`reader-shell${isPDF ? ' pdf-reader-shell' : ''}`}>
      <header
        className={`reader-bar${isPDF ? ` pdf-reader-bar${pdfChromeVisible ? '' : ' is-hidden'}` : ''}`}
        aria-hidden={isPDF && !pdfChromeVisible}
        onPointerDown={isPDF ? showPDFChrome : undefined}
        onFocusCapture={isPDF ? showPDFChrome : undefined}
      >
        <button className="quiet" onClick={onClose}>← 返回书库</button>
        <div className="reader-title">
          <strong>{book.title}</strong>
          <span>{state ? `${Math.round(state.overallProgress * 100)}% · ${formatDuration(state.totalActiveSeconds)}` : '加载位置…'}</span>
        </div>
        <span className={`format-badge ${book.format}`}>{book.format.toUpperCase()}</span>
      </header>
      {isPDF && !pdfChromeVisible && (
        <button className="pdf-chrome-toggle" onClick={showPDFChrome} aria-label="显示 PDF 阅读工具" title="显示阅读工具">
          工具
        </button>
      )}
      {error && <div className="notice error">{error}</div>}
      <section className="reader-stage">
        <Suspense fallback={<div className="loading-page">正在加载阅读器…</div>}>
          {state && book.format === 'pdf' && (
            <PDFReader
              book={book}
              initialState={state}
              chromeVisible={pdfChromeVisible}
              onChromeActivity={showPDFChrome}
              onHideChrome={hidePDFChrome}
              onProgress={save}
            />
          )}
          {state && book.format === 'epub' && <EPUBReader book={book} initialState={state} onProgress={save} />}
        </Suspense>
      </section>
    </main>
  )
}

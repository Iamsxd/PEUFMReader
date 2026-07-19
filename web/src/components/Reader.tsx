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
  const [readerChromeVisible, setReaderChromeVisible] = useState(true)
  const readerChromeTimerRef = useRef<number | null>(null)
  const isImmersiveReader = book.format === 'pdf' || book.format === 'epub'
  useReadingSession(book.id)

  const clearReaderChromeTimer = useCallback(() => {
    if (readerChromeTimerRef.current !== null) {
      window.clearTimeout(readerChromeTimerRef.current)
      readerChromeTimerRef.current = null
    }
  }, [])

  const hideReaderChrome = useCallback(() => {
    clearReaderChromeTimer()
    setReaderChromeVisible(false)
  }, [clearReaderChromeTimer])

  const showReaderChrome = useCallback(() => {
    if (!isImmersiveReader) return
    clearReaderChromeTimer()
    setReaderChromeVisible(true)
    readerChromeTimerRef.current = window.setTimeout(() => {
      readerChromeTimerRef.current = null
      setReaderChromeVisible(false)
    }, 3500)
  }, [clearReaderChromeTimer, isImmersiveReader])

  useEffect(() => {
    void api.getProgress(book.id).then(setState).catch(() => setError('无法读取上次阅读位置。'))
  }, [book.id])

  useEffect(() => {
    if (!isImmersiveReader) {
      clearReaderChromeTimer()
      return
    }

    showReaderChrome()
    const handlePointerMove = (event: PointerEvent) => {
      if (event.clientY <= 120) showReaderChrome()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hideReaderChrome()
      else if (event.key === 'Tab') showReaderChrome()
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      clearReaderChromeTimer()
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [book.id, clearReaderChromeTimer, hideReaderChrome, isImmersiveReader, showReaderChrome])

  async function save(position: Record<string, unknown>, overallProgress: number) {
    const next = await api.saveProgress(book.id, {
      position,
      overallProgress,
      status: overallProgress >= 0.999 ? 'finished' : 'reading',
    })
    setState(next)
  }

  return (
    <main className={`reader-shell${isImmersiveReader ? ' immersive-reader-shell' : ''}`}>
      <header
        className={`reader-bar${isImmersiveReader ? ` immersive-reader-bar${readerChromeVisible ? '' : ' is-hidden'}` : ''}`}
        aria-hidden={isImmersiveReader && !readerChromeVisible}
        onPointerDown={isImmersiveReader ? showReaderChrome : undefined}
        onFocusCapture={isImmersiveReader ? showReaderChrome : undefined}
      >
        <button className="quiet" onClick={onClose}>← 返回书库</button>
        <div className="reader-title">
          <strong>{book.title}</strong>
          <span>{state ? `${Math.round(state.overallProgress * 100)}% · ${formatDuration(state.totalActiveSeconds)}` : '加载位置…'}</span>
        </div>
        <span className={`format-badge ${book.format}`}>{book.format.toUpperCase()}</span>
      </header>
      {isImmersiveReader && !readerChromeVisible && (
        <button className="reader-chrome-toggle" onClick={showReaderChrome} aria-label={`显示 ${book.format.toUpperCase()} 阅读工具`} title="显示阅读工具">
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
              chromeVisible={readerChromeVisible}
              onChromeActivity={showReaderChrome}
              onHideChrome={hideReaderChrome}
              onProgress={save}
            />
          )}
          {state && book.format === 'epub' && (
            <EPUBReader
              book={book}
              initialState={state}
              chromeVisible={readerChromeVisible}
              onChromeActivity={showReaderChrome}
              onHideChrome={hideReaderChrome}
              onProgress={save}
            />
          )}
        </Suspense>
      </section>
    </main>
  )
}

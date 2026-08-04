import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { APIError, api } from '../api'
import { useReadingSession } from '../hooks/useReadingSession'
import { getOfflineReadingState, offlineDefaultReadingState, rememberOfflineReadingState } from '../offline'
import type { BookFile, ReadingState } from '../types'
import { formatDuration } from '../utils'

const EPUBReader = lazy(() => import('./readers/EPUBReader').then((module) => ({ default: module.EPUBReader })))
const PDFReader = lazy(() => import('./readers/PDFReader').then((module) => ({ default: module.PDFReader })))

interface Props {
  book: BookFile
  contentData?: ArrayBuffer
  userID: number
  offlineMode: boolean
  onClose: () => void
}

export function Reader({ book, contentData, userID, offlineMode, onClose }: Props) {
  const [state, setState] = useState<ReadingState | null>(null)
  const [error, setError] = useState('')
  const [readerChromeVisible, setReaderChromeVisible] = useState(true)
  const readerChromeTimerRef = useRef<number | null>(null)
  const readerChromeVisibleRef = useRef(readerChromeVisible)
  const stateRef = useRef<ReadingState | null>(null)
  const isKindleBook = book.format === 'mobi' || book.format === 'azw3'
  const isImmersiveReader = book.format === 'pdf' || book.format === 'epub' || isKindleBook
  useReadingSession(book.id, offlineMode ? userID : undefined)
  stateRef.current = state
  readerChromeVisibleRef.current = readerChromeVisible

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

  const toggleReaderChrome = useCallback(() => {
    if (readerChromeVisibleRef.current) hideReaderChrome()
    else showReaderChrome()
  }, [hideReaderChrome, showReaderChrome])

  useEffect(() => {
    const localState = getOfflineReadingState(userID, book.id)
    if (offlineMode) {
      setState(localState ?? offlineDefaultReadingState(book.id))
      setError(localState ? '当前处于离线阅读，位置将在联网后同步。' : '当前处于离线阅读。')
      return
    }
    void api.getProgress(book.id).then((next) => {
      setState(next)
      rememberOfflineReadingState(userID, next, false)
      setError('')
    }).catch((reason) => {
      if (reason instanceof APIError && reason.status === 0 && localState) {
        setState(localState)
        setError('网络连接中断，正在使用此设备上的阅读位置。')
      } else {
        setError('无法读取上次阅读位置。')
      }
    })
  }, [book.id, offlineMode, userID])

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
    const previousStatus = stateRef.current?.status
    const input = {
      position,
      overallProgress,
      status: overallProgress >= 0.999
        ? 'finished'
        : previousStatus === 'finished' || previousStatus === 'abandoned'
          ? previousStatus
          : 'reading' as const,
    }
    if (offlineMode) {
      const next = { ...(stateRef.current ?? offlineDefaultReadingState(book.id)), ...input, bookFileId: book.id, updatedAt: new Date().toISOString() }
      rememberOfflineReadingState(userID, next, true)
      setState(next)
      return
    }
    try {
      const next = await api.saveProgress(book.id, input)
      rememberOfflineReadingState(userID, next, false)
      setState(next)
    } catch (reason) {
      if (!(reason instanceof APIError && reason.status === 0)) throw reason
      const next = { ...(stateRef.current ?? offlineDefaultReadingState(book.id)), ...input, bookFileId: book.id, updatedAt: new Date().toISOString() }
      rememberOfflineReadingState(userID, next, true)
      setState(next)
      setError('网络连接中断，阅读位置已暂存在此设备。')
    }
  }

  async function changeStatus(status: ReadingState['status']) {
    if (!state) return
    const input = {
      position: state.position,
      overallProgress: state.overallProgress,
      status,
    }
    if (offlineMode) {
      const next = { ...state, status, updatedAt: new Date().toISOString() }
      rememberOfflineReadingState(userID, next, true)
      setState(next)
      return
    }
    try {
      const next = await api.saveProgress(book.id, input)
      rememberOfflineReadingState(userID, next, false)
      setState(next)
      setError('')
    } catch {
      setError('无法更新阅读状态。')
    }
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
              contentURL={api.contentURL(book.id)}
              contentData={contentData}
              offlineMode={offlineMode}
              initialState={state}
              chromeVisible={readerChromeVisible}
              onChromeActivity={showReaderChrome}
              onHideChrome={hideReaderChrome}
              onToggleChrome={toggleReaderChrome}
              onProgress={save}
              readingStatus={state.status}
              onStatusChange={changeStatus}
            />
          )}
          {state && (book.format === 'epub' || isKindleBook) && (
            <EPUBReader
              book={book}
              contentURL={api.contentURL(book.id)}
              contentData={contentData}
              offlineMode={offlineMode}
              initialState={state}
              chromeVisible={readerChromeVisible}
              onChromeActivity={showReaderChrome}
              onHideChrome={hideReaderChrome}
              onToggleChrome={toggleReaderChrome}
              onProgress={save}
              readingStatus={state.status}
              onStatusChange={changeStatus}
            />
          )}
        </Suspense>
      </section>
    </main>
  )
}

import { lazy, Suspense, useEffect, useState } from 'react'
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
  useReadingSession(book.id)

  useEffect(() => {
    void api.getProgress(book.id).then(setState).catch(() => setError('无法读取上次阅读位置。'))
  }, [book.id])

  async function save(position: Record<string, unknown>, overallProgress: number) {
    const next = await api.saveProgress(book.id, {
      position,
      overallProgress,
      status: overallProgress >= 0.999 ? 'finished' : 'reading',
    })
    setState(next)
  }

  return (
    <main className="reader-shell">
      <header className="reader-bar">
        <button className="quiet" onClick={onClose}>← 返回书库</button>
        <div className="reader-title">
          <strong>{book.title}</strong>
          <span>{state ? `${Math.round(state.overallProgress * 100)}% · ${formatDuration(state.totalActiveSeconds)}` : '加载位置…'}</span>
        </div>
        <span className={`format-badge ${book.format}`}>{book.format.toUpperCase()}</span>
      </header>
      {error && <div className="notice error">{error}</div>}
      <section className="reader-stage">
        <Suspense fallback={<div className="loading-page">正在加载阅读器…</div>}>
          {state && book.format === 'pdf' && <PDFReader book={book} initialState={state} onProgress={save} />}
          {state && book.format === 'epub' && <EPUBReader book={book} initialState={state} onProgress={save} />}
        </Suspense>
      </section>
    </main>
  )
}

import { useEffect, useRef, useState } from 'react'
import ePub, { type Book, type Rendition } from 'epubjs'
import { api } from '../../api'
import type { BookFile, ReadingState } from '../../types'
import { clampProgress } from '../../utils'

interface Props {
  book: BookFile
  initialState: ReadingState
  onProgress: (position: Record<string, unknown>, progress: number) => Promise<void>
}

interface RelocatedLocation {
  start: { cfi: string; href?: string; percentage?: number }
}

export function EPUBReader({ book, initialState, onProgress }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const bookRef = useRef<Book | null>(null)
  const saveTimer = useRef<number | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.innerHTML = ''
    const epub = ePub(api.contentURL(book.id), { requestCredentials: true })
    const rendition = epub.renderTo(host, { width: '100%', height: '100%', flow: 'paginated', allowScriptedContent: false })
    bookRef.current = epub
    renditionRef.current = rendition

    rendition.themes.default({
      body: { color: '#19231d', background: '#f6f2e8', 'font-family': 'Literata, Georgia, serif', 'line-height': '1.65' },
      p: { 'max-width': '72ch' },
    })

    const initialCFI = typeof initialState.position.cfi === 'string' ? initialState.position.cfi : undefined
    void epub.ready.then(async () => {
      await epub.locations.generate(1600)
      await rendition.display(initialCFI)
    }).catch(() => setError('EPUB 加载失败。'))

    const relocated = (location: RelocatedLocation) => {
      const cfi = location.start.cfi
      let progress = location.start.percentage ?? 0
      try {
        progress = epub.locations.percentageFromCfi(cfi)
      } catch {
        // Some fixed-layout EPUBs do not expose generated locations.
      }
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        void onProgress({ cfi, href: location.start.href ?? '', progression: clampProgress(progress) }, clampProgress(progress)).catch(() => setError('阅读位置保存失败。'))
      }, 500)
    }
    rendition.on('relocated', relocated)

    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      rendition.off('relocated', relocated)
      rendition.destroy()
      epub.destroy()
      renditionRef.current = null
      bookRef.current = null
      host.innerHTML = ''
    }
  }, [book.id])

  return (
    <div className="epub-reader">
      {error && <div className="notice error">{error}</div>}
      <div className="page-controls">
        <button className="secondary" onClick={() => renditionRef.current?.prev()}>上一页</button>
        <span>EPUB 阅读器</span>
        <button className="secondary" onClick={() => renditionRef.current?.next()}>下一页</button>
      </div>
      <div className="epub-host" ref={hostRef} />
    </div>
  )
}

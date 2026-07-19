import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerURL from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { api } from '../../api'
import { describePDFError, fetchPDFBytes } from '../../pdf'
import type { BookFile, ReadingState } from '../../types'
import { clampProgress } from '../../utils'

pdfjs.GlobalWorkerOptions.workerSrc = workerURL

interface Props {
  book: BookFile
  initialState: ReadingState
  onProgress: (position: Record<string, unknown>, progress: number) => Promise<void>
}

export function PDFReader({ book, initialState, onProgress }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const documentRef = useRef<pdfjs.PDFDocumentProxy | null>(null)
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null)
  const loadingTaskRef = useRef<pdfjs.PDFDocumentLoadingTask | null>(null)
  const initialPage = typeof initialState.position.pageIndex === 'number' ? Number(initialState.position.pageIndex) + 1 : 1
  const [pageNumber, setPageNumber] = useState(Math.max(1, initialPage))
  const [pageCount, setPageCount] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    let disposed = false
    const controller = new AbortController()
    setError('')

    void fetchPDFBytes(api.contentURL(book.id), controller.signal).then((bytes) => {
      if (disposed) return null
      const task = pdfjs.getDocument({ data: bytes })
      loadingTaskRef.current = task
      return task.promise
    }).then((document) => {
      if (!document || disposed) return
      documentRef.current = document
      setPageCount(document.numPages)
      setPageNumber((current) => Math.min(current, document.numPages))
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      console.error('PDF loading failed', reason)
      setError(describePDFError(reason))
    })
    return () => {
      disposed = true
      controller.abort()
      renderTaskRef.current?.cancel()
      void loadingTaskRef.current?.destroy()
      loadingTaskRef.current = null
      documentRef.current = null
    }
  }, [book.id])

  useEffect(() => {
    const document = documentRef.current
    const canvas = canvasRef.current
    if (!document || !canvas || pageCount === 0) return
    let disposed = false
    void document.getPage(pageNumber).then((page) => {
      if (disposed) return
      const baseViewport = page.getViewport({ scale: 1 })
      const available = Math.min(window.innerWidth - 32, 1100)
      const scale = Math.max(0.5, Math.min(2.2, available / baseViewport.width))
      const viewport = page.getViewport({ scale })
      const context = canvas.getContext('2d')
      if (!context) return
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      renderTaskRef.current?.cancel()
      const task = page.render({ canvas, canvasContext: context, viewport })
      renderTaskRef.current = task
      void task.promise.catch((reason: unknown) => {
        if (!(reason instanceof Error && reason.name === 'RenderingCancelledException')) setError('PDF 页面渲染失败。')
      })
    })
    return () => {
      disposed = true
      renderTaskRef.current?.cancel()
    }
  }, [pageNumber, pageCount])

  useEffect(() => {
    if (pageCount === 0) return
    const timer = window.setTimeout(() => {
      void onProgress({ pageIndex: pageNumber - 1, yRatio: 0 }, clampProgress(pageNumber / pageCount)).catch(() => setError('阅读位置保存失败。'))
    }, 500)
    return () => window.clearTimeout(timer)
  }, [pageNumber, pageCount])

  return (
    <div className="pdf-reader">
      {error && <div className="notice error">{error}</div>}
      <div className="page-controls">
        <button className="secondary" disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => page - 1)}>上一页</button>
        <label>第 <input type="number" min={1} max={pageCount || 1} value={pageNumber} onChange={(event) => setPageNumber(Math.max(1, Math.min(pageCount || 1, Number(event.target.value))))} /> / {pageCount || '…'} 页</label>
        <button className="secondary" disabled={pageCount === 0 || pageNumber >= pageCount} onClick={() => setPageNumber((page) => page + 1)}>下一页</button>
      </div>
      <div className="pdf-canvas-wrap"><canvas ref={canvasRef} /></div>
    </div>
  )
}

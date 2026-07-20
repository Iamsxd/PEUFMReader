import { useEffect, useRef, useState } from 'react'
import type * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

interface Props {
  document: pdfjs.PDFDocumentProxy
  pageNumber: number
  scale: number
  lazy: boolean
  observerRoot: Element | null
  fallbackSize: { width: number; height: number }
  onVisibilityChange: (pageNumber: number, ratio: number) => void
  onRenderError: (message: string) => void
}

export function PDFPageCanvas({
  document,
  pageNumber,
  scale,
  lazy,
  observerRoot,
  fallbackSize,
  onVisibilityChange,
  onRenderError,
}: Props) {
  const shellRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null)
  const [isNearViewport, setIsNearViewport] = useState(!lazy)
  const [rendered, setRendered] = useState(false)
  const [pageSize, setPageSize] = useState(fallbackSize)

  useEffect(() => {
    if (!lazy) {
      setIsNearViewport(true)
      return
    }
    const shell = shellRef.current
    if (!shell) return
    const observer = new IntersectionObserver(([entry]) => {
      setIsNearViewport(entry.isIntersecting)
    }, { root: observerRoot, rootMargin: '1500px 0px' })
    observer.observe(shell)
    return () => observer.disconnect()
  }, [lazy, observerRoot])

  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    const observer = new IntersectionObserver(([entry]) => {
      onVisibilityChange(pageNumber, entry.isIntersecting ? entry.intersectionRatio : 0)
    }, { root: observerRoot, threshold: [0, 0.1, 0.25, 0.5, 0.75] })
    observer.observe(shell)
    return () => {
      onVisibilityChange(pageNumber, 0)
      observer.disconnect()
    }
  }, [observerRoot, onVisibilityChange, pageNumber])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !isNearViewport) {
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
      setRendered(false)
      if (canvas) {
        canvas.width = 1
        canvas.height = 1
      }
      return
    }

    let disposed = false
    setRendered(false)
    void document.getPage(pageNumber).then((page) => {
      if (disposed) return
      const baseViewport = page.getViewport({ scale: 1 })
      setPageSize({ width: baseViewport.width, height: baseViewport.height })
      const viewport = page.getViewport({ scale })
      const pixelRatio = Math.min(window.devicePixelRatio || 1, Math.max(1, 2 / scale))
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('浏览器无法创建 PDF 画布。')

      canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio))
      canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio))
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`

      renderTaskRef.current?.cancel()
      const task = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      })
      renderTaskRef.current = task
      return task.promise
    }).then(() => {
      if (!disposed) setRendered(true)
    }).catch((reason: unknown) => {
      if (reason instanceof Error && reason.name === 'RenderingCancelledException') return
      onRenderError(reason instanceof Error ? reason.message : String(reason))
    })

    return () => {
      disposed = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
    }
  }, [document, isNearViewport, onRenderError, pageNumber, scale])

  const width = pageSize.width * scale
  const height = pageSize.height * scale
  return (
    <div
      ref={shellRef}
      className={`pdf-page-shell${rendered ? ' rendered' : ''}`}
      data-pdf-page={pageNumber}
      style={{ width, height }}
      aria-label={`第 ${pageNumber} 页`}
    >
      {!rendered && <span className="pdf-page-placeholder">第 {pageNumber} 页</span>}
      <canvas ref={canvasRef} className="pdf-page-canvas" />
      <span className="pdf-page-number">{pageNumber}</span>
    </div>
  )
}

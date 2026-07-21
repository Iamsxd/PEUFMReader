import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { ReadingMark } from '../../types'

interface Props {
  document: pdfjs.PDFDocumentProxy
  pageNumber: number
  scale: number
  lazy: boolean
  observerRoot: Element | null
  fallbackSize: { width: number; height: number }
  onVisibilityChange: (pageNumber: number, ratio: number) => void
  onRenderError: (message: string) => void
  highlights: ReadingMark[]
  onTextSelection: (pageNumber: number, pageBounds: DOMRect, selectionRects: DOMRect[], quote: string) => void
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
  highlights,
  onTextSelection,
}: Props) {
  const shellRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const textLayerTaskRef = useRef<pdfjs.TextLayer | null>(null)
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
    const textLayerHost = textLayerRef.current
    if (!canvas || !isNearViewport) {
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
      setRendered(false)
      if (canvas) {
        canvas.width = 1
        canvas.height = 1
      }
      textLayerTaskRef.current?.cancel()
      textLayerTaskRef.current = null
      if (textLayerHost) textLayerHost.replaceChildren()
      return
    }

    let disposed = false
    setRendered(false)
    void document.getPage(pageNumber).then(async (page) => {
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
      const textContent = textLayerHost ? await page.getTextContent() : null
      if (disposed) return
      if (textLayerHost && textContent) {
        textLayerHost.replaceChildren()
        textLayerTaskRef.current?.cancel()
        const textLayer = new pdfjs.TextLayer({ textContentSource: textContent, container: textLayerHost, viewport })
        textLayerTaskRef.current = textLayer
        await Promise.all([task.promise, textLayer.render()])
      } else {
        await task.promise
      }
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
      textLayerTaskRef.current?.cancel()
      textLayerTaskRef.current = null
    }
  }, [document, isNearViewport, onRenderError, pageNumber, scale])

  const width = pageSize.width * scale
  const height = pageSize.height * scale

  function handlePointerUp() {
    const shell = shellRef.current
    const textLayer = textLayerRef.current
    const selection = window.getSelection()
    if (!shell || !textLayer || !selection || selection.isCollapsed || selection.rangeCount === 0) return
    if (!selection.anchorNode || !selection.focusNode || !textLayer.contains(selection.anchorNode) || !textLayer.contains(selection.focusNode)) return
    const quote = selection.toString().replace(/\s+/g, ' ').trim()
    if (!quote) return
    const rects = Array.from(selection.getRangeAt(0).getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0)
    if (rects.length === 0) return
    onTextSelection(pageNumber, shell.getBoundingClientRect(), rects, quote)
  }

  return (
    <div
      ref={shellRef}
      className={`pdf-page-shell${rendered ? ' rendered' : ''}`}
      data-pdf-page={pageNumber}
      style={{ width, height }}
      aria-label={`第 ${pageNumber} 页`}
      onPointerUp={handlePointerUp}
    >
      {!rendered && <span className="pdf-page-placeholder">第 {pageNumber} 页</span>}
      <canvas ref={canvasRef} className="pdf-page-canvas" />
      <div className="pdf-highlight-layer" aria-hidden="true">
        {highlights.flatMap((mark) => {
          const rects = Array.isArray(mark.position.rects) ? mark.position.rects : []
          return rects.map((rect, index) => {
            if (!rect || typeof rect !== 'object') return null
            const value = rect as Record<string, unknown>
            if (![value.x, value.y, value.width, value.height].every((item) => typeof item === 'number')) return null
            return <span key={`${mark.id}-${index}`} className={`pdf-highlight ${mark.color}`} style={{ left: `${Number(value.x) * 100}%`, top: `${Number(value.y) * 100}%`, width: `${Number(value.width) * 100}%`, height: `${Number(value.height) * 100}%` }} />
          })
        })}
      </div>
      <div ref={textLayerRef} className="pdf-text-layer textLayer" />
      <span className="pdf-page-number">{pageNumber}</span>
    </div>
  )
}

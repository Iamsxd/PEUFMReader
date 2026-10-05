import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { ReadingMark } from '../../types'
import { isPDFRenderingCancellation } from '../../pdf'
import { fullPDFPageBounds, type PDFCrop } from '../../pdfCrop'

interface Props {
  document: pdfjs.PDFDocumentProxy
  pageNumber: number
  scale: number
  crop: PDFCrop
  lazy: boolean
  observerRoot: Element | null
  fallbackSize: { width: number; height: number }
  onVisibilityChange: (pageNumber: number, ratio: number) => void
  onGeometryReady: (pageNumber: number) => void
  onRenderError: (message: string) => void
  onTextLayerError: (pageNumber: number, message: string) => void
  highlights: ReadingMark[]
  onTextSelection: (pageNumber: number, pageBounds: DOMRect, selectionRects: DOMRect[], quote: string) => void
  onHighlightClick: (markID: number) => void
}

export function PDFPageCanvas({
  document,
  pageNumber,
  scale,
  crop,
  lazy,
  observerRoot,
  fallbackSize,
  onVisibilityChange,
  onGeometryReady,
  onRenderError,
  onTextLayerError,
  highlights,
  onTextSelection,
  onHighlightClick,
}: Props) {
  const shellRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const textLayerTaskRef = useRef<pdfjs.TextLayer | null>(null)
  const [isNearViewport, setIsNearViewport] = useState(!lazy)
  const [rendered, setRendered] = useState(false)
  const [pageSize, setPageSize] = useState(fallbackSize)
  const [geometryReady, setGeometryReady] = useState(false)
  const lastSelectionRef = useRef('')

  useLayoutEffect(() => {
    if (geometryReady) onGeometryReady(pageNumber)
  }, [geometryReady, onGeometryReady, pageNumber, pageSize, scale, crop])

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
      setGeometryReady(true)
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
      let textLayerPromise: Promise<unknown> = Promise.resolve()
      if (textLayerHost) {
        textLayerHost.replaceChildren()
        textLayerTaskRef.current?.cancel()
        try {
          const textLayer = new pdfjs.TextLayer({
            textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
            container: textLayerHost,
            viewport,
          })
          textLayerTaskRef.current = textLayer
          textLayerPromise = textLayer.render().catch((reason: unknown) => {
            if (disposed || isPDFRenderingCancellation(reason)) return
            textLayerHost.replaceChildren()
            onTextLayerError(pageNumber, reason instanceof Error ? reason.message : String(reason))
          })
        } catch (reason) {
          if (!isPDFRenderingCancellation(reason)) {
            textLayerHost.replaceChildren()
            onTextLayerError(pageNumber, reason instanceof Error ? reason.message : String(reason))
          }
        }
      }

      await task.promise
      if (!disposed) setRendered(true)
      await textLayerPromise
    }).catch((reason: unknown) => {
      if (isPDFRenderingCancellation(reason)) return
      onRenderError(reason instanceof Error ? reason.message : String(reason))
    })

    return () => {
      disposed = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
      textLayerTaskRef.current?.cancel()
      textLayerTaskRef.current = null
    }
  }, [document, isNearViewport, onRenderError, onTextLayerError, pageNumber, scale])

  const width = pageSize.width * scale
  const height = pageSize.height * scale

  function handlePointerUp() {
    const shell = shellRef.current
    const textLayer = textLayerRef.current
    const selection = window.getSelection()
    if (!shell || !textLayer || !selection || selection.isCollapsed || selection.rangeCount === 0) return
    if (!selection.anchorNode || !selection.focusNode) return
    const elementFor = (node: Node) => node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
    const anchorLayer = elementFor(selection.anchorNode)?.closest('.pdf-text-layer')
    const focusLayer = elementFor(selection.focusNode)?.closest('.pdf-text-layer')
    const pages = shell.closest('.pdf-pages')
    if (!anchorLayer || !focusLayer || !pages?.contains(anchorLayer) || !pages.contains(focusLayer)) return
    if (!textLayer.contains(selection.anchorNode)) return
    const quote = selection.toString().replace(/\s+/g, ' ').trim()
    if (!quote) return
    const rects = Array.from(selection.getRangeAt(0).getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0)
    if (rects.length === 0) return
    const signature = `${quote}:${rects[0].left}:${rects[0].top}:${rects.length}`
    if (lastSelectionRef.current === signature) return
    lastSelectionRef.current = signature
    onTextSelection(pageNumber, fullPDFPageBounds(shell), rects, quote)
  }

  useEffect(() => {
    if (!isNearViewport) return
    let timer: number | undefined
    const onChange = () => {
      window.clearTimeout(timer)
      if (window.getSelection()?.isCollapsed) { lastSelectionRef.current = ''; return }
      timer = window.setTimeout(handlePointerUp, 250)
    }
    window.document.addEventListener('selectionchange', onChange)
    return () => { window.clearTimeout(timer); window.document.removeEventListener('selectionchange', onChange) }
  }, [isNearViewport, pageNumber, onTextSelection])

  function highlightAt(clientX: number, clientY: number) {
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return undefined
    const bounds = shellRef.current ? fullPDFPageBounds(shellRef.current) : null
    if (!bounds) return undefined
    const x = (clientX - bounds.left) / bounds.width
    const y = (clientY - bounds.top) / bounds.height
    return highlights.find(mark => Array.isArray(mark.position.rects) && mark.position.rects.some((raw: unknown) => {
      if (!raw || typeof raw !== 'object') return false
      const rect = raw as Record<string, number>
      return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
    }))
  }

  return (
    <div
      ref={shellRef}
      className={`pdf-page-shell${rendered ? ' rendered' : ''}`}
      data-pdf-page={pageNumber}
      data-geometry-ready={geometryReady ? 'true' : 'false'}
      style={{ width: width * (1 - crop.left - crop.right), height: height * (1 - crop.top - crop.bottom) }}
      aria-label={`第 ${pageNumber} 页`}
      onPointerUp={event => {
        handlePointerUp()
        // The viewport toggles its toolbar on pointer-up. Prevent that layout
        // change before the ensuing click hit-tests the saved highlight.
        if (highlightAt(event.clientX, event.clientY)) event.stopPropagation()
      }}
      onClick={event => {
        const selected = highlightAt(event.clientX, event.clientY)
        if (selected) { event.stopPropagation(); onHighlightClick(selected.id) }
      }}
    >
      {!rendered && <span className="pdf-page-placeholder">第 {pageNumber} 页</span>}
      <div className="pdf-page-content" style={{ position: 'absolute', width, height, left: -width * crop.left, top: -height * crop.top }}>
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
      </div>
      <span className="pdf-page-number">{pageNumber}</span>
    </div>
  )
}

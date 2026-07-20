export class PDFContentError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message)
    this.name = 'PDFContentError'
  }
}

export type PDFPageFlow = 'paged' | 'continuous'
export type PDFPageLayout = 'single' | 'spread'
export type PDFZoomMode = 'fit-width' | 'fit-page' | 'custom'

export interface PDFReaderPreferences {
  flow: PDFPageFlow
  layout: PDFPageLayout
  zoomMode: PDFZoomMode
  zoomPercent: number
}

export const PDF_PREFERENCES_KEY = 'peufmreader.pdf.preferences.v1'
export const DEFAULT_PDF_PREFERENCES: PDFReaderPreferences = {
  flow: 'paged',
  layout: 'single',
  zoomMode: 'fit-width',
  zoomPercent: 100,
}

export function getPDFJSAssetOptions(baseURL: string) {
  const normalizedBase = baseURL.endsWith('/') ? baseURL : `${baseURL}/`
  const pdfJSRoot = `${normalizedBase}pdfjs/`
  return {
    cMapUrl: `${pdfJSRoot}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${pdfJSRoot}standard_fonts/`,
    wasmUrl: `${pdfJSRoot}wasm/`,
  } as const
}

export function clampPDFPage(page: number, pageCount: number): number {
  if (pageCount < 1) return 1
  return Math.min(pageCount, Math.max(1, Math.round(Number.isFinite(page) ? page : 1)))
}

export function getPDFViewPages(page: number, pageCount: number, layout: PDFPageLayout): number[] {
  const current = clampPDFPage(page, pageCount)
  if (pageCount < 1) return []
  if (layout === 'single' || current === 1) return [current]
  const spreadStart = current % 2 === 0 ? current : current - 1
  return [spreadStart, spreadStart + 1].filter((candidate) => candidate <= pageCount)
}

export function movePDFPage(
  page: number,
  pageCount: number,
  layout: PDFPageLayout,
  direction: -1 | 1,
): number {
  const current = clampPDFPage(page, pageCount)
  if (layout === 'single') return clampPDFPage(current + direction, pageCount)
  const spreadStart = current === 1 ? 1 : current % 2 === 0 ? current : current - 1
  if (direction > 0) {
    const nextSpread = spreadStart === 1 ? 2 : spreadStart + 2
    return nextSpread > pageCount ? spreadStart : nextSpread
  }
  return clampPDFPage(spreadStart <= 2 ? 1 : spreadStart - 2, pageCount)
}

export function clampPDFZoom(zoomPercent: number): number {
  return Math.min(300, Math.max(40, Math.round(Number.isFinite(zoomPercent) ? zoomPercent : 100)))
}

interface PDFScaleOptions {
  zoomMode: PDFZoomMode
  zoomPercent: number
  pageWidth: number
  pageHeight: number
  containerWidth: number
  availableHeight: number
  layout: PDFPageLayout
}

export function calculatePDFScale({
  zoomMode,
  zoomPercent,
  pageWidth,
  pageHeight,
  containerWidth,
  availableHeight,
  layout,
}: PDFScaleOptions): number {
  if (pageWidth <= 0 || pageHeight <= 0) return 1
  const horizontalPadding = 48
  const spreadGap = layout === 'spread' ? 18 : 0
  const pageSlots = layout === 'spread' ? 2 : 1
  const pageSlotWidth = Math.max(160, (containerWidth - horizontalPadding - spreadGap) / pageSlots)
  const widthScale = pageSlotWidth / pageWidth
  const heightScale = Math.max(0.35, (availableHeight - 32) / pageHeight)
  const scale = zoomMode === 'custom'
    ? clampPDFZoom(zoomPercent) / 100
    : zoomMode === 'fit-page'
      ? Math.min(widthScale, heightScale)
      : widthScale
  return Math.min(3, Math.max(0.35, scale))
}

export function parsePDFPreferences(value: string | null): PDFReaderPreferences {
  if (!value) return { ...DEFAULT_PDF_PREFERENCES }
  try {
    const parsed = JSON.parse(value) as Partial<PDFReaderPreferences>
    return {
      flow: parsed.flow === 'continuous' ? 'continuous' : 'paged',
      layout: parsed.layout === 'spread' ? 'spread' : 'single',
      zoomMode: parsed.zoomMode === 'fit-page' || parsed.zoomMode === 'custom' ? parsed.zoomMode : 'fit-width',
      zoomPercent: clampPDFZoom(typeof parsed.zoomPercent === 'number' ? parsed.zoomPercent : 100),
    }
  } catch {
    return { ...DEFAULT_PDF_PREFERENCES }
  }
}

export async function fetchPDFBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/pdf' },
    signal,
  })
  if (!response.ok) {
    throw new PDFContentError(`PDF 文件请求失败（HTTP ${response.status}）。`, response.status)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
    throw new PDFContentError('服务器返回的内容不是有效 PDF。')
  }
  return bytes
}

export function describePDFError(reason: unknown): string {
  if (reason instanceof PDFContentError) return reason.message
  if (reason instanceof Error) {
    switch (reason.name) {
      case 'PasswordException':
        return '该 PDF 受密码保护，当前版本无法打开。'
      case 'InvalidPDFException':
        return 'PDF 文件结构无效或不完整。'
      case 'MissingPDFException':
        return '服务器上的 PDF 文件不存在。'
      case 'UnexpectedResponseException':
        return 'PDF 文件请求返回了异常响应。'
    }
    const detail = `${reason.name || 'Error'}: ${reason.message || '未知错误'}`.replace(/\s+/g, ' ').slice(0, 240)
    return `PDF 加载失败（${detail}）。`
  }
  return `PDF 加载失败（${String(reason).replace(/\s+/g, ' ').slice(0, 240)}）。`
}

export function createPDFSearchSnippet(text: string, query: string, radius = 48): string {
  const normalizedText = text.replace(/\s+/g, ' ').trim()
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedText || !normalizedQuery) return ''
  const index = normalizedText.toLocaleLowerCase().indexOf(normalizedQuery)
  if (index < 0) return ''
  const start = Math.max(0, index - radius)
  const end = Math.min(normalizedText.length, index + query.trim().length + radius)
  return `${start > 0 ? '…' : ''}${normalizedText.slice(start, end)}${end < normalizedText.length ? '…' : ''}`
}

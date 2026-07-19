import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  calculatePDFScale,
  describePDFError,
  fetchPDFBytes,
  getPDFViewPages,
  movePDFPage,
  parsePDFPreferences,
  PDFContentError,
} from './pdf'

describe('PDF reading model', () => {
  it('keeps the cover alone and creates conventional two-page spreads', () => {
    expect(getPDFViewPages(1, 8, 'spread')).toEqual([1])
    expect(getPDFViewPages(2, 8, 'spread')).toEqual([2, 3])
    expect(getPDFViewPages(3, 8, 'spread')).toEqual([2, 3])
    expect(getPDFViewPages(8, 8, 'spread')).toEqual([8])
  })

  it('moves between spreads without skipping the cover', () => {
    expect(movePDFPage(1, 8, 'spread', 1)).toBe(2)
    expect(movePDFPage(2, 8, 'spread', 1)).toBe(4)
    expect(movePDFPage(4, 8, 'spread', -1)).toBe(2)
    expect(movePDFPage(2, 8, 'spread', -1)).toBe(1)
    expect(movePDFPage(6, 7, 'spread', 1)).toBe(6)
  })

  it('calculates fit-width, fit-page and custom zoom scales', () => {
    const base = { pageWidth: 600, pageHeight: 800, containerWidth: 1248, availableHeight: 832, layout: 'single' as const }
    expect(calculatePDFScale({ ...base, zoomMode: 'fit-width', zoomPercent: 100 })).toBe(2)
    expect(calculatePDFScale({ ...base, zoomMode: 'fit-page', zoomPercent: 100 })).toBe(1)
    expect(calculatePDFScale({ ...base, zoomMode: 'custom', zoomPercent: 150 })).toBe(1.5)
    expect(calculatePDFScale({ ...base, layout: 'spread', zoomMode: 'fit-width', zoomPercent: 100 })).toBeCloseTo(0.985)
  })

  it('sanitizes persisted reader preferences', () => {
    expect(parsePDFPreferences('{"flow":"continuous","layout":"spread","zoomMode":"custom","zoomPercent":900}')).toEqual({
      flow: 'continuous',
      layout: 'spread',
      zoomMode: 'custom',
      zoomPercent: 300,
    })
    expect(parsePDFPreferences('not-json')).toEqual({ flow: 'paged', layout: 'single', zoomMode: 'fit-width', zoomPercent: 100 })
  })
})

describe('fetchPDFBytes', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns authenticated PDF bytes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new TextEncoder().encode('%PDF-1.7\nbody'), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchPDFBytes('/api/v1/book-files/1/content')

    expect(new TextDecoder().decode(result)).toContain('%PDF-1.7')
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/book-files/1/content', expect.objectContaining({
      credentials: 'include',
      headers: { Accept: 'application/pdf' },
    }))
  })

  it('reports authentication and server errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 })))
    await expect(fetchPDFBytes('/content')).rejects.toMatchObject({ status: 401 })
  })

  it('rejects a successful non-PDF response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>login</html>', { status: 200 })))
    await expect(fetchPDFBytes('/content')).rejects.toThrow('不是有效 PDF')
  })
})

describe('describePDFError', () => {
  it('keeps actionable content errors', () => {
    expect(describePDFError(new PDFContentError('PDF 文件请求失败（HTTP 401）。', 401))).toContain('401')
  })

  it('maps PDF.js parser errors', () => {
    const error = new Error('invalid')
    error.name = 'InvalidPDFException'
    expect(describePDFError(error)).toContain('结构无效')
  })

  it('shows unknown error details for diagnosis', () => {
    expect(describePDFError(new TypeError('worker startup failed'))).toContain('TypeError: worker startup failed')
  })
})

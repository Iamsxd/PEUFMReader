import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  calculatePDFScale,
  calculatePDFAnchorScrollTop,
  calculatePDFPageScrollLeft,
  calculatePDFYRatio,
  clampPDFYRatio,
  createPDFSearchSnippet,
  describePDFError,
  fetchPDFBytes,
  getPDFJSAssetOptions,
  getPDFViewPages,
  getPDFReadingAnchor,
  isPDFRenderingCancellation,
  movePDFPage,
  normalizePDFWheelDelta,
  parsePDFPreferences,
  PDFContentError,
} from './pdf'

describe('PDF reading model', () => {
  it('restores page-only records and sanitizes normalized anchors', () => {
    expect(getPDFReadingAnchor({ pageIndex: 4 }, 20)).toEqual({ page: 5, yRatio: 0 })
    expect(getPDFReadingAnchor({ pageIndex: 40, yRatio: .65 }, 20)).toEqual({ page: 20, yRatio: .65 })
    expect(getPDFReadingAnchor({ pageIndex: -2, yRatio: 4 }, 20)).toEqual({ page: 1, yRatio: 1 })
    expect(getPDFReadingAnchor({ pageIndex: Number.NaN, yRatio: '0.5' }, 20)).toEqual({ page: 1, yRatio: 0 })
    expect(clampPDFYRatio(Number.POSITIVE_INFINITY)).toBe(0)
    expect(clampPDFYRatio(-.3)).toBe(0)
  })

  it('locates the first valid highlight rectangle without changing old marks', () => {
    const position = { pageIndex: 2, rects: [null, { x: 0, y: -.1, width: .2, height: .03 }, { x: .1, y: .7, width: .3, height: .02 }] }
    expect(getPDFReadingAnchor(position, 10)).toEqual({ page: 3, yRatio: .7 })
    expect(getPDFReadingAnchor({ pageIndex: 2, yRatio: .4, rects: [{ x: 0, y: .8, width: 0, height: .02 }] }, 10)).toEqual({ page: 3, yRatio: .4 })
  })

  it('preserves the same page point when the PDF scale changes', () => {
    const ratio = calculatePDFYRatio(-976, 2000, 0)
    expect(ratio).toBe(.5)
    expect(calculatePDFAnchorScrollTop(1000, 0, -976, 3000, ratio)).toBe(1500)
    expect(calculatePDFYRatio(-1476, 3000, 0)).toBe(ratio)
    expect(calculatePDFYRatio(50, 0, 0)).toBe(0)
    expect(calculatePDFAnchorScrollTop(0, 0, 24, 2000, 0)).toBe(0)
    expect(calculatePDFAnchorScrollTop(20, 0, 24, 0, .5)).toBe(20)
  })

  it('reveals a zoomed right-hand spread page before committing its position', () => {
    expect(calculatePDFPageScrollLeft(0, 0, 1024, 1242, 1200)).toBe(1218)
    // A partly visible oversized page also moves into its own reading area.
    expect(calculatePDFPageScrollLeft(700, 0, 1024, 542, 1200)).toBe(1218)
  })

  it('reveals the nearest edge of a target that fits within the viewport', () => {
    expect(calculatePDFPageScrollLeft(300, 0, 1000, -100, 600)).toBe(176)
    expect(calculatePDFPageScrollLeft(0, 0, 1000, 700, 400)).toBe(124)
    expect(calculatePDFPageScrollLeft(40, 100, 1000, 800, 400)).toBe(164)
  })

  it('preserves horizontal pan when the target already occupies the reading area', () => {
    expect(calculatePDFPageScrollLeft(300, 0, 1000, 100, 600)).toBe(300)
    expect(calculatePDFPageScrollLeft(300, 0, 1000, -276, 1600)).toBe(300)
    // Return from a right page to its oversized left peer, aligning near edge.
    expect(calculatePDFPageScrollLeft(1250, 0, 1024, -1200, 1200)).toBe(250)
  })

  it('bounds horizontal restoration without changing vertical anchor semantics', () => {
    expect(calculatePDFPageScrollLeft(0, 0, 1000, -100, 600)).toBe(0)
    expect(calculatePDFPageScrollLeft(30, 0, 0, 100, 600)).toBe(30)
    expect(calculatePDFPageScrollLeft(30, 0, 1000, 100, NaN)).toBe(30)
    expect(calculatePDFPageScrollLeft(Infinity, 0, 1000, 100, 600)).toBe(0)
    expect(calculatePDFYRatio(-976, 2000, 0)).toBe(.5)
  })

  it('points PDF.js at the bundled decoder and font assets', () => {
    expect(getPDFJSAssetOptions('/reader')).toEqual({
      cMapUrl: '/reader/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/reader/pdfjs/standard_fonts/',
      wasmUrl: '/reader/pdfjs/wasm/',
    })
  })

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

  it('normalizes Ctrl-wheel zoom deltas from pixels, lines and pages', () => {
    expect(normalizePDFWheelDelta(-100, 0, 900)).toBe(-100)
    expect(normalizePDFWheelDelta(3, 1, 900)).toBe(48)
    expect(normalizePDFWheelDelta(-1, 2, 900)).toBe(-900)
    expect(normalizePDFWheelDelta(Number.NaN, 0, 900)).toBe(0)
  })

  it('recognizes expected PDF rendering cancellations', () => {
    const renderCancellation = new Error('cancelled')
    renderCancellation.name = 'RenderingCancelledException'
    const textCancellation = new Error('aborted')
    textCancellation.name = 'AbortException'

    expect(isPDFRenderingCancellation(renderCancellation)).toBe(true)
    expect(isPDFRenderingCancellation(textCancellation)).toBe(true)
    expect(isPDFRenderingCancellation(new TypeError('render failed'))).toBe(false)
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

  it('creates compact, whitespace-normalized search snippets', () => {
    expect(createPDFSearchSnippet('前文   关键字\n后文', '关键字')).toBe('前文 关键字 后文')
    expect(createPDFSearchSnippet('没有匹配内容', '目标')).toBe('')
    expect(createPDFSearchSnippet(`${'前'.repeat(60)}目标${'后'.repeat(60)}`, '目标', 10)).toBe(`…${'前'.repeat(10)}目标${'后'.repeat(10)}…`)
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

    const progress = vi.fn()
    const result = await fetchPDFBytes('/api/v1/book-files/1/content', undefined, progress)

    expect(new TextDecoder().decode(result)).toContain('%PDF-1.7')
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/book-files/1/content', expect.objectContaining({
      credentials: 'include',
      headers: { Accept: 'application/pdf' },
    }))
    expect(progress).toHaveBeenCalled()
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

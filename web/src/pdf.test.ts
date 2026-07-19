import { afterEach, describe, expect, it, vi } from 'vitest'
import { describePDFError, fetchPDFBytes, PDFContentError } from './pdf'

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
    expect(describePDFError(new PDFContentError('PDF 文件请求失败（HTTP 401）', 401))).toContain('401')
  })

  it('maps PDF.js parser errors', () => {
    const error = new Error('invalid')
    error.name = 'InvalidPDFException'
    expect(describePDFError(error)).toContain('结构无效')
  })
})

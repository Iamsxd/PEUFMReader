import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, APIError } from './api'
import { transport } from './api/core'

afterEach(() => vi.unstubAllGlobals())

describe('bounded notebook download', () => {
  it('downloads all matching pages with credentials and a fixed safe filename', async () => {
    const request = vi.fn().mockResolvedValue(new Response('# 我的笔记', { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="../../unsafe.md"' } }))
    vi.stubGlobal('fetch', request)
    const file = await api.exportNotebook({ q: '中文 & 笔记', kind: 'note', color: 'blue', bookId: 123, page: 8 }, 'markdown')
    expect(file.filename).toBe('notebook.md')
    expect(await file.blob.text()).toBe('# 我的笔记')
    const [path, init] = request.mock.calls[0]
    const url = new URL(path, 'http://localhost')
    expect(url.pathname).toBe('/api/v1/notebook/export')
    expect(url.searchParams.get('page')).toBeNull()
    expect(url.searchParams.get('q')).toBe('中文 & 笔记')
    expect(url.searchParams.get('bookId')).toBe('123')
    expect(url.searchParams.get('format')).toBe('markdown')
    expect(init.credentials).toBe('include')
  })

  it('accepts JSON but rejects a successful HTML proxy page', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response('{"items":[]}', { headers: { 'Content-Type': 'application/json' } })).mockResolvedValueOnce(new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }))
    vi.stubGlobal('fetch', request)
    expect((await api.exportNotebook({}, 'json')).filename).toBe('notebook.json')
    await expect(api.exportNotebook({}, 'json')).rejects.toMatchObject({ code: 'invalid_download' })
  })

  it('preserves server errors without automatic retries', async () => {
    const request = vi.fn().mockResolvedValue(new Response('{"error":{"code":"export_too_large","message":"请缩小范围"}}', { status: 413 }))
    vi.stubGlobal('fetch', request)
    await expect(api.exportNotebook({}, 'json')).rejects.toMatchObject({ status: 413, message: '请缩小范围' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects oversized advertised and chunked responses before saving a file', async () => {
    const limit = 16 * 1024 * 1024
    const request = vi.fn().mockResolvedValueOnce(new Response('', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(limit + 1) } })).mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(limit)); controller.enqueue(new Uint8Array(1)); controller.close() } }), { headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', request)
    await expect(transport.download('/synthetic', 'application/json', 'test.json')).rejects.toMatchObject({ status: 413 })
    await expect(transport.download('/synthetic', 'application/json', 'test.json')).rejects.toMatchObject({ status: 413 })
  })

  it('reports interruption and network failures as API errors', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(new Error('interrupted')) } }), { headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', request)
    await expect(api.exportNotebook({}, 'json')).rejects.toBeInstanceOf(APIError)
    await expect(api.exportNotebook({}, 'json')).rejects.toMatchObject({ code: 'network_error' })
  })

  it('uses the authenticated atomic relative reorder endpoint', async () => {
    transport.setSession({ user: { id: 1, username: 'synthetic', role: 'reader' }, csrfToken: 'synthetic-csrf' })
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', request)
    await api.reorderShelfBook(2, 10, 30, 'after')
    const [path, init] = request.mock.calls[0]
    expect(path).toBe('/api/v1/shelves/2/order')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ bookId: 10, targetBookId: 30, placement: 'after' })
    expect(init.headers.get('X-CSRF-Token')).toBe('synthetic-csrf')
    transport.setSession(null)
  })
})

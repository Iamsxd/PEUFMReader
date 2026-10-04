import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, APIError } from './api'
import { transport } from './api/core'

afterEach(() => {
  transport.setSession(null)
  vi.unstubAllGlobals()
})

describe('personal shelf batch transport', () => {
  it('does not request memberships for an empty candidate page', async () => {
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    expect(await api.shelfMemberships(50, [])).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })

  it('queries only candidate IDs instead of downloading a whole shelf', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ bookIds: [13] })))
    vi.stubGlobal('fetch', request)
    expect(await api.shelfMemberships(50, [13, 42])).toEqual([13])
    const [path, options] = request.mock.calls[0]
    const url = new URL(path, 'http://localhost')
    expect(url.pathname).toBe('/api/v1/shelves/50/memberships')
    expect(url.searchParams.get('ids')).toBe('13,42')
    expect(options.credentials).toBe('include')
  })

  it('submits one ordered batch with CSRF and separates existing books', async () => {
    transport.setSession({ user: { id: 1, username: 'synthetic', role: 'reader' }, csrfToken: 'synthetic-csrf' })
    const result = { addedBookIds: [42, 13], alreadyPresentBookIds: [9] }
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(result)))
    vi.stubGlobal('fetch', request)
    expect(await api.addShelfBooks(50, [42, 9, 13])).toEqual(result)
    expect(request).toHaveBeenCalledTimes(1)
    const [path, options] = request.mock.calls[0]
    expect(path).toBe('/api/v1/shelves/50/books')
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body)).toEqual({ bookIds: [42, 9, 13] })
    expect(options.headers.get('X-CSRF-Token')).toBe('synthetic-csrf')
  })

  it('does not retry a rejected batch automatically', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'shelf_book_not_found', message: '书架或书籍不存在。' } }), { status: 404 }))
    vi.stubGlobal('fetch', request)
    await expect(api.addShelfBooks(50, [13, 42])).rejects.toBeInstanceOf(APIError)
    expect(request).toHaveBeenCalledTimes(1)
  })
})

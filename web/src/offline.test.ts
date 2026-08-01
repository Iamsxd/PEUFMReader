import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import {
  addOfflineActiveSeconds,
  clearOfflineUserData,
  findOfflineBook,
  getOfflineReadingState,
  listOfflineBooks,
  loadOfflineIdentity,
  markOfflineBookOpened,
  offlineAutoCleanupEnabled,
  offlineBookContent,
  offlineDefaultReadingState,
  reconcileOfflineBooks,
  rememberOfflineIdentity,
  rememberOfflineReadingState,
  removeOfflineBook,
  removeOldestOfflineBook,
  saveBookForOffline,
  setOfflineAutoCleanupEnabled,
  syncOfflineReading,
} from './offline'
import type { BookFile, ReadingState, Session } from './types'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

class MemoryCache {
  readonly values = new Map<string, Response>()
  async put(key: RequestInfo | URL, response: Response) { this.values.set(cacheKey(key), response.clone()) }
  async match(key: RequestInfo | URL) { return this.values.get(cacheKey(key))?.clone() }
  async delete(key: RequestInfo | URL) { return this.values.delete(cacheKey(key)) }
}

function cacheKey(value: RequestInfo | URL): string {
  if (typeof value === 'string') return value
  if (value instanceof URL) return value.toString()
  return value.url
}

const book: BookFile = {
  id: 12,
  workId: 7,
  editionId: 9,
  title: '离线测试书',
  authors: ['测试作者'],
  categories: [],
  reviewRequired: false,
  textAvailable: false,
  originalFilename: 'offline.pdf',
  storageMode: 'managed',
  format: 'pdf',
  mimeType: 'application/pdf',
  sizeBytes: 10,
  createdAt: '2026-08-01T00:00:00Z',
}

describe('offline book storage', () => {
  const cache = new MemoryCache()
  const cacheStorage = {
    open: vi.fn(async () => cache),
    delete: vi.fn(async () => { cache.values.clear(); return true }),
  }

  beforeEach(() => {
    cache.values.clear()
    vi.clearAllMocks()
    const localStorage = new MemoryStorage()
    vi.stubGlobal('window', { localStorage, caches: cacheStorage, location: { origin: 'https://reader.test' } })
    vi.stubGlobal('localStorage', localStorage)
    vi.stubGlobal('caches', cacheStorage)
    vi.stubGlobal('navigator', { storage: { estimate: vi.fn(async () => ({ usage: 100, quota: 100_000 })), persisted: vi.fn(async () => true), persist: vi.fn(async () => true) } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps the cached identity for a bounded offline window', () => {
    const session: Session = { user: { id: 3, username: 'reader', role: 'reader' }, csrfToken: 'not-persisted' }
    rememberOfflineIdentity(session)
    expect(loadOfflineIdentity()?.user).toEqual(session.user)
    expect(loadOfflineIdentity(Date.now() + 8 * 24 * 60 * 60 * 1000)).toBeNull()
  })

  it('saves, opens and removes a user-isolated book copy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('%PDF-offline', { status: 200, headers: { 'Content-Type': 'application/pdf' } })))

    const record = await saveBookForOffline(3, book)
    expect(record.contentBytes).toBe(12)
    expect(listOfflineBooks(3)).toHaveLength(1)
    expect(findOfflineBook(4, book.id)).toBeUndefined()
    expect(new TextDecoder().decode(await offlineBookContent(3, book.id))).toBe('%PDF-offline')
    expect(findOfflineBook(3, book.id)?.lastOpenedAt).toBeTruthy()

    await removeOfflineBook(3, book.id)
    expect(listOfflineBooks(3)).toEqual([])
  })

  it('cleans the least recently used copy and keeps cleanup configurable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('%PDF-offline', { status: 200, headers: { 'Content-Type': 'application/pdf' } })))
    const older = await saveBookForOffline(3, book)
    markOfflineBookOpened(3, older.book.id, '2026-07-01T00:00:00Z')
    const newerBook = { ...book, id: 13, title: '较新的离线书' }
    await saveBookForOffline(3, newerBook)

    expect(offlineAutoCleanupEnabled(3)).toBe(true)
    setOfflineAutoCleanupEnabled(3, false)
    expect(offlineAutoCleanupEnabled(3)).toBe(false)
    const result = await removeOldestOfflineBook(3)

    expect(result.removed.map((item) => item.book.id)).toEqual([book.id])
    expect(listOfflineBooks(3).map((item) => item.book.id)).toEqual([newerBook.id])
  })

  it('reconciles stale metadata when the browser removed cached content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('%PDF-offline', { status: 200, headers: { 'Content-Type': 'application/pdf' } })))
    await saveBookForOffline(3, book)
    cache.values.clear()

    const result = await reconcileOfflineBooks(3)

    expect(result.removed.map((item) => item.book.id)).toEqual([book.id])
    expect(listOfflineBooks(3)).toEqual([])
  })

  it('queues reading progress and active time until the server is reachable', async () => {
    const state: ReadingState = { ...offlineDefaultReadingState(book.id), position: { pageIndex: 4 }, overallProgress: 0.5, status: 'reading' }
    rememberOfflineReadingState(3, state, true)
    addOfflineActiveSeconds(3, book.id, 30)
    vi.spyOn(api, 'saveProgress').mockResolvedValue({ ...state, updatedAt: '2026-08-01T01:00:00Z' })
    vi.spyOn(api, 'startReadingSession').mockResolvedValue({ id: 44, bookFileId: book.id, startedAt: '', lastHeartbeatAt: '', activeSeconds: 0 })
    vi.spyOn(api, 'advanceReadingSession').mockResolvedValue({ id: 44, bookFileId: book.id, startedAt: '', lastHeartbeatAt: '', activeSeconds: 30, endedAt: '' })

    await syncOfflineReading(3)

    expect(api.saveProgress).toHaveBeenCalledWith(book.id, expect.objectContaining({ overallProgress: 0.5 }))
    expect(api.advanceReadingSession).toHaveBeenCalledWith(44, 'finish', 30)
    expect(getOfflineReadingState(3, book.id)?.position).toEqual({ pageIndex: 4 })
    await clearOfflineUserData(3)
    expect(getOfflineReadingState(3, book.id)).toBeUndefined()
  })
})

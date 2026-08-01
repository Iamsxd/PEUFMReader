import { APIError, api } from './api'
import type { BookFile, ReadingState, Session, User } from './types'

const OFFLINE_VERSION = 'v1'
const IDENTITY_KEY = `peufmreader-offline-identity-${OFFLINE_VERSION}`
const IDENTITY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface OfflineBookRecord {
  book: BookFile
  cachedAt: string
  contentBytes: number
}

interface OfflineIdentity {
  user: User
  cachedAt: string
}

interface OfflineProgressRecord {
  state: ReadingState
  pending: boolean
}

export class OfflineStorageError extends Error {}

export function offlineStorageSupported(): boolean {
  return typeof window !== 'undefined' && 'caches' in window && 'localStorage' in window
}

export function offlineBookCacheName(userID: number): string {
  return `peufmreader-offline-books-${OFFLINE_VERSION}-user-${positiveUserID(userID)}`
}

export function offlineDefaultReadingState(bookFileID: number): ReadingState {
  return {
    bookFileId: bookFileID,
    position: {},
    overallProgress: 0,
    status: 'unread',
    totalActiveSeconds: 0,
  }
}

export async function saveBookForOffline(userID: number, book: BookFile): Promise<OfflineBookRecord> {
  requireOfflineStorage()
  const estimate = await offlineStorageEstimate()
  const available = estimate.quota > 0 ? Math.max(0, estimate.quota - estimate.usage) : 0
  if (available > 0 && book.sizeBytes > available * 0.9) {
    throw new OfflineStorageError(`浏览器可用空间不足，需要约 ${formatStorageBytes(book.sizeBytes)}。`)
  }

  let response: Response
  try {
    response = await fetch(api.contentURL(book.id), { credentials: 'include' })
  } catch {
    throw new OfflineStorageError('无法连接服务器，未能保存离线副本。')
  }
  if (!response.ok) {
    throw new APIError(response.status, 'offline_download_failed', `离线副本下载失败（HTTP ${response.status}）。`)
  }

  const blob = await response.blob()
  if (blob.size === 0) throw new OfflineStorageError('服务器返回了空文件，未保存离线副本。')
  const cache = await caches.open(offlineBookCacheName(userID))
  await cache.put(offlineContentKey(userID, book.id), new Response(blob, {
    headers: {
      'Content-Type': response.headers.get('Content-Type') || book.mimeType,
      'Content-Length': String(blob.size),
      'X-PEUFM-Book-ID': String(book.id),
    },
  }))

  const record = { book, cachedAt: new Date().toISOString(), contentBytes: blob.size }
  try {
    writeOfflineBooks(userID, [record, ...listOfflineBooks(userID).filter((item) => item.book.id !== book.id)])
  } catch (reason) {
    await cache.delete(offlineContentKey(userID, book.id))
    throw reason
  }
  return record
}

export function listOfflineBooks(userID: number): OfflineBookRecord[] {
  const stored = readJSON<unknown>(offlineBooksKey(userID), [])
  const records = Array.isArray(stored) ? stored as OfflineBookRecord[] : []
  return records
    .filter((item) => item?.book?.id > 0 && typeof item.cachedAt === 'string' && item.contentBytes > 0)
    .sort((left, right) => right.cachedAt.localeCompare(left.cachedAt))
}

export function findOfflineBook(userID: number, bookFileID: number): OfflineBookRecord | undefined {
  return listOfflineBooks(userID).find((item) => item.book.id === bookFileID)
}

export async function removeOfflineBook(userID: number, bookFileID: number): Promise<void> {
  writeOfflineBooks(userID, listOfflineBooks(userID).filter((item) => item.book.id !== bookFileID))
  if (typeof caches !== 'undefined') {
    const cache = await caches.open(offlineBookCacheName(userID))
    await cache.delete(offlineContentKey(userID, bookFileID))
  }
  removeOfflineProgress(userID, bookFileID)
}

export async function offlineBookContent(userID: number, bookFileID: number): Promise<ArrayBuffer | undefined> {
  if (!offlineStorageSupported()) return undefined
  const cache = await caches.open(offlineBookCacheName(userID))
  const response = await cache.match(offlineContentKey(userID, bookFileID))
  if (!response) return undefined
  return response.arrayBuffer()
}

export async function clearOfflineUserData(userID: number): Promise<void> {
  if (typeof caches !== 'undefined') await caches.delete(offlineBookCacheName(userID))
  safeRemove(offlineBooksKey(userID))
  safeRemove(offlineProgressKey(userID))
  safeRemove(offlineActivityKey(userID))
  const identity = readJSON<OfflineIdentity | null>(IDENTITY_KEY, null)
  if (identity?.user.id === userID) safeRemove(IDENTITY_KEY)
}

export function rememberOfflineIdentity(session: Session): void {
  writeJSON(IDENTITY_KEY, { user: session.user, cachedAt: new Date().toISOString() } satisfies OfflineIdentity)
}

export function loadOfflineIdentity(now = Date.now()): Session | null {
  const identity = readJSON<OfflineIdentity | null>(IDENTITY_KEY, null)
  const cachedAt = identity ? Date.parse(identity.cachedAt) : Number.NaN
  if (!identity?.user?.id || !Number.isFinite(cachedAt) || now - cachedAt > IDENTITY_MAX_AGE_MS) return null
  return { user: identity.user, csrfToken: '' }
}

export function getOfflineReadingState(userID: number, bookFileID: number): ReadingState | undefined {
  return readOfflineProgress(userID)[String(bookFileID)]?.state
}

export function rememberOfflineReadingState(userID: number, state: ReadingState, pending: boolean): void {
  const progress = readOfflineProgress(userID)
  progress[String(state.bookFileId)] = { state, pending }
  writeJSON(offlineProgressKey(userID), progress)
}

export function addOfflineActiveSeconds(userID: number, bookFileID: number, seconds: number): void {
  if (seconds <= 0) return
  const activity = readJSON<Record<string, number>>(offlineActivityKey(userID), {})
  activity[String(bookFileID)] = Math.max(0, activity[String(bookFileID)] ?? 0) + seconds
  writeJSON(offlineActivityKey(userID), activity)
}

export async function syncOfflineReading(userID: number): Promise<void> {
  const progress = readOfflineProgress(userID)
  for (const [bookID, record] of Object.entries(progress)) {
    if (!record.pending) continue
    try {
      const state = await api.saveProgress(Number(bookID), {
        position: record.state.position,
        overallProgress: record.state.overallProgress,
        status: record.state.status,
      })
      progress[bookID] = { state, pending: false }
      writeJSON(offlineProgressKey(userID), progress)
    } catch {
      return
    }
  }

  const activity = readJSON<Record<string, number>>(offlineActivityKey(userID), {})
  for (const [bookID, seconds] of Object.entries(activity)) {
    if (seconds <= 0) continue
    try {
      const session = await api.startReadingSession(Number(bookID))
      await api.advanceReadingSession(session.id, 'finish', seconds)
      delete activity[bookID]
      writeJSON(offlineActivityKey(userID), activity)
    } catch {
      return
    }
  }
}

export async function offlineStorageEstimate(): Promise<{ usage: number; quota: number }> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return { usage: 0, quota: 0 }
  const estimate = await navigator.storage.estimate()
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
}

function readOfflineProgress(userID: number): Record<string, OfflineProgressRecord> {
  const stored = readJSON<unknown>(offlineProgressKey(userID), {})
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, OfflineProgressRecord> : {}
}

function removeOfflineProgress(userID: number, bookFileID: number): void {
  const progress = readOfflineProgress(userID)
  delete progress[String(bookFileID)]
  writeJSON(offlineProgressKey(userID), progress)
}

function writeOfflineBooks(userID: number, records: OfflineBookRecord[]): void {
  writeJSON(offlineBooksKey(userID), records)
}

function offlineContentKey(userID: number, bookFileID: number): string {
  return new URL(`/__peufm-offline/user/${positiveUserID(userID)}/book/${positiveBookID(bookFileID)}`, window.location.origin).toString()
}

function offlineBooksKey(userID: number): string {
  return `peufmreader-offline-books-${OFFLINE_VERSION}-user-${positiveUserID(userID)}`
}

function offlineProgressKey(userID: number): string {
  return `peufmreader-offline-progress-${OFFLINE_VERSION}-user-${positiveUserID(userID)}`
}

function offlineActivityKey(userID: number): string {
  return `peufmreader-offline-activity-${OFFLINE_VERSION}-user-${positiveUserID(userID)}`
}

function positiveUserID(value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new OfflineStorageError('无效的离线用户。')
  return value
}

function positiveBookID(value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new OfflineStorageError('无效的离线书籍。')
  return value
}

function requireOfflineStorage(): void {
  if (!offlineStorageSupported()) throw new OfflineStorageError('当前浏览器不支持离线书籍存储。')
}

function readJSON<T>(key: string, fallback: T): T {
  try {
    const value = window.localStorage.getItem(key)
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch (reason) {
    throw new OfflineStorageError(reason instanceof Error ? reason.message : '浏览器拒绝保存离线数据。')
  }
}

function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Locked-down browsers may reject access to local storage.
  }
}

function formatStorageBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

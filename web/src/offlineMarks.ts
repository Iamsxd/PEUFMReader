import { APIError, api } from './api'
import type { ReadingMark, ReadingMarkInput } from './types'

type WireMutation = Parameters<typeof api.syncReadingMark>[0]
interface Mutation {
  operationId: string
  logicalID: number
  bookFileID: number
  action: 'create' | 'update' | 'delete'
  mark: ReadingMark
  wire?: WireMutation
  problem?: string
}
interface MarkCache {
  generation: string
  marks: ReadingMark[]
  queue: Mutation[]
  bindings: Record<string, { id: number; updatedAt: string }>
  nextID: number
}
const running = new Map<number, Promise<void>>()
export const OFFLINE_MARKS_EVENT = 'peufmreader-offline-marks'
// randomUUID is HTTPS-only in some browsers; getRandomValues also works on NAS HTTP.
function operationID(): string {
  if (crypto.randomUUID) return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
function key(userID: number) {
  if (!Number.isSafeInteger(userID) || userID <= 0) throw new Error('无效的笔记账号。')
  return `peufmreader.offline.marks.v1.user.${userID}`
}
function read(userID: number): MarkCache {
  const stored = localStorage.getItem(key(userID))
  if (!stored) return { generation: operationID(), marks: [], queue: [], bindings: {}, nextID: -1 }
  const value = JSON.parse(stored) as MarkCache
  if (!Array.isArray(value.marks) || !Array.isArray(value.queue) || !value.bindings || !value.generation || !Number.isSafeInteger(value.nextID)) throw new Error('设备笔记缓存无效，请先导出或联系管理员。')
  return value
}
function write(userID: number, cache: MarkCache) {
  const serialized = JSON.stringify(cache)
  if (serialized.length > 2 * 1024 * 1024 || cache.queue.length > 2000) throw new Error('设备笔记缓存已满，请联网同步后重试。')
  localStorage.setItem(key(userID), serialized)
  window.dispatchEvent?.(new Event(OFFLINE_MARKS_EVENT))
}
export function clearOfflineMarks(userID: number) {
  try { localStorage.removeItem(key(userID)) } catch { /* Continue clearing the other account caches and logging out. */ }
  window.dispatchEvent?.(new Event(OFFLINE_MARKS_EVENT))
}
export function cachedReadingMarks(userID: number, bookFileID: number): ReadingMark[] {
  return read(userID).marks.filter(mark => mark.bookFileId === bookFileID)
}
export function canonicalMarkID(userID: number, logicalID: number): number {
  const cache = read(userID)
  return cache.queue.some(op => op.logicalID === logicalID) ? logicalID : cache.bindings[String(logicalID)]?.id ?? logicalID
}
export function pendingMarkStatus(userID: number, bookFileID: number): { pending: number; problems: string[] } {
  try {
    const queue = read(userID).queue.filter(op => op.bookFileID === bookFileID)
    return { pending: queue.length, problems: [...new Set(queue.flatMap(op => op.problem ? [op.problem] : []))] }
  } catch { return { pending: 0, problems: ['设备笔记缓存不可用，请检查浏览器存储设置。未提交任何草稿。'] } }
}
export async function loadReadingMarks(userID: number, bookFileID: number, offline: boolean): Promise<ReadingMark[]> {
  if (offline) return cachedReadingMarks(userID, bookFileID)
  const initial = read(userID)
  if (!localStorage.getItem(key(userID))) write(userID, initial)
  try {
    const session = await api.me()
    if (session.user.id !== userID) throw new APIError(401, 'account_changed', '账号已变化，请重新登录。')
    await syncOfflineMarks(userID)
    const items = await api.listReadingMarks(bookFileID)
    const cache = read(userID)
    if (cache.generation !== initial.generation) return []
    const pending = cache.queue.filter(op => op.bookFileID === bookFileID)
    const logical = new Set(pending.map(op => op.logicalID))
    const server = new Set(pending.map(op => cache.bindings[String(op.logicalID)]?.id ?? op.logicalID))
    cache.marks = [
      ...cache.marks.filter(mark => mark.bookFileId !== bookFileID || logical.has(mark.id)),
      ...items.filter(mark => !server.has(mark.id)),
    ]
    for (const mark of items) if (!server.has(mark.id)) cache.bindings[String(mark.id)] = { id: mark.id, updatedAt: mark.updatedAt }
    write(userID, cache)
    return cachedReadingMarks(userID, bookFileID)
  } catch (reason) {
    if (reason instanceof APIError && (reason.status === 403 || reason.status === 404)) {
      // Permission revocation never uploads a draft, and removes readable text.
      const cache = read(userID)
      cache.marks = cache.marks.filter(mark => mark.bookFileId !== bookFileID)
      cache.queue = cache.queue.filter(op => op.bookFileID !== bookFileID)
      write(userID, cache)
    }
    if (reason instanceof APIError && reason.status === 0) return cachedReadingMarks(userID, bookFileID)
    throw reason
  }
}
export async function createLocalReadingMark(userID: number, bookFileID: number, input: ReadingMarkInput, offline: boolean): Promise<ReadingMark> {
  const cache = read(userID)
  const now = new Date().toISOString()
  const mark: ReadingMark = { ...input, id: cache.nextID--, bookFileId: bookFileID, quote: input.quote ?? '', color: input.color ?? '', createdAt: now, updatedAt: now }
  cache.marks.push(mark)
  cache.queue.push({ operationId: operationID(), logicalID: mark.id, bookFileID, action: 'create', mark })
  write(userID, cache)
  if (!offline) await syncOfflineMarks(userID)
  return read(userID).marks.find(item => item.id === mark.id) ?? mark
}
export async function updateLocalReadingMark(userID: number, mark: ReadingMark, input: Pick<ReadingMark, 'label' | 'body' | 'color'>, offline: boolean): Promise<ReadingMark> {
  const cache = read(userID)
  const updated = { ...mark, ...input }
  if (!cache.bindings[String(mark.id)] && mark.id > 0) cache.bindings[String(mark.id)] = { id: mark.id, updatedAt: mark.updatedAt }
  cache.marks = cache.marks.map(item => item.id === mark.id ? updated : item)
  cache.queue.push({ operationId: operationID(), logicalID: mark.id, bookFileID: mark.bookFileId, action: 'update', mark: updated })
  write(userID, cache)
  if (!offline) await syncOfflineMarks(userID)
  return read(userID).marks.find(item => item.id === mark.id) ?? updated
}
export async function deleteLocalReadingMark(userID: number, mark: ReadingMark, offline: boolean): Promise<void> {
  const cache = read(userID)
  if (!cache.bindings[String(mark.id)] && mark.id > 0) cache.bindings[String(mark.id)] = { id: mark.id, updatedAt: mark.updatedAt }
  cache.marks = cache.marks.filter(item => item.id !== mark.id)
  cache.queue.push({ operationId: operationID(), logicalID: mark.id, bookFileID: mark.bookFileId, action: 'delete', mark })
  write(userID, cache)
  if (!offline) await syncOfflineMarks(userID)
}
export function exportLocalMarks(userID: number, bookFileID: number): Blob {
  const cache = read(userID)
  return new Blob([JSON.stringify({ items: cache.marks.filter(mark => mark.bookFileId === bookFileID), pending: cache.queue.filter(op => op.bookFileID === bookFileID), exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' })
}
// Explicitly discard only this book's conflicting local draft, then reload the
// current server version. Never silently overwrite a remote edit.
export async function discardConflictingMarks(userID: number, bookFileID: number) {
  const cache = read(userID)
  const ids = new Set(cache.queue.filter(op => op.bookFileID === bookFileID && op.problem).map(op => op.logicalID))
  cache.queue = cache.queue.filter(op => !ids.has(op.logicalID))
  cache.marks = cache.marks.filter(mark => !ids.has(mark.id))
  write(userID, cache)
  return loadReadingMarks(userID, bookFileID, false)
}
export function syncOfflineMarks(userID: number): Promise<void> {
  const existing = running.get(userID)
  if (existing) return existing
  const work = async () => {
    if (!localStorage.getItem(key(userID)) || !read(userID).queue.length) return
    // Never send another cached account's outbox under the current cookie.
    const identity = await api.me()
    if (identity.user.id !== userID) return
    const generation = read(userID).generation
    const blocked = new Set(read(userID).queue.filter(op => op.problem).map(op => op.logicalID))
    for (;;) {
      const cache = read(userID)
      if (cache.generation !== generation) return
      const op = cache.queue.find(item => !blocked.has(item.logicalID) && !item.problem)
      if (!op) return
      const binding = cache.bindings[String(op.logicalID)]
      if (!op.wire) {
        op.wire = { accountId: userID, operationId: op.operationId, action: op.action, bookFileId: op.bookFileID, markId: binding?.id ?? 0, expectedUpdatedAt: binding?.updatedAt, mark: op.mark }
        write(userID, cache)
      }
      try {
        const result = await api.syncReadingMark(op.wire)
        const latest = read(userID)
        if (latest.generation !== generation) return
        latest.queue = latest.queue.filter(item => item.operationId !== op.operationId)
        if (result.mark) {
          latest.bindings[String(op.logicalID)] = { id: result.mark.id, updatedAt: result.mark.updatedAt }
          if (!latest.queue.some(item => item.logicalID === op.logicalID)) latest.marks = latest.marks.map(mark => mark.id === op.logicalID ? { ...result.mark!, id: op.logicalID } : mark)
        } else if (result.deleted) {
          const following = latest.queue.filter(item => item.logicalID === op.logicalID)
          if (following.length) {
            following[0].problem = '服务器已删除此批注，未重新创建。请先导出本地草稿。'
            blocked.add(op.logicalID)
          } else {
            latest.marks = latest.marks.filter(mark => mark.id !== op.logicalID)
            delete latest.bindings[String(op.logicalID)]
          }
        }
        write(userID, latest)
      } catch (reason) {
        if (!(reason instanceof APIError) || reason.status === 0 || reason.status >= 500 || reason.status === 401) return
        const latest = read(userID)
        if (latest.generation !== generation) return
        if (reason.status === 403 || (reason.status === 404 && reason.code === 'book_not_found')) {
          latest.marks = latest.marks.filter(mark => mark.bookFileId !== op.bookFileID)
          latest.queue = latest.queue.filter(item => item.bookFileID !== op.bookFileID)
        } else {
          const pending = latest.queue.find(item => item.operationId === op.operationId)
          if (pending) pending.problem = reason.status === 409 ? '此批注在其他设备已修改。请导出本地草稿，再核对服务器版本。' : '批注无法同步，请导出草稿并核对书籍权限或记录是否已删除。'
          blocked.add(op.logicalID)
        }
        write(userID, latest)
      }
    }
  }
  const promise = (async () => {
    if (navigator.locks) await navigator.locks.request(key(userID), async () => { await work() })
    else await work()
  })().catch(() => { /* Keep the durable outbox for the next retry. */ }).finally(() => running.delete(userID))
  running.set(userID, promise)
  return promise
}

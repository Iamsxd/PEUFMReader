import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APIError, api } from './api'
import { cachedReadingMarks, clearOfflineMarks, createLocalReadingMark, deleteLocalReadingMark, loadReadingMarks, pendingMarkStatus, syncOfflineMarks, updateLocalReadingMark } from './offlineMarks'
import type { ReadingMark } from './types'

const input = { kind: 'note' as const, position: { pageIndex: 0 }, overallProgress: 0.1, label: '第 1 页', body: '原创笔记' }
const remote: ReadingMark = { ...input, id: 11, bookFileId: 7, quote: '', color: '', createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z' }
describe('account-isolated offline mark journal', () => {
  beforeEach(() => {
    const items = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => items.set(key, value), removeItem: (key: string) => items.delete(key) })
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
    vi.stubGlobal('navigator', {})
    vi.spyOn(api, 'me').mockResolvedValue({ user: { id: 1, username: 'original-test', role: 'reader' }, csrfToken: 'test' })
    vi.spyOn(api, 'listReadingMarks').mockResolvedValue([remote])
    vi.spyOn(api, 'syncReadingMark').mockImplementation(async mutation => ({ mark: { ...mutation.mark, id: mutation.markId || 11, updatedAt: '2026-10-05T01:00:00Z' }, deleted: mutation.action === 'delete' }))
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
  it('replays create, edit and delete in order with server ID and version', async () => {
    const mark = await createLocalReadingMark(1, 7, input, true)
    await updateLocalReadingMark(1, mark, { label: mark.label, body: '离线修改', color: '' }, true)
    await deleteLocalReadingMark(1, mark, true)
    expect(cachedReadingMarks(1, 7)).toEqual([])
    expect(cachedReadingMarks(2, 7)).toEqual([])
    await syncOfflineMarks(1)
    expect(api.syncReadingMark).toHaveBeenCalledTimes(3)
    const mutations = vi.mocked(api.syncReadingMark).mock.calls.map(([mutation]) => mutation)
    expect(mutations.map(mutation => mutation.action)).toEqual(['create', 'update', 'delete'])
    expect(mutations[1].markId).toBe(11)
    expect(mutations[1].expectedUpdatedAt).toBe('2026-10-05T01:00:00Z')
    expect(pendingMarkStatus(1, 7).pending).toBe(0)
  })
  it('retries exactly the same immutable operation after an ambiguous response', async () => {
    await createLocalReadingMark(1, 7, input, true)
    vi.mocked(api.syncReadingMark).mockRejectedValueOnce(new APIError(0, 'network_error', '断网'))
    await syncOfflineMarks(1)
    expect(pendingMarkStatus(1, 7).pending).toBe(1)
    await syncOfflineMarks(1)
    expect(vi.mocked(api.syncReadingMark).mock.calls[0][0]).toEqual(vi.mocked(api.syncReadingMark).mock.calls[1][0])
    expect(pendingMarkStatus(1, 7).pending).toBe(0)
  })
  it('retains local edits arriving during an in-flight create', async () => {
    const mark = await createLocalReadingMark(1, 7, input, true)
    let resolve!: (result: { mark: ReadingMark; deleted: boolean }) => void
    vi.mocked(api.syncReadingMark).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const syncing = syncOfflineMarks(1)
    await vi.waitFor(() => expect(api.syncReadingMark).toHaveBeenCalledTimes(1))
    await updateLocalReadingMark(1, mark, { label: mark.label, body: '同步中又修改', color: '' }, true)
    resolve({ mark: remote, deleted: false })
    await syncing
    expect(api.syncReadingMark).toHaveBeenCalledTimes(2)
    expect(cachedReadingMarks(1, 7)[0].body).toBe('同步中又修改')
  })
  it('blocks subsequent edits to a conflicted mark without overwriting its draft', async () => {
    await loadReadingMarks(1, 7, false)
    await updateLocalReadingMark(1, remote, { label: remote.label, body: '本地冲突草稿', color: '' }, true)
    await updateLocalReadingMark(1, remote, { label: remote.label, body: '后续本地修改', color: '' }, true)
    vi.mocked(api.syncReadingMark).mockRejectedValue(new APIError(409, 'reading_mark_conflict', 'conflict'))
    await syncOfflineMarks(1)
    await syncOfflineMarks(1)
    expect(api.syncReadingMark).toHaveBeenCalledTimes(1)
    expect(pendingMarkStatus(1, 7).problems).toHaveLength(1)
    expect(cachedReadingMarks(1, 7)[0].body).toBe('后续本地修改')
  })
  it('does not upload another account, and does not restore data after logout', async () => {
    await createLocalReadingMark(2, 7, input, true)
    await syncOfflineMarks(2)
    expect(api.syncReadingMark).not.toHaveBeenCalled()
    await createLocalReadingMark(1, 7, input, true)
    let resolve!: (result: { mark: ReadingMark; deleted: boolean }) => void
    vi.mocked(api.syncReadingMark).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const syncing = syncOfflineMarks(1)
    await vi.waitFor(() => expect(api.syncReadingMark).toHaveBeenCalledTimes(1))
    clearOfflineMarks(1)
    resolve({ mark: remote, deleted: false })
    await syncing
    expect(cachedReadingMarks(1, 7)).toEqual([])
  })
  it('scrubs readable notes and queued changes when book access is revoked', async () => {
    await createLocalReadingMark(1, 7, input, true)
    vi.mocked(api.syncReadingMark).mockRejectedValue(new APIError(404, 'book_not_found', 'not found'))
    await syncOfflineMarks(1)
    expect(pendingMarkStatus(1, 7).pending).toBe(0)
    expect(cachedReadingMarks(1, 7)).toEqual([])
  })
  it('does not recreate a server-deleted mark on an ambiguous create retry', async () => {
    const mark = await createLocalReadingMark(1, 7, input, true)
    await updateLocalReadingMark(1, mark, { label: mark.label, body: '保留的本地草稿', color: '' }, true)
    vi.mocked(api.syncReadingMark).mockResolvedValue({ deleted: true })
    await syncOfflineMarks(1)
    expect(api.syncReadingMark).toHaveBeenCalledTimes(1)
    expect(pendingMarkStatus(1, 7).problems[0]).toContain('已删除')
    expect(cachedReadingMarks(1, 7)[0].body).toBe('保留的本地草稿')
    expect(vi.mocked(api.syncReadingMark).mock.calls[0][0].accountId).toBe(1)
  })
  it('surfaces unavailable storage without crashing the marks status', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('storage denied') } })
    expect(pendingMarkStatus(1, 7).problems[0]).toContain('缓存不可用')
  })
})

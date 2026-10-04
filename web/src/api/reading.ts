import type { CatalogPage, NotebookPage, NotebookQuery, PersonalShelf, ReadingMark, ReadingMarkInput, ReadingSession, ReadingState } from '../types'
import { querySuffix, transport } from './core'

export const readingAPI = {
  searchNotebook(query: NotebookQuery = {}): Promise<NotebookPage> {
    return transport.request(`/api/v1/notebook${querySuffix(query)}`)
  },
  exportNotebook(query: NotebookQuery, format: 'markdown' | 'json'): Promise<{ blob: Blob; filename: string }> {
    const { page: _page, ...filters } = query
    return transport.download(`/api/v1/notebook/export${querySuffix({ ...filters, format })}`, format === 'json' ? 'application/json' : 'text/markdown', format === 'json' ? 'notebook.json' : 'notebook.md')
  },
  async listShelves(bookId?: number): Promise<PersonalShelf[]> {
    const result = await transport.request<{ items: PersonalShelf[] }>(`/api/v1/shelves${querySuffix({ bookId })}`)
    return result.items
  },
  saveShelf(name: string, description: string, id?: number): Promise<PersonalShelf> {
    return transport.request(`/api/v1/shelves${id ? `/${id}` : ''}`, { method: id ? 'PATCH' : 'POST', body: JSON.stringify({ name, description }), headers: { 'Content-Type': 'application/json' } })
  },
  deleteShelf(id: number): Promise<void> {
    return transport.request(`/api/v1/shelves/${id}`, { method: 'DELETE' })
  },
  shelfBooks(id: number, page = 1): Promise<CatalogPage> {
    return transport.request(`/api/v1/shelves/${id}/books?page=${page}`)
  },
  async shelfMemberships(id: number, bookIds: number[]): Promise<number[]> {
    if (bookIds.length === 0) return []
    const result = await transport.request<{ bookIds: number[] }>(`/api/v1/shelves/${id}/memberships${querySuffix({ ids: bookIds.join(',') })}`)
    return result.bookIds
  },
  addShelfBooks(id: number, bookIds: number[]): Promise<{ addedBookIds: number[]; alreadyPresentBookIds: number[] }> {
    return transport.request(`/api/v1/shelves/${id}/books`, { method: 'POST', body: JSON.stringify({ bookIds }), headers: { 'Content-Type': 'application/json' } })
  },
  setShelfBook(id: number, bookId: number, included: boolean): Promise<void> {
    return transport.request(`/api/v1/shelves/${id}/books/${bookId}`, { method: included ? 'PUT' : 'DELETE' })
  },
  moveShelfBook(id: number, bookId: number, direction: 'earlier' | 'later'): Promise<void> {
    return transport.request(`/api/v1/shelves/${id}/books/${bookId}`, { method: 'PATCH', body: JSON.stringify({ direction }), headers: { 'Content-Type': 'application/json' } })
  },
  reorderShelfBook(id: number, bookId: number, targetBookId: number, placement: 'before' | 'after'): Promise<void> {
    return transport.request(`/api/v1/shelves/${id}/order`, { method: 'PATCH', body: JSON.stringify({ bookId, targetBookId, placement }), headers: { 'Content-Type': 'application/json' } })
  },
  contentURL(bookFileID: number): string {
    return `/api/v1/book-files/${bookFileID}/content`
  },
  getProgress(bookFileID: number): Promise<ReadingState> {
    return transport.request(`/api/v1/book-files/${bookFileID}/progress`)
  },
  saveProgress(bookFileID: number, state: Pick<ReadingState, 'position' | 'overallProgress' | 'status'>): Promise<ReadingState> {
    return transport.request(`/api/v1/book-files/${bookFileID}/progress`, { method: 'PUT', body: JSON.stringify(state), headers: { 'Content-Type': 'application/json' } })
  },
  async listReadingMarks(bookFileID: number): Promise<ReadingMark[]> {
    const result = await transport.request<{ items: ReadingMark[] }>(`/api/v1/book-files/${bookFileID}/marks`)
    return result.items
  },
  readingMarksExportURL(bookFileID: number, format: 'markdown' | 'json'): string {
    return `/api/v1/book-files/${bookFileID}/marks/export?format=${format}`
  },
  createReadingMark(bookFileID: number, input: ReadingMarkInput): Promise<ReadingMark> {
    return transport.request(`/api/v1/book-files/${bookFileID}/marks`, { method: 'POST', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } })
  },
  updateReadingMark(markID: number, input: Pick<ReadingMark, 'label' | 'body'> & { color?: ReadingMark['color'] }): Promise<ReadingMark> {
    return transport.request(`/api/v1/reading-marks/${markID}`, { method: 'PATCH', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } })
  },
  deleteReadingMark(markID: number): Promise<void> {
    return transport.request(`/api/v1/reading-marks/${markID}`, { method: 'DELETE' })
  },
  startReadingSession(bookFileID: number): Promise<ReadingSession> {
    return transport.request(`/api/v1/book-files/${bookFileID}/reading-sessions`, { method: 'POST' })
  },
  advanceReadingSession(sessionID: number, action: 'heartbeat' | 'finish', activeSeconds: number): Promise<ReadingSession> {
    return transport.request(`/api/v1/reading-sessions/${sessionID}`, { method: 'PATCH', body: JSON.stringify({ action, activeSeconds }), headers: { 'Content-Type': 'application/json' }, keepalive: action === 'finish' })
  },
}

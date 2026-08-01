import type { ReadingMark, ReadingMarkInput, ReadingSession, ReadingState } from '../types'
import { transport } from './core'

export const readingAPI = {
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

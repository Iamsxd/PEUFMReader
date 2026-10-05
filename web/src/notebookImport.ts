import { sha256 } from '@noble/hashes/sha2.js'
import type { ReadingMark } from './types'

export interface NotebookImportItem { operationId: string; bookFileId: number; bookTitle?: string; bookFormat?: string; mark: ReadingMark }
export function parseNotebookImport(text: string): NotebookImportItem[] {
  if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024) throw new Error('导入文件上限为 2 MiB。请分批导入。')
  const value = JSON.parse(text) as Record<string, unknown>
  if (!value || typeof value !== 'object' || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 200) throw new Error('请选择包含 1–200 条笔记的 PEUFMReader JSON 文件。')
  const book = value.book && typeof value.book === 'object' ? value.book as Record<string, unknown> : undefined
  const fileHash = Array.from(sha256(new TextEncoder().encode(text)), byte => byte.toString(16).padStart(2, '0')).join('')
  return value.items.map((raw: unknown, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`第 ${index + 1} 条记录格式无效。`)
    const mark = raw as ReadingMark & { bookTitle?: string; bookFormat?: string }
    const id = mark.bookFileId ?? book?.id
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || !['bookmark', 'note', 'highlight'].includes(mark.kind) || !mark.position || typeof mark.position !== 'object' || Array.isArray(mark.position) || !Number.isFinite(mark.overallProgress) || mark.overallProgress < 0 || mark.overallProgress > 1) throw new Error(`第 ${index + 1} 条记录的书籍或定位无效。`)
    const validText = (field: unknown, limit: number) => typeof field === 'string' && [...field].length <= limit
    if (!validText(mark.label, 200) || !mark.label.trim() || !validText(mark.body, 10000) || !validText(mark.quote ?? '', 4000) || (mark.kind === 'note' && !mark.body.trim()) || (mark.kind === 'highlight' && (!(mark.quote ?? '').trim() || !['yellow', 'green', 'blue', 'pink', 'purple'].includes(mark.color)))) throw new Error(`第 ${index + 1} 条记录的正文、摘录或颜色无效。`)
    const hash = Array.from(sha256(new TextEncoder().encode(`${fileHash}:${index}`)), byte => byte.toString(16).padStart(2, '0')).join('')
    const operationId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
    return { operationId, bookFileId: id, bookTitle: mark.bookTitle ?? (typeof book?.title === 'string' ? book.title : undefined), bookFormat: mark.bookFormat ?? (typeof book?.format === 'string' ? book.format : undefined), mark: {
      id: 0, bookFileId: id, kind: mark.kind, position: mark.position, overallProgress: mark.overallProgress,
      label: mark.label, body: mark.body, quote: mark.quote ?? '', color: mark.color ?? '',
      createdAt: '1970-01-01T00:00:00Z', updatedAt: '1970-01-01T00:00:00Z',
    } }
  })
}

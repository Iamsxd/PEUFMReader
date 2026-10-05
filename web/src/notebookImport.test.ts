import { describe, expect, it } from 'vitest'
import { parseNotebookImport } from './notebookImport'
const mark = { bookFileId: 7, kind: 'note', position: { pageIndex: 1 }, overallProgress: 0.3, label: '第 2 页', body: '原创笔记', bookTitle: '原创样本', bookFormat: 'pdf' }
describe('notebook import validation', () => {
  it('creates stable retry IDs and strips notebook-only fields from the wire mark', () => {
    const text = JSON.stringify({ version: 1, items: [mark, mark] })
    const items = parseNotebookImport(text)
    expect(items).toEqual(parseNotebookImport(text))
    expect(items[0].operationId).not.toBe(items[1].operationId)
    expect(items[0].mark).not.toHaveProperty('bookTitle')
    expect(items[0].bookTitle).toBe('原创样本')
  })
  it('accepts single-book exports and defaults optional legacy quote fields', () => {
    const result = parseNotebookImport(JSON.stringify({ book: { id: 7, title: '原创样本', format: 'pdf' }, items: [{ ...mark, bookFileId: undefined, bookTitle: undefined, bookFormat: undefined }] }))
    expect(result[0].bookFileId).toBe(7)
    expect(result[0].mark.quote).toBe('')
  })
  it('rejects oversized, empty, invalid and incomplete highlight records', () => {
    for (const value of [{ items: [] }, { items: Array(201).fill(mark) }, { items: [{ ...mark, position: [] }] }, { items: [{ ...mark, kind: 'highlight' }] }, { items: [{ ...mark, body: '' }] }]) expect(() => parseNotebookImport(JSON.stringify(value))).toThrow()
    expect(() => parseNotebookImport('x'.repeat(2 * 1024 * 1024 + 1))).toThrow()
  })
})

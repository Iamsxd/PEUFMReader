import { afterEach, expect, it, vi } from 'vitest'
import { downloadNotebookBlob } from './notebookDownload'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('starts an attachment download and defers URL cleanup for Safari', () => {
  vi.useFakeTimers()
  const link = { href: '', download: '', click: vi.fn(), remove: vi.fn() }
  const append = vi.fn()
  vi.stubGlobal('document', { createElement: vi.fn(() => link), body: { append } })
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-export')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const blob = new Blob(['original test notes'], { type: 'text/markdown' })
  downloadNotebookBlob(blob, 'notebook.md')
  expect(create).toHaveBeenCalledWith(blob)
  expect(link.download).toBe('notebook.md')
  expect(link.href).toBe('blob:synthetic-export')
  expect(append).toHaveBeenCalledWith(link)
  expect(link.click).toHaveBeenCalledOnce()
  expect(link.remove).toHaveBeenCalledOnce()
  expect(revoke).not.toHaveBeenCalled()
  vi.advanceTimersByTime(59_999)
  expect(revoke).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(revoke).toHaveBeenCalledWith('blob:synthetic-export')
})

it('also cleans up when the browser refuses to start the download', () => {
  vi.useFakeTimers()
  const link = { href: '', download: '', click: vi.fn(() => { throw new Error('synthetic refusal') }), remove: vi.fn() }
  vi.stubGlobal('document', { createElement: () => link, body: { append: vi.fn() } })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:refused-export')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  expect(() => downloadNotebookBlob(new Blob(['notes']), 'notebook.json')).toThrow('synthetic refusal')
  expect(link.remove).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(60_000)
  expect(revoke).toHaveBeenCalledWith('blob:refused-export')
})

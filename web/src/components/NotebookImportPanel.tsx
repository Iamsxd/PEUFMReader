import { useRef, useState } from 'react'
import { api } from '../api'
import { parseNotebookImport, type NotebookImportItem } from '../notebookImport'
import { useDraftGuard } from '../draftGuard'

export function NotebookImportPanel({ onImported }: { onImported: () => void }) {
  const [items, setItems] = useState<NotebookImportItem[]>([])
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const run = useRef(0)
  const previewAccount = useRef(0)
  useDraftGuard(busy, '正在导入笔记')
  async function preview(file?: File) {
    if (!file || locked.current) return
    const revision = ++run.current
    setItems([]); setError(''); setStatus('正在校验书籍归属…')
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('文件超过 2 MiB。')
      const identity = await api.me()
      const next = parseNotebookImport(await file.text())
      for (const id of new Set(next.map(item => item.bookFileId))) {
        const detail = await api.getBookDetail(id)
        const group = next.filter(item => item.bookFileId === id)
        if (group.some(item => item.bookTitle && item.bookTitle !== detail.book.title || item.bookFormat && item.bookFormat !== detail.book.format)) throw new Error(`书籍 ID ${id} 与本机书名或格式不一致。跨书库迁移需先建立书籍映射，未导入任何记录。`)
        for (const item of group) { item.bookTitle = detail.book.title; item.bookFormat = detail.book.format }
      }
      if (revision !== run.current) return
      previewAccount.current = identity.user.id
      setItems(next); setStatus(`校验完成：${next.length} 条记录。只导入到当前账号，不覆盖已有记录。同一文件重试不会重复创建。`)
    } catch (reason) {
      if (revision === run.current) { setError(reason instanceof Error ? reason.message : '文件校验失败。'); setStatus('') }
    }
  }
  async function submit() {
    if (locked.current || !items.length) return
    locked.current = true; setBusy(true); setError('')
    let completed = 0
    try {
      for (const item of items) {
        await api.syncReadingMark({ accountId: previewAccount.current, operationId: item.operationId, bookFileId: item.bookFileId, mark: item.mark, action: 'create', markId: 0 })
        completed += 1
        setStatus(`已处理 ${completed} / ${items.length} 条`)
      }
      setStatus(`已处理 ${completed} 条笔记。重复导入沿用此前记录。`); setItems([]); onImported()
    } catch (reason) {
      setError(`已处理 ${completed} 条，其余未完成。可重试原文件，不会重复创建已成功项。${reason instanceof Error ? reason.message : ''}`)
    } finally { locked.current = false; setBusy(false) }
  }
  return <details className="notebook-import-panel"><summary>导入 JSON 笔记</summary>
    <p>支持本应用导出的 JSON（最多 200 条／2 MiB）。先核对书名和定位，再确认导入；不会修改书籍文件。</p>
    <input type="file" accept=".json,application/json" aria-label="选择笔记 JSON 文件" disabled={busy} onChange={event => { void preview(event.target.files?.[0]); event.target.value = '' }} />
    {status && <p role="status">{status}</p>}{error && <p className="notice error" role="alert">{error}</p>}
    {!!items.length && <><ul>{[...new Set(items.map(item => item.bookTitle))].map(title => <li key={title}>{title}</li>)}</ul><button className="primary" disabled={busy} onClick={() => void submit()}>{busy ? '导入中…' : '确认导入到我的笔记'}</button></>}
  </details>
}

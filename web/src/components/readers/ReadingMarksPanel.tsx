import { useEffect, useState } from 'react'
import { api } from '../../api'
import { removeReadingMark, upsertReadingMark, type ReadingMarkLocation } from '../../readingMarks'
import type { ReadingMark, ReadingMarkInput } from '../../types'

interface Props {
  bookFileID: number
  current: ReadingMarkLocation
  onNavigate: (position: Record<string, unknown>) => void
  onClose: () => void
  onChromeActivity: () => void
}

export function ReadingMarksPanel({ bookFileID, current, onNavigate, onClose, onChromeActivity }: Props) {
  const [marks, setMarks] = useState<ReadingMark[]>([])
  const [noteBody, setNoteBody] = useState('')
  const [editingID, setEditingID] = useState<number | null>(null)
  const [editingBody, setEditingBody] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError('')
    void api.listReadingMarks(bookFileID).then((items) => {
      if (!disposed) setMarks(items)
    }).catch(() => {
      if (!disposed) setError('书签和笔记加载失败，请稍后重试。')
    }).finally(() => {
      if (!disposed) setLoading(false)
    })
    return () => { disposed = true }
  }, [bookFileID])

  async function createMark(kind: ReadingMarkInput['kind']) {
    const body = kind === 'note' ? noteBody.trim() : ''
    if (kind === 'note' && !body) return
    setBusy(`create-${kind}`)
    setError('')
    try {
      const mark = await api.createReadingMark(bookFileID, { kind, ...current, body })
      setMarks((items) => upsertReadingMark(items, mark))
      if (kind === 'note') setNoteBody('')
    } catch {
      setError(kind === 'bookmark' ? '添加书签失败。' : '添加笔记失败。')
    } finally {
      setBusy('')
    }
  }

  function beginEditing(mark: ReadingMark) {
    setEditingID(mark.id)
    setEditingBody(mark.body)
  }

  async function saveEdit(mark: ReadingMark) {
    const body = editingBody.trim()
    if (!body) return
    setBusy(`edit-${mark.id}`)
    setError('')
    try {
      const updated = await api.updateReadingMark(mark.id, { label: mark.label, body })
      setMarks((items) => upsertReadingMark(items, updated))
      setEditingID(null)
      setEditingBody('')
    } catch {
      setError('笔记保存失败。')
    } finally {
      setBusy('')
    }
  }

  async function deleteMark(mark: ReadingMark) {
    if (!window.confirm(`删除这条${mark.kind === 'bookmark' ? '书签' : '笔记'}？`)) return
    setBusy(`delete-${mark.id}`)
    setError('')
    try {
      await api.deleteReadingMark(mark.id)
      setMarks((items) => removeReadingMark(items, mark.id))
      if (editingID === mark.id) setEditingID(null)
    } catch {
      setError('删除失败。')
    } finally {
      setBusy('')
    }
  }

  return (
    <aside className="reader-side-panel reading-marks-panel" aria-label="书签和笔记" onPointerDown={onChromeActivity}>
      <header>
        <strong>书签与笔记</strong>
        <button onClick={onClose} aria-label="关闭侧栏">×</button>
      </header>
      <div className="reading-mark-create">
        <div className="reading-mark-current">
          <span>当前位置</span>
          <strong>{current.label}</strong>
        </div>
        <button className="reading-mark-bookmark" disabled={Boolean(busy)} onClick={() => void createMark('bookmark')}>
          {busy === 'create-bookmark' ? '添加中…' : '＋ 添加书签'}
        </button>
        <textarea
          value={noteBody}
          onChange={(event) => setNoteBody(event.target.value)}
          maxLength={10000}
          rows={3}
          placeholder="记录此处的想法…"
          aria-label="新笔记内容"
        />
        <button disabled={Boolean(busy) || !noteBody.trim()} onClick={() => void createMark('note')}>
          {busy === 'create-note' ? '保存中…' : '保存笔记'}
        </button>
        {error && <p className="reader-panel-error" role="alert">{error}</p>}
      </div>
      <div className="reading-mark-list">
        {loading && <p className="reader-panel-empty">正在加载…</p>}
        {!loading && marks.length === 0 && <p className="reader-panel-empty">还没有书签或笔记。</p>}
        {marks.map((mark) => (
          <article key={mark.id} className={`reading-mark-item ${mark.kind}`}>
            <header>
              <button className="reading-mark-location" onClick={() => onNavigate(mark.position)}>
                <span>{mark.kind === 'bookmark' ? '书签' : '笔记'} · {Math.round(mark.overallProgress * 100)}%</span>
                <strong>{mark.label}</strong>
              </button>
              <button className="reading-mark-delete" disabled={Boolean(busy)} onClick={() => void deleteMark(mark)} aria-label={`删除${mark.label}`}>×</button>
            </header>
            {mark.kind === 'note' && editingID === mark.id ? (
              <div className="reading-mark-edit">
                <textarea value={editingBody} onChange={(event) => setEditingBody(event.target.value)} maxLength={10000} rows={4} aria-label="编辑笔记内容" />
                <div>
                  <button onClick={() => { setEditingID(null); setEditingBody('') }}>取消</button>
                  <button disabled={busy === `edit-${mark.id}` || !editingBody.trim()} onClick={() => void saveEdit(mark)}>保存</button>
                </div>
              </div>
            ) : mark.kind === 'note' ? (
              <button className="reading-mark-body" onClick={() => beginEditing(mark)} title="点击编辑笔记">{mark.body}</button>
            ) : null}
          </article>
        ))}
      </div>
    </aside>
  )
}

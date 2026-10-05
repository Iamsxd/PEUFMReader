import { useEffect, useState } from 'react'
import { api } from '../../api'
import { cachedReadingMarks, createLocalReadingMark, deleteLocalReadingMark, discardConflictingMarks, exportLocalMarks, loadReadingMarks, OFFLINE_MARKS_EVENT, pendingMarkStatus, syncOfflineMarks, updateLocalReadingMark } from '../../offlineMarks'
import { downloadNotebookBlob } from '../../notebookDownload'
import { confirmLeaveDrafts, useDraftGuard } from '../../draftGuard'
import { highlightColorLabels, markKindLabel, removeReadingMark, upsertReadingMark, type ReadingMarkLocation } from '../../readingMarks'
import type { ReadingMark, ReadingMarkInput } from '../../types'

interface Props {
  bookFileID: number
  userID: number
  offlineMode: boolean
  initialEditingID?: number
  current: ReadingMarkLocation
  onNavigate: (position: Record<string, unknown>) => void
  onClose: () => void
  onChromeActivity: () => void
  onMarksChange?: (marks: ReadingMark[]) => void
}

export function ReadingMarksPanel({ bookFileID, userID, offlineMode, initialEditingID, current, onNavigate, onClose, onChromeActivity, onMarksChange }: Props) {
  const [marks, setMarks] = useState<ReadingMark[]>([])
  const [noteBody, setNoteBody] = useState('')
  const [editingID, setEditingID] = useState<number | null>(null)
  const [editingBody, setEditingBody] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('')
  const [color, setColor] = useState('')
  const [syncStatus, setSyncStatus] = useState(() => pendingMarkStatus(userID, bookFileID))
  const visibleMarks = marks.filter(mark => (!kind || mark.kind === kind) && (!color || mark.color === color) && `${mark.label}\n${mark.body}\n${mark.quote}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const dirty = Boolean(noteBody.trim() || (editingID !== null && editingBody !== marks.find(mark => mark.id === editingID)?.body))
  useDraftGuard(dirty)

  function closePanel() {
    if (!dirty || window.confirm('批注有未保存的内容，确定放弃吗？')) onClose()
  }

  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError('')
    const updateCache = () => {
      if (disposed) return
      const items = cachedReadingMarks(userID, bookFileID)
      setMarks(items)
      setSyncStatus(pendingMarkStatus(userID, bookFileID))
      onMarksChange?.(items)
    }
    window.addEventListener(OFFLINE_MARKS_EVENT, updateCache)
    void loadReadingMarks(userID, bookFileID, offlineMode).then((items) => {
      if (!disposed) {
        setMarks(items)
        onMarksChange?.(items)
      }
    }).catch(() => {
      if (!disposed) setError('书签和笔记加载失败，请稍后重试。')
    }).finally(() => {
      if (!disposed) setLoading(false)
    })
    return () => { disposed = true; window.removeEventListener(OFFLINE_MARKS_EVENT, updateCache) }
  }, [bookFileID, offlineMode, onMarksChange, userID])

  useEffect(() => {
    if (initialEditingID === undefined) return
    const mark = marks.find(item => item.id === initialEditingID)
    if (!mark) return
    setEditingID(mark.id)
    setEditingBody(mark.body)
    setQuery(''); setKind(''); setColor('')
  }, [initialEditingID, loading])

  function publishMarks(update: (items: ReadingMark[]) => ReadingMark[]) {
    setMarks((items) => {
      const next = update(items)
      onMarksChange?.(next)
      return next
    })
  }

  async function createMark(kind: ReadingMarkInput['kind']) {
    const body = kind === 'note' ? noteBody.trim() : ''
    if (kind === 'note' && !body) return
    setBusy(`create-${kind}`)
    setError('')
    try {
      const mark = await createLocalReadingMark(userID, bookFileID, { kind, ...current, body }, offlineMode)
      publishMarks((items) => upsertReadingMark(items, mark))
      if (kind === 'note') setNoteBody('')
    } catch {
      setError(kind === 'bookmark' ? '添加书签失败。' : '添加笔记失败。')
    } finally {
      setBusy('')
    }
  }

  function beginEditing(mark: ReadingMark) {
    if (!confirmLeaveDrafts()) return
    setNoteBody('')
    setEditingID(mark.id)
    setEditingBody(mark.body)
  }

  async function saveEdit(mark: ReadingMark) {
    const body = editingBody.trim()
    if (mark.kind === 'note' && !body) return
    setBusy(`edit-${mark.id}`)
    setError('')
    try {
      const updated = await updateLocalReadingMark(userID, mark, { label: mark.label, body, color: mark.color }, offlineMode)
      publishMarks((items) => upsertReadingMark(items, updated))
      setEditingID(null)
      setEditingBody('')
    } catch {
      setError('笔记保存失败。')
    } finally {
      setBusy('')
    }
  }

  async function deleteMark(mark: ReadingMark) {
    if (!window.confirm(`删除这条${markKindLabel(mark.kind)}？`)) return
    setBusy(`delete-${mark.id}`)
    setError('')
    try {
      await deleteLocalReadingMark(userID, mark, offlineMode)
      publishMarks((items) => removeReadingMark(items, mark.id))
      if (editingID === mark.id) setEditingID(null)
    } catch {
      setError('删除失败。')
    } finally {
      setBusy('')
    }
  }

  return (
    <aside className="reader-side-panel reading-marks-panel" aria-label="书签、高亮和笔记" onPointerDown={onChromeActivity}>
      <header>
        <strong>书签、高亮与笔记</strong>
        <button onClick={closePanel} aria-label="关闭侧栏">×</button>
      </header>
      <div className="reading-mark-sync-status" role="status">
        <small>{offlineMode ? '离线批注保存在此账号的设备缓存，联网后同步。' : syncStatus.pending ? `${syncStatus.pending} 项待同步` : '批注已同步'}</small>
        {syncStatus.pending > 0 && <button disabled={offlineMode || Boolean(busy)} onClick={() => void syncOfflineMarks(userID)}>重试同步</button>}
        <button onClick={() => downloadNotebookBlob(exportLocalMarks(userID, bookFileID), 'device-notes.json')}>导出设备草稿</button>
        {syncStatus.problems.map(problem => <p className="reader-panel-error" key={problem}>{problem}</p>)}
        {syncStatus.problems.length > 0 && <button disabled={offlineMode || Boolean(busy)} onClick={() => {
          if (window.confirm('放弃本书冲突的本地草稿并读取服务器版本？建议先导出设备草稿。')) void discardConflictingMarks(userID, bookFileID).catch(() => setError('读取服务器版本失败。'))
        }}>放弃冲突草稿，读取服务器版本</button>}
      </div>
      <div className="reading-mark-create">
        <div className="reading-mark-current">
          <span>当前位置</span>
          <strong>{current.label}</strong>
        </div>
        <button className="reading-mark-bookmark" disabled={Boolean(busy)} onClick={() => void createMark('bookmark')}>
          {busy === 'create-bookmark' ? '添加中…' : '＋ 添加书签'}
        </button>
        {!offlineMode && <div className="reading-mark-export" aria-label="导出阅读批注">
          <span>导出</span>
          <a href={api.readingMarksExportURL(bookFileID, 'markdown')} download>Markdown</a>
          <a href={api.readingMarksExportURL(bookFileID, 'json')} download>JSON</a>
        </div>}
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
        <div className="reading-mark-filters"><input aria-label="搜索本书批注" placeholder="搜索摘录或笔记…" value={query} onChange={event => setQuery(event.target.value)} maxLength={200} /><select aria-label="本书记录类型" value={kind} onChange={event => setKind(event.target.value)}><option value="">所有类型</option><option value="highlight">高亮</option><option value="note">笔记</option><option value="bookmark">书签</option></select><select aria-label="本书高亮颜色" value={color} onChange={event => setColor(event.target.value)}><option value="">所有颜色</option>{Object.entries(highlightColorLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><small>{visibleMarks.length} / {marks.length} 条记录</small></div>
        {loading && <p className="reader-panel-empty">正在加载…</p>}
        {!loading && marks.length === 0 && <p className="reader-panel-empty">还没有书签、高亮或笔记。</p>}
        {!loading && marks.length > 0 && visibleMarks.length === 0 && <p className="reader-panel-empty">没有符合筛选条件的批注。</p>}
        {visibleMarks.map((mark) => (
          <article key={mark.id} className={`reading-mark-item ${mark.kind}`}>
            <header>
              <button className="reading-mark-location" onClick={() => { if (confirmLeaveDrafts()) onNavigate(mark.position) }}>
                <span>{markKindLabel(mark.kind)} · {Math.round(mark.overallProgress * 100)}%</span>
                <strong>{mark.label}</strong>
              </button>
              <button className="reading-mark-delete" disabled={Boolean(busy)} onClick={() => void deleteMark(mark)} aria-label={`删除${mark.label}`}>×</button>
            </header>
            {mark.kind === 'highlight' && <blockquote className={`reading-highlight-quote ${mark.color}`}>{mark.quote}</blockquote>}
            {(mark.kind === 'note' || mark.kind === 'highlight') && editingID === mark.id ? (
              <div className="reading-mark-edit">
                <textarea value={editingBody} onChange={(event) => setEditingBody(event.target.value)} maxLength={10000} rows={4} placeholder={mark.kind === 'highlight' ? '添加高亮批注（可选）' : ''} aria-label="编辑批注内容" />
                <div>
                  <button onClick={() => { if (confirmLeaveDrafts()) { setEditingID(null); setEditingBody('') } }}>取消</button>
                  <button disabled={busy === `edit-${mark.id}` || (mark.kind === 'note' && !editingBody.trim())} onClick={() => void saveEdit(mark)}>保存</button>
                </div>
              </div>
            ) : mark.kind === 'note' || mark.kind === 'highlight' ? (
              <button className="reading-mark-body" onClick={() => beginEditing(mark)} title="点击编辑批注">{mark.body || '添加批注'}</button>
            ) : null}
          </article>
        ))}
      </div>
    </aside>
  )
}

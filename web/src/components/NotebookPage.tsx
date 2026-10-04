import { type FormEvent, useEffect, useRef, useState } from 'react'
import { api, APIError } from '../api'
import type { BookFile, NotebookEntry, NotebookPage as NotebookResult, NotebookQuery, ReadingMark } from '../types'
import { formatRelativeTime } from '../utils'
import { markKindLabel, highlightColorLabels } from '../readingMarks'
import { downloadNotebookBlob } from '../notebookDownload'

interface Props {
  bookID?: number
  onOpenBook: (book: BookFile, mark?: ReadingMark) => void
  onAllNotes: () => void
}

export function NotebookPage({ bookID, onOpenBook, onAllNotes }: Props) {
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState<NotebookQuery>({})
  const [result, setResult] = useState<NotebookResult | null>(null)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<NotebookEntry | null>(null)
  const [body, setBody] = useState('')
  const busyRef = useRef(false)
  const mountedRef = useRef(false)
  const requestedQueryRef = useRef('')
  const hasFilters = Boolean(query.q?.trim() || query.kind || query.color)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let disposed = false
    const requestKey = JSON.stringify({ ...query, bookId: bookID })
    setLoading(true)
    // A same-query refresh should not unmount an editor or erase its draft if loading fails.
    if (requestedQueryRef.current !== requestKey) setResult(null)
    requestedQueryRef.current = requestKey
    setLoadError('')
    void api
      .searchNotebook({ ...query, bookId: bookID })
      .then((next) => {
        if (!disposed) {
          setResult(next)
          setLoading(false)
        }
      })
      .catch((reason) => {
        if (!disposed) {
          setLoadError(reason instanceof APIError ? reason.message : '笔记加载失败，请重试。')
          setLoading(false)
        }
      })
    return () => {
      disposed = true
    }
  }, [bookID, query, revision])

  async function perform<T>(action: () => Promise<T>, onSuccess: (value: T) => void, message = '') {
    if (busyRef.current || loading) return
    busyRef.current = true
    setBusy(true)
    setActionError('')
    setFeedback('')
    try {
      const value = await action()
      if (mountedRef.current) {
        onSuccess(value)
        setFeedback(message)
      }
    } catch (reason) {
      if (mountedRef.current) {
        setActionError(reason instanceof Error ? reason.message : '操作失败，请重试。')
      }
    } finally {
      busyRef.current = false
      if (mountedRef.current) setBusy(false)
    }
  }

  function canLeaveEditor() {
    if (busyRef.current) return false
    if (editing && body !== editing.body && !window.confirm('批注有未保存的修改，确定放弃吗？')) return false
    return true
  }

  function leaveEditor() {
    if (!canLeaveEditor()) return false
    setEditing(null)
    setActionError('')
    setFeedback('')
    return true
  }

  function search(event: FormEvent) {
    event.preventDefault()
    if (!leaveEditor()) return
    setQuery((current) => ({ ...current, q: draft.trim(), page: 1 }))
  }

  function clearFilters() {
    if (!leaveEditor()) return
    setDraft('')
    setQuery({})
  }

  function exportNotes(format: 'markdown' | 'json') {
    void perform(
      () => api.exportNotebook({ q: query.q, kind: query.kind, color: query.color, bookId: bookID }, format),
      ({ blob, filename }) => downloadNotebookBlob(blob, filename),
      '笔记导出已开始下载。文件包含全部符合已提交筛选的记录，而非仅当前页。',
    )
  }

  async function remove(mark: NotebookEntry) {
    if (busyRef.current) return
    if (!window.confirm(`删除这条${markKindLabel(mark.kind)}？书籍不会被删除。`)) return
    if (editing && editing.id !== mark.id && !canLeaveEditor()) return
    await perform(
      () => api.deleteReadingMark(mark.id),
      () => {
        setQuery((current) => ({ ...current, page: 1 }))
        setRevision((value) => value + 1)
        setEditing(null)
      },
      `${markKindLabel(mark.kind)}已删除。`,
    )
  }

  return (
    <div className="personal-workspace notebook-page">
      <section className="page-heading">
        <div>
          <p className="eyebrow">阅读留下的痕迹</p>
          <h1>我的笔记</h1>
          <p className="muted">跨书回顾高亮、想法与书签。只有你能看到这些记录。</p>
        </div>
        <strong>{result?.total ?? '—'} 条记录</strong>
      </section>
      {bookID && (
        <div className="workspace-scope">
          <span>正在查看单本书的记录</span>
          <button
            className="quiet"
            disabled={busy}
            onClick={() => {
              if (leaveEditor()) onAllNotes()
            }}
          >
            查看全部笔记
          </button>
          <a href={api.readingMarksExportURL(bookID, 'markdown')} download>
            导出本书 Markdown
          </a>
        </div>
      )}
      <form className="personal-filters" onSubmit={search}>
        <label className="personal-search">
          <span className="sr-only">搜索笔记</span>
          <input
            aria-label="搜索笔记"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={busy}
            maxLength={200}
            placeholder="搜索书名、摘录或想法…"
          />
          <button className="primary" disabled={busy}>
            搜索
          </button>
        </label>
        <select
          aria-label="记录类型"
          value={query.kind ?? ''}
          disabled={busy}
          onChange={(event) => {
            if (!leaveEditor()) return
            setQuery((current) => ({
              ...current,
              kind: event.target.value as NotebookQuery['kind'],
              page: 1,
            }))
          }}
        >
          <option value="">所有类型</option>
          <option value="highlight">高亮</option>
          <option value="note">笔记</option>
          <option value="bookmark">书签</option>
        </select>
        <select
          aria-label="高亮颜色"
          value={query.color ?? ''}
          disabled={busy}
          onChange={(event) => {
            if (!leaveEditor()) return
            setQuery((current) => ({
              ...current,
              color: event.target.value as NotebookQuery['color'],
              page: 1,
            }))
          }}
        >
          <option value="">所有颜色</option>
          {Object.entries(highlightColorLabels).map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
        {hasFilters && (
          <button type="button" className="quiet" disabled={busy} onClick={clearFilters}>
            清空筛选
          </button>
        )}
      </form>
      <section className="workspace-scope notebook-export" aria-label="笔记导出">
        <div>
          <strong>导出{bookID ? '本书' : '跨书'}笔记</strong>
          <p className="muted">
            按当前已提交的搜索、类型和颜色筛选，导出全部 {result?.total ?? '—'} 条记录，不限当前页。
            搜索框内尚未提交的文字不会影响导出。单次最多 5000 条或 16 MiB，请妥善保管私人笔记文件。
          </p>
        </div>
        <div className="personal-actions">
          <button className="secondary" disabled={busy || loading || !!loadError || !result || result.total === 0} onClick={() => exportNotes('markdown')}>
            导出 Markdown
          </button>
          <button className="secondary" disabled={busy || loading || !!loadError || !result || result.total === 0} onClick={() => exportNotes('json')}>
            导出 JSON
          </button>
        </div>
      </section>
      <div className={feedback ? 'workspace-feedback' : 'sr-only'} role="status" aria-live="polite" aria-atomic="true">
        {feedback}
      </div>
      {actionError && (
        <div className="notice error" role="alert">
          {actionError} 请检查后重新执行。{editing && '未保存的编辑内容仍保留在下方。'}
        </div>
      )}
      {loadError && (
        <div className="notice error" role="alert">
          {loadError}{' '}
          <button className="quiet" disabled={busy} onClick={() => setRevision((value) => value + 1)}>
            重试加载
          </button>
        </div>
      )}
      {loading ? (
        <p role="status">正在整理你的阅读记录…</p>
      ) : !loadError && result?.items.length === 0 ? (
        <section className="empty-state">
          <h2>{hasFilters ? '还没有符合条件的记录' : '还没有阅读记录'}</h2>
          <p>
            {hasFilters
              ? '试试其他关键词、记录类型或颜色，也可以清空筛选查看全部记录。'
              : '阅读时添加高亮、笔记或书签，它们会出现在这里。'}
          </p>
        </section>
      ) : null}
      {result && (
        <div className="notebook-grid" aria-busy={loading || busy}>
          {result?.items.map((mark) => (
            <article className="notebook-card" key={mark.id}>
              <header>
                <span className={`mark-type-dot ${mark.color || mark.kind}`} aria-hidden="true" />
                <span>
                  {markKindLabel(mark.kind)} · {mark.bookFormat.toUpperCase()}
                </span>
                <time dateTime={mark.updatedAt}>{formatRelativeTime(mark.updatedAt)}</time>
              </header>
              <h2>{mark.bookTitle}</h2>
              <p className="notebook-location">
                {mark.label} · {Math.round(mark.overallProgress * 100)}%
              </p>
              {mark.quote && <blockquote>{mark.quote}</blockquote>}
              {editing?.id === mark.id ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    void perform(
                      () => api.updateReadingMark(mark.id, {
                        label: mark.label,
                        body: body.trim(),
                        color: mark.color,
                      }),
                      () => {
                        setEditing(null)
                        setRevision((value) => value + 1)
                      },
                      '笔记已保存。',
                    )
                  }}
                >
                  <textarea
                    aria-label="编辑笔记内容"
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                    disabled={busy}
                    rows={4}
                    maxLength={10000}
                    autoFocus
                  />
                  <div className="personal-actions">
                    <button type="button" className="quiet" disabled={busy} onClick={leaveEditor}>
                      取消
                    </button>
                    <button className="primary" disabled={busy || loading || (mark.kind === 'note' && !body.trim())}>
                      保存笔记
                    </button>
                  </div>
                </form>
              ) : mark.body ? (
                <p className="notebook-body">{mark.body}</p>
              ) : null}
              <footer>
                <button
                  className="secondary"
                  disabled={busy || loading}
                  onClick={() => {
                    if (!canLeaveEditor()) return
                    void perform(
                      () => api.getBookDetail(mark.bookFileId),
                      (detail) => {
                        setEditing(null)
                        onOpenBook(detail.book, mark)
                      },
                    )
                  }}
                >
                  回到原文
                </button>
                {mark.kind !== 'bookmark' && (
                  <button
                    className="quiet"
                    disabled={busy || loading}
                    onClick={() => {
                      if (editing?.id === mark.id || !leaveEditor()) return
                      setEditing(mark)
                      setBody(mark.body)
                    }}
                  >
                    编辑批注
                  </button>
                )}
                <button className="quiet" disabled={busy || loading} onClick={() => void remove(mark)}>
                  删除
                </button>
              </footer>
            </article>
          ))}
        </div>
      )}
      {result && result.totalPages > 1 && (
        <nav className="personal-pagination" aria-label="笔记分页">
          <button
            className="secondary"
            disabled={busy || loading || result.page <= 1}
            onClick={() => {
              if (leaveEditor()) setQuery((current) => ({ ...current, page: result.page - 1 }))
            }}
          >
            上一页
          </button>
          <span>
            {result.page} / {result.totalPages}
          </span>
          <button
            className="secondary"
            disabled={busy || loading || result.page >= result.totalPages}
            onClick={() => {
              if (leaveEditor()) setQuery((current) => ({ ...current, page: result.page + 1 }))
            }}
          >
            下一页
          </button>
        </nav>
      )}
    </div>
  )
}

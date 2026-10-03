import { type FormEvent, useEffect, useState } from 'react'
import { api, APIError } from '../api'
import type { BookFile, NotebookEntry, NotebookPage as NotebookResult, NotebookQuery, ReadingMark } from '../types'
import { formatRelativeTime } from '../utils'
import { markKindLabel, highlightColorLabels } from '../readingMarks'

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
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<NotebookEntry | null>(null)
  const [body, setBody] = useState('')

  useEffect(() => {
    let disposed = false
    setLoading(true)
    setResult(null)
    setError('')
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
          setError(reason instanceof APIError ? reason.message : '笔记加载失败，请重试。')
          setLoading(false)
        }
      })
    return () => {
      disposed = true
    }
  }, [bookID, query, revision])

  async function perform(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败，请重试。')
    } finally {
      setBusy(false)
    }
  }

  function search(event: FormEvent) {
    event.preventDefault()
    setEditing(null)
    setQuery((current) => ({ ...current, q: draft.trim(), page: 1 }))
  }

  async function remove(mark: NotebookEntry) {
    if (!window.confirm(`删除这条${markKindLabel(mark.kind)}？书籍不会被删除。`)) return
    await perform(async () => {
      await api.deleteReadingMark(mark.id)
      setQuery((current) => ({ ...current, page: 1 }))
      setRevision((value) => value + 1)
      setEditing(null)
    })
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
          <button className="quiet" onClick={onAllNotes}>
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
            maxLength={200}
            placeholder="搜索书名、摘录或想法…"
          />
          <button className="primary">搜索</button>
        </label>
        <select
          aria-label="记录类型"
          value={query.kind ?? ''}
          onChange={(event) => {
            setEditing(null)
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
          onChange={(event) => {
            setEditing(null)
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
      </form>
      {error && (
        <div className="notice error" role="alert">
          {error}{' '}
          <button className="quiet" onClick={() => setRevision((value) => value + 1)}>
            重试加载
          </button>
        </div>
      )}
      {loading ? (
        <p role="status">正在整理你的阅读记录…</p>
      ) : !error && result?.items.length === 0 ? (
        <section className="empty-state">
          <h2>还没有符合条件的记录</h2>
          <p>阅读时添加高亮、笔记或书签，它们会出现在这里。</p>
        </section>
      ) : null}
      {!loading && result && (
        <div className="notebook-grid">
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
                    void perform(async () => {
                      await api.updateReadingMark(mark.id, {
                        label: mark.label,
                        body: body.trim(),
                        color: mark.color,
                      })
                      setEditing(null)
                      setRevision((value) => value + 1)
                    })
                  }}
                >
                  <textarea
                    aria-label="编辑笔记内容"
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                    rows={4}
                    maxLength={10000}
                    autoFocus
                  />
                  <div className="personal-actions">
                    <button type="button" className="quiet" disabled={busy} onClick={() => setEditing(null)}>
                      取消
                    </button>
                    <button className="primary" disabled={busy || (mark.kind === 'note' && !body.trim())}>
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
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      const detail = await api.getBookDetail(mark.bookFileId)
                      onOpenBook(detail.book, mark)
                    })
                  }
                >
                  回到原文
                </button>
                {mark.kind !== 'bookmark' && (
                  <button
                    className="quiet"
                    disabled={busy}
                    onClick={() => {
                      setEditing(mark)
                      setBody(mark.body)
                    }}
                  >
                    编辑批注
                  </button>
                )}
                <button className="quiet" disabled={busy} onClick={() => void remove(mark)}>
                  删除
                </button>
              </footer>
            </article>
          ))}
        </div>
      )}
      {!loading && result && result.totalPages > 1 && (
        <nav className="personal-pagination" aria-label="笔记分页">
          <button
            className="secondary"
            disabled={result.page <= 1}
            onClick={() => setQuery((current) => ({ ...current, page: result.page - 1 }))}
          >
            上一页
          </button>
          <span>
            {result.page} / {result.totalPages}
          </span>
          <button
            className="secondary"
            disabled={result.page >= result.totalPages}
            onClick={() => setQuery((current) => ({ ...current, page: result.page + 1 }))}
          >
            下一页
          </button>
        </nav>
      )}
    </div>
  )
}

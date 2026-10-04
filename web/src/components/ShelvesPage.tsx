import { type FormEvent, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { BookFile, CatalogPage, PersonalShelf } from '../types'
import { BookCover } from './BookCover'
import { ShelfBookPicker } from './ShelfBookPicker'

interface Props {
  selectedID?: number
  onSelect: (id: number | undefined) => void
  onOpenBook: (book: BookFile) => void
  onViewBook: (book: BookFile) => void
}

export function ShelvesPage({ selectedID, onSelect, onOpenBook, onViewBook }: Props) {
  const [shelves, setShelves] = useState<PersonalShelf[]>([])
  const [result, setResult] = useState<CatalogPage | null>(null)
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [undo, setUndo] = useState<{ shelfID: number; book: BookFile } | null>(null)
  const [loadedScope, setLoadedScope] = useState<{ id?: number; page: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<{
    id?: number
    name: string
    description: string
  } | null>(null)
  const busyRef = useRef(false)
  const mounted = useRef(false)
  const scope = useRef(selectedID)
  scope.current = selectedID
  const selected = shelves.find((shelf) => shelf.id === selectedID)
  const pending = busy || loading || !!loadError
  const showContent = selected && loadedScope?.id === selectedID
  const shelfResult = loadedScope?.id === selectedID && loadedScope?.page === page ? result : null

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let disposed = false
    setLoading(true)
    setLoadError('')
    void Promise.all([api.listShelves(), selectedID ? api.shelfBooks(selectedID, page) : Promise.resolve(null)])
      .then(([items, books]) => {
        if (disposed) return
        setShelves(items)
        setResult(books)
        setLoadedScope({ id: selectedID, page })
        setLoading(false)
        if (books && books.page > Math.max(1, books.totalPages)) setPage(Math.max(1, books.totalPages))
      })
      .catch((reason) => {
        if (!disposed) {
          setLoading(false)
          setLoadError(reason instanceof Error ? reason.message : '书架加载失败。')
        }
      })
    return () => {
      disposed = true
    }
  }, [selectedID, page, revision])

  useEffect(() => {
    setPage(1)
    setForm(null)
    setUndo(null)
    setError('')
  }, [selectedID])

  async function perform<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (busyRef.current || loading || loadError) return
    const actionScope = selectedID
    busyRef.current = true
    setBusy(true)
    setError('')
    setFeedback('')
    try {
      return await action()
    } catch (reason) {
      if (mounted.current && scope.current === actionScope) setError(reason instanceof Error ? reason.message : '操作失败，请重试。')
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }
  function refresh() {
    setRevision((value) => value + 1)
  }
  function save(event: FormEvent) {
    event.preventDefault()
    if (!form) return
    void perform(async () => {
      const next = await api.saveShelf(form.name.trim(), form.description.trim(), form.id)
      if (!mounted.current || scope.current !== selectedID) return
      setFeedback(form.id ? '书架已保存。' : '书架已创建。')
      setForm(null)
      setPage(1)
      onSelect(next.id)
      refresh()
    })
  }

  return (
    <div className="personal-workspace shelves-page">
      <section className="page-heading">
        <div>
          <p className="eyebrow">按自己的方式读</p>
          <h1>我的书架</h1>
          <p className="muted">创建专题书架，排列阅读顺序。书架仅对你可见，不会复制书籍文件。</p>
        </div>
        <button className="primary" disabled={pending} onClick={() => setForm({ name: '', description: '' })}>
          ＋ 新建书架
        </button>
      </section>
      <div className={feedback || undo ? 'workspace-feedback' : 'sr-only'} role="status" aria-live="polite" aria-atomic="true">
        {feedback && <span>{feedback}</span>}
        {undo && <button className="quiet" disabled={pending} onClick={() => void perform(async () => {
          await api.setShelfBook(undo.shelfID, undo.book.id, true)
          if (!mounted.current || scope.current !== undo.shelfID) return
          setFeedback(`已将《${undo.book.title}》重新加入书架末尾。`)
          setUndo(null)
          refresh()
        })}>撤销移除（加入末尾）</button>}
      </div>
      {error && <div className="notice error" role="alert">{error} 请重试原操作；当前页面不会自动重复提交。</div>}
      {loadError && (
        <div className="notice error" role="alert">
          {loadError}{' '}
          <button className="quiet" disabled={busy} onClick={refresh}>
            重试加载
          </button>
        </div>
      )}
      {form && (
        <form className="shelf-editor" onSubmit={save}>
          <h2>{form.id ? '编辑书架' : '新建书架'}</h2>
          <label>
            书架名称
            <input
              value={form.name}
              disabled={busy}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              required
              maxLength={80}
              autoFocus
              placeholder="例如：今年想读、科幻入门…"
            />
          </label>
          <label>
            书架说明
            <textarea
              value={form.description}
              disabled={busy}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              maxLength={500}
              rows={2}
            />
          </label>
          <div className="personal-actions">
            <button type="button" className="quiet" disabled={busy} onClick={() => setForm(null)}>
              取消
            </button>
            <button className="primary" disabled={pending || !form.name.trim()}>
              保存书架
            </button>
          </div>
        </form>
      )}
      <div className="shelves-workspace">
        <nav className="shelf-navigation" aria-label="个人书架">
          {shelves.map((shelf) => (
            <button
              key={shelf.id}
              title={shelf.name}
              className={selectedID === shelf.id ? 'active' : ''}
              aria-current={selectedID === shelf.id ? 'page' : undefined}
              disabled={busy}
              onClick={() => {
                setPage(1)
                setFeedback('')
                onSelect(shelf.id)
              }}
            >
              <span>{shelf.name}</span>
              <small>{shelf.bookCount} 本</small>
            </button>
          ))}
        </nav>
        <section className="shelf-content">
          {loading && !showContent ? (
            <p role="status">正在打开书架…</p>
          ) : !selected ? (
            <section className="empty-state">
              <h2>{shelves.length ? '选择一个书架' : '你的第一份阅读清单'}</h2>
              <p>
                {shelves.length ? '从左侧选择书架，继续阅读或调整顺序。' : '把散落的好书收进一个专题，从下一本开始。'}
              </p>
            </section>
          ) : showContent ? (
            <>
              <header className="shelf-heading">
                <div>
                  <h2 title={selected.name}>{selected.name}</h2>
                  <p>{selected.description || `${shelfResult?.total ?? '—'} 本可阅读书籍 · 按你的阅读顺序排列`}</p>
                </div>
                <div className="personal-actions">
                  <button
                    className="quiet"
                    disabled={pending}
                    onClick={() =>
                      setForm({
                        id: selected.id,
                        name: selected.name,
                        description: selected.description,
                      })
                    }
                  >
                    编辑书架
                  </button>
                  <button
                    className="quiet"
                    disabled={pending}
                    onClick={() => {
                      if (window.confirm(`删除“${selected.name}”书架？不会删除书籍、进度或笔记。`))
                        void perform(async () => {
                          await api.deleteShelf(selected.id)
                          if (!mounted.current || scope.current !== selected.id) return
                          setFeedback('书架已删除，书籍、进度和笔记保持不变。')
                          onSelect(undefined)
                          refresh()
                        })
                    }}
                  >
                    删除书架
                  </button>
                </div>
              </header>
              <ShelfBookPicker key={selected.id} shelfID={selected.id} revision={revision} disabled={pending || !!loadError} onAdd={(books) => perform(async () => {
                const response = await api.addShelfBooks(selected.id, books.map((book) => book.id))
                if (!mounted.current || scope.current !== selected.id) return response
                setFeedback(`已添加 ${response.addedBookIds.length} 本书${response.alreadyPresentBookIds.length ? `，${response.alreadyPresentBookIds.length} 本已在书架，未重复添加` : ''}。`)
                setUndo(null)
                refresh()
                return response
              })} />
              {loading && <p role="status">正在更新书架…</p>}
              {shelfResult?.items.length === 0 && (
                <section className="empty-state">
                  <h3>书架里还没有可阅读的书</h3>
                  <p>从上方查找并添加，也可以在书籍详情页加入书架。</p>
                </section>
              )}
              <div className="shelf-reading-list">
                {shelfResult?.items.map((book, index) => (
                  <article className="shelf-book" key={book.id}>
                    <span className="shelf-order">{(page - 1) * shelfResult.pageSize + index + 1}</span>
                    <button
                      className="shelf-cover"
                      onClick={() => onViewBook(book)}
                      aria-label={`查看《${book.title}》详情`}
                    >
                      <BookCover book={book} />
                    </button>
                    <div className="shelf-book-info">
                      <h3>{book.title}</h3>
                      <p>
                        {book.authors.join('、') || '未知作者'} · {book.format.toUpperCase()}
                      </p>
                      <div className="personal-actions">
                        <button className="primary" onClick={() => onOpenBook(book)}>
                          阅读
                        </button>
                        <button className="quiet" onClick={() => onViewBook(book)}>
                          详情
                        </button>
                      </div>
                    </div>
                    <div className="shelf-order-actions">
                      <button
                        className="secondary"
                        aria-label={`将《${book.title}》提前`}
                        disabled={pending || (page === 1 && index === 0)}
                        onClick={() =>
                          void perform(async () => {
                            await api.moveShelfBook(selected.id, book.id, 'earlier')
                            if (!mounted.current || scope.current !== selected.id) return
                            setFeedback(`已将《${book.title}》提前。`)
                            refresh()
                          })
                        }
                      >
                        ↑
                      </button>
                      <button
                        className="secondary"
                        aria-label={`将《${book.title}》延后`}
                        disabled={pending || (page === shelfResult.totalPages && index === shelfResult.items.length - 1)}
                        onClick={() =>
                          void perform(async () => {
                            await api.moveShelfBook(selected.id, book.id, 'later')
                            if (!mounted.current || scope.current !== selected.id) return
                            setFeedback(`已将《${book.title}》延后。`)
                            refresh()
                          })
                        }
                      >
                        ↓
                      </button>
                      <button
                        className="quiet"
                        disabled={pending}
                        onClick={() => {
                          if (window.confirm(`从书架移除《${book.title}》？书籍和阅读记录保持不变。`))
                            void perform(async () => {
                              await api.setShelfBook(selected.id, book.id, false)
                              if (!mounted.current || scope.current !== selected.id) return
                              setFeedback(`已移除《${book.title}》。书籍、进度和笔记未删除。`)
                              setUndo({ shelfID: selected.id, book })
                              refresh()
                            })
                        }}
                      >
                        移除
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              {shelfResult && shelfResult.totalPages > 1 && (
                <nav className="personal-pagination" aria-label="书架分页">
                  <button
                    className="secondary"
                    disabled={page <= 1 || pending}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    上一页
                  </button>
                  <span>
                    {page} / {shelfResult.totalPages}
                  </span>
                  <button
                    className="secondary"
                    disabled={page >= shelfResult.totalPages || pending}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    下一页
                  </button>
                </nav>
              )}
            </>
          ) : null}
        </section>
      </div>
    </div>
  )
}

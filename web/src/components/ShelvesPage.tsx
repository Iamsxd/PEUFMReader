import { type FormEvent, useEffect, useState } from 'react'
import { api } from '../api'
import type { BookFile, CatalogPage, PersonalShelf } from '../types'
import { BookCover } from './BookCover'

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
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<{
    id?: number
    name: string
    description: string
  } | null>(null)
  const [search, setSearch] = useState('')
  const [candidates, setCandidates] = useState<BookFile[]>([])
  const [searched, setSearched] = useState(false)
  const selected = shelves.find((shelf) => shelf.id === selectedID)

  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError('')
    setResult(null)
    void Promise.all([api.listShelves(), selectedID ? api.shelfBooks(selectedID, page) : Promise.resolve(null)])
      .then(([items, books]) => {
        if (disposed) return
        setShelves(items)
        setResult(books)
        setLoading(false)
        if (books && books.page > Math.max(1, books.totalPages)) setPage(Math.max(1, books.totalPages))
      })
      .catch((reason) => {
        if (!disposed) {
          setLoading(false)
          setError(reason instanceof Error ? reason.message : '书架加载失败。')
        }
      })
    return () => {
      disposed = true
    }
  }, [selectedID, page, revision])

  useEffect(() => {
    setPage(1)
    setCandidates([])
    setSearch('')
    setSearched(false)
    setForm(null)
  }, [selectedID])

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
  function refresh() {
    setRevision((value) => value + 1)
  }
  function save(event: FormEvent) {
    event.preventDefault()
    if (!form) return
    void perform(async () => {
      const next = await api.saveShelf(form.name.trim(), form.description.trim(), form.id)
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
        <button className="primary" disabled={busy} onClick={() => setForm({ name: '', description: '' })}>
          ＋ 新建书架
        </button>
      </section>
      {error && (
        <div className="notice error" role="alert">
          {error}{' '}
          <button className="quiet" onClick={refresh}>
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
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              maxLength={500}
              rows={2}
            />
          </label>
          <div className="personal-actions">
            <button type="button" className="quiet" disabled={busy} onClick={() => setForm(null)}>
              取消
            </button>
            <button className="primary" disabled={busy || !form.name.trim()}>
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
              className={selectedID === shelf.id ? 'active' : ''}
              aria-current={selectedID === shelf.id ? 'page' : undefined}
              onClick={() => {
                setPage(1)
                onSelect(shelf.id)
              }}
            >
              <span>{shelf.name}</span>
              <small>{shelf.bookCount} 本</small>
            </button>
          ))}
        </nav>
        <section className="shelf-content">
          {loading ? (
            <p role="status">正在打开书架…</p>
          ) : !selected ? (
            <section className="empty-state">
              <h2>{shelves.length ? '选择一个书架' : '你的第一份阅读清单'}</h2>
              <p>
                {shelves.length ? '从左侧选择书架，继续阅读或调整顺序。' : '把散落的好书收进一个专题，从下一本开始。'}
              </p>
            </section>
          ) : (
            <>
              <header className="shelf-heading">
                <div>
                  <h2>{selected.name}</h2>
                  <p>{selected.description || `${result?.total ?? 0} 本可阅读书籍 · 按你的阅读顺序排列`}</p>
                </div>
                <div className="personal-actions">
                  <button
                    className="quiet"
                    disabled={busy}
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
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`删除“${selected.name}”书架？不会删除书籍、进度或笔记。`))
                        void perform(async () => {
                          await api.deleteShelf(selected.id)
                          onSelect(undefined)
                          refresh()
                        })
                    }}
                  >
                    删除书架
                  </button>
                </div>
              </header>
              <details className="shelf-add-books">
                <summary>＋ 从书库添加书籍</summary>
                <form
                  className="personal-search"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void perform(async () => {
                      const next = await api.listBooks({
                        q: search.trim(),
                        pageSize: 12,
                      })
                      setCandidates(next.items)
                      setSearched(true)
                    })
                  }}
                >
                  <input
                    aria-label="搜索要添加的书籍"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    maxLength={200}
                    placeholder="书名或作者…"
                  />
                  <button className="secondary" disabled={busy}>
                    查找书籍
                  </button>
                </form>
                {searched && candidates.length === 0 && <p>没有找到符合条件的书籍。</p>}
                <div className="shelf-candidates">
                  {candidates.map((book) => (
                    <div key={book.id}>
                      <span>
                        {book.title}
                        <small>{book.authors.join('、')}</small>
                      </span>
                      <button
                        className="secondary"
                        disabled={busy || result?.items.some((item) => item.id === book.id)}
                        onClick={() =>
                          void perform(async () => {
                            await api.setShelfBook(selected.id, book.id, true)
                            setCandidates((items) => items.filter((item) => item.id !== book.id))
                            refresh()
                          })
                        }
                      >
                        {result?.items.some((item) => item.id === book.id) ? '已在书架' : '添加'}
                      </button>
                    </div>
                  ))}
                </div>
              </details>
              {result?.items.length === 0 && (
                <section className="empty-state">
                  <h3>书架里还没有可阅读的书</h3>
                  <p>从上方查找并添加，也可以在书籍详情页加入书架。</p>
                </section>
              )}
              <div className="shelf-reading-list">
                {result?.items.map((book, index) => (
                  <article className="shelf-book" key={book.id}>
                    <span className="shelf-order">{(page - 1) * result.pageSize + index + 1}</span>
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
                        disabled={busy || (page === 1 && index === 0)}
                        onClick={() =>
                          void perform(async () => {
                            await api.moveShelfBook(selected.id, book.id, 'earlier')
                            refresh()
                          })
                        }
                      >
                        ↑
                      </button>
                      <button
                        className="secondary"
                        aria-label={`将《${book.title}》延后`}
                        disabled={busy || (page === result.totalPages && index === result.items.length - 1)}
                        onClick={() =>
                          void perform(async () => {
                            await api.moveShelfBook(selected.id, book.id, 'later')
                            refresh()
                          })
                        }
                      >
                        ↓
                      </button>
                      <button
                        className="quiet"
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm(`从书架移除《${book.title}》？书籍和阅读记录保持不变。`))
                            void perform(async () => {
                              await api.setShelfBook(selected.id, book.id, false)
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
              {result && result.totalPages > 1 && (
                <nav className="personal-pagination" aria-label="书架分页">
                  <button
                    className="secondary"
                    disabled={page <= 1 || busy}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    上一页
                  </button>
                  <span>
                    {page} / {result.totalPages}
                  </span>
                  <button
                    className="secondary"
                    disabled={page >= result.totalPages || busy}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    下一页
                  </button>
                </nav>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}

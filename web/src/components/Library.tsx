import { type ChangeEvent, type FormEvent, useEffect, useMemo, useState } from 'react'
import { APIError, api } from '../api'
import type { BookFile, Category, ImportJob, ReviewItem, Session, User } from '../types'
import { formatBytes } from '../utils'
import { ReviewQueue } from './ReviewQueue'

interface Props {
  session: Session
  onOpenBook: (book: BookFile) => void
  onLogout: () => void
}

type GroupMode = 'none' | 'author' | 'year' | 'category'

export function Library({ session, onOpenBook, onLogout }: Props) {
  const [books, setBooks] = useState<BookFile[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([])
  const [manualReviewItem, setManualReviewItem] = useState<ReviewItem | null>(null)
  const [importJobs, setImportJobs] = useState<ImportJob[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [uploading, setUploading] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [query, setQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [groupMode, setGroupMode] = useState<GroupMode>('none')

  async function refresh() {
    try {
      const [bookItems, categoryItems] = await Promise.all([api.listBooks(), api.listCategories()])
      setBooks(bookItems)
      setCategories(categoryItems)
      if (session.user.role === 'admin') {
        const [userItems, queueItems, jobs] = await Promise.all([api.listUsers(), api.listReviewQueue(), api.listImportJobs()])
        setUsers(userItems)
        setReviewItems(queueItems)
        setImportJobs(jobs)
      }
    } catch (reason) {
      setError(reason instanceof APIError ? reason.message : '无法加载书库。')
    }
  }

  useEffect(() => { void refresh() }, [])

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setUploading(true)
    setError('')
    setNotice('')
    try {
      const result = await api.uploadBook(file)
      setNotice(result.duplicate ? '文件已存在，沿用原有书籍记录。' : `已导入《${result.bookFile.title}》，元数据和分类建议已生成。`)
      await refresh()
    } catch (reason) {
      setError(reason instanceof APIError ? reason.message : '上传失败。')
    } finally {
      setUploading(false)
      event.target.value = ''
    }
  }

  async function createReader(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      await api.createUser(newUsername, newPassword, 'reader')
      setNewUsername('')
      setNewPassword('')
      setUsers(await api.listUsers())
    } catch (reason) {
      setError(reason instanceof APIError ? reason.message : '用户创建失败。')
    }
  }

  const filteredBooks = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return books.filter((book) => {
      if (categoryFilter && !book.categories.some((category) => category.slug === categoryFilter)) return false
      if (!normalizedQuery) return true
      const searchable = [book.title, ...book.authors, book.publisher ?? '', book.publishedYear?.toString() ?? '', ...book.categories.map((category) => category.name)].join(' ').toLocaleLowerCase()
      return searchable.includes(normalizedQuery)
    })
  }, [books, categoryFilter, query])

  const groups = useMemo(() => groupBooks(filteredBooks, groupMode), [filteredBooks, groupMode])
  const visibleReviewItems = useMemo(() => {
    if (!manualReviewItem || reviewItems.some((item) => item.editionId === manualReviewItem.editionId)) return reviewItems
    return [manualReviewItem, ...reviewItems]
  }, [manualReviewItem, reviewItems])

  async function editBook(book: BookFile) {
    setError('')
    try {
      setManualReviewItem(await api.getEditionReview(book.editionId))
      window.setTimeout(() => document.querySelector('.review-panel')?.scrollIntoView({ behavior: 'smooth' }), 0)
    } catch (reason) {
      setError(reason instanceof APIError ? reason.message : '无法打开整理表单。')
    }
  }

  async function reviewChanged() {
    setManualReviewItem(null)
    await refresh()
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">共享书库</p>
          <h1>PEUFMReader</h1>
        </div>
        <div className="account">
          <span>{session.user.username} · {session.user.role}</span>
          <button className="quiet" onClick={onLogout}>退出</button>
        </div>
      </header>

      {error && <div className="notice error" role="alert">{error}</div>}
      {notice && <div className="notice success" role="status">{notice}</div>}

      <section className="library-heading">
        <div>
          <h2>书库</h2>
          <p className="muted">{filteredBooks.length} / {books.length} 个文件</p>
        </div>
        {session.user.role === 'admin' && (
          <label className={`upload-button ${uploading ? 'disabled' : ''}`}>
            {uploading ? '正在提取与分类…' : '导入 EPUB / PDF'}
            <input type="file" accept=".epub,.pdf,application/epub+zip,application/pdf" onChange={upload} disabled={uploading} />
          </label>
        )}
      </section>

      <section className="library-controls" aria-label="书库筛选">
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索书名、作者、年份或题材" aria-label="搜索书库" />
        <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)} aria-label="按题材筛选">
          <option value="">全部题材</option>
          {categories.map((category) => <option key={category.id} value={category.slug}>{category.name}</option>)}
        </select>
        <select value={groupMode} onChange={(event) => setGroupMode(event.target.value as GroupMode)} aria-label="书库分组方式">
          <option value="none">不分组</option>
          <option value="author">按作者</option>
          <option value="year">按年份</option>
          <option value="category">按题材</option>
        </select>
      </section>

      {books.length === 0 ? (
        <section className="empty-state">
          <span className="empty-icon">书</span>
          <h3>书库还是空的</h3>
          <p>管理员导入第一本 EPUB 或 PDF 后，系统会自动提取元数据并生成分类建议。</p>
        </section>
      ) : filteredBooks.length === 0 ? (
        <section className="empty-state"><h3>没有匹配的书籍</h3><p>尝试清除搜索或题材筛选。</p></section>
      ) : (
        <div className="book-groups">
          {groups.map((group) => (
            <section className="book-group" key={group.name}>
              {groupMode !== 'none' && <h3 className="group-title">{group.name}<span>{group.books.length}</span></h3>}
              <div className="book-grid" aria-label={groupMode === 'none' ? '书籍列表' : group.name}>
                {group.books.map((book) => <BookCard key={book.id} book={book} isAdmin={session.user.role === 'admin'} onOpen={onOpenBook} onEdit={editBook} />)}
              </div>
            </section>
          ))}
        </div>
      )}

      {session.user.role === 'admin' && (
        <>
          <ReviewQueue categories={categories} items={visibleReviewItems} onChanged={reviewChanged} />

          <section className="admin-panel">
            <div>
              <p className="eyebrow">用户管理</p>
              <h2>{users.length} 个账号</h2>
            </div>
            <form className="inline-form" onSubmit={createReader}>
              <input aria-label="新用户名" placeholder="新用户名" value={newUsername} onChange={(event) => setNewUsername(event.target.value)} required />
              <input aria-label="新用户密码" type="password" placeholder="至少 12 位密码" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required />
              <button className="secondary" type="submit">添加阅读者</button>
            </form>
          </section>

          <section className="jobs-panel">
            <div className="section-title"><div><p className="eyebrow">导入审计</p><h2>最近任务</h2></div></div>
            <div className="job-list">
              {importJobs.slice(0, 8).map((job) => (
                <div className="job-row" key={job.id}>
                  <span className={`job-state ${job.state}`}>{job.state}</span>
                  <strong>{job.sourceName}</strong>
                  <span>{job.warnings?.join('；') || '无警告'}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </main>
  )
}

function BookCard({ book, isAdmin, onOpen, onEdit }: { book: BookFile; isAdmin: boolean; onOpen: (book: BookFile) => void; onEdit: (book: BookFile) => Promise<void> }) {
  return (
    <article className="book-card">
      <button className="book-open" onClick={() => onOpen(book)}>
        {book.coverUrl ? <img className="book-cover" src={book.coverUrl} alt="" loading="lazy" /> : <span className="cover-placeholder">{book.title.slice(0, 1)}</span>}
        <span className="book-card-content">
          <span className="card-badges">
            <span className={`format-badge ${book.format}`}>{book.format.toUpperCase()}</span>
            {isAdmin && book.reviewRequired && <span className="review-badge">待整理</span>}
          </span>
          <span className="book-title">{book.title}</span>
          <span className="book-authors">{book.authors.join('、') || '未知作者'}{book.publishedYear ? ` · ${book.publishedYear}` : ''}</span>
          {book.categories.length > 0 && <span className="category-chips">{book.categories.map((category) => <span key={category.id}>{category.name}</span>)}</span>}
          <span className="book-meta">{formatBytes(book.sizeBytes)}</span>
        </span>
      </button>
      {isAdmin && <button className="manage-book" onClick={() => void onEdit(book)}>整理元数据与分类</button>}
    </article>
  )
}

function groupBooks(books: BookFile[], mode: GroupMode): Array<{ name: string; books: BookFile[] }> {
  if (mode === 'none') return [{ name: '全部', books }]
  const grouped = new Map<string, BookFile[]>()
  for (const book of books) {
    const name = mode === 'author'
      ? book.authors[0] || '未知作者'
      : mode === 'year'
        ? book.publishedYear?.toString() ?? '未知年份'
        : book.categories[0]?.name ?? '未分类'
    grouped.set(name, [...(grouped.get(name) ?? []), book])
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right, 'zh-CN')).map(([name, groupedBooks]) => ({ name, books: groupedBooks }))
}

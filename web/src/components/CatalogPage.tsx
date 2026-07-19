import { useEffect, useRef, useState } from 'react'
import { APIError, api } from '../api'
import type { BookFile, CatalogPage as CatalogResult, CatalogQuery, Category } from '../types'
import { BookCard } from './BookCard'

interface Props {
  initialQuery?: CatalogQuery
  isAdmin: boolean
  onOpenBook: (book: BookFile) => void
  onViewBook: (book: BookFile) => void
  onManageBook: (book: BookFile) => void
}

const emptyResult: CatalogResult = { items: [], total: 0, page: 1, pageSize: 24, totalPages: 0 }

export function CatalogPage({ initialQuery = {}, isAdmin, onOpenBook, onViewBook, onManageBook }: Props) {
  const [query, setQuery] = useState(initialQuery.q ?? '')
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery.q ?? '')
  const [category, setCategory] = useState(initialQuery.category ?? '')
  const [format, setFormat] = useState<CatalogQuery['format']>(initialQuery.format ?? '')
  const [status, setStatus] = useState<CatalogQuery['status']>(initialQuery.status ?? '')
  const [sort, setSort] = useState<CatalogQuery['sort']>(initialQuery.sort ?? (initialQuery.q ? 'relevance' : 'title'))
  const [page, setPage] = useState(initialQuery.page ?? 1)
  const [categories, setCategories] = useState<Category[]>([])
  const [result, setResult] = useState<CatalogResult>(emptyResult)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const requestIDRef = useRef(0)

  useEffect(() => {
    void api.listCategories().then(setCategories).catch(() => undefined)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim())
      setPage(1)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    const requestID = ++requestIDRef.current
    setLoading(true)
    setError('')
    const effectiveSort = sort === 'relevance' && !debouncedQuery ? 'title' : sort
    void api.listBooks({
      q: debouncedQuery,
      category,
      format,
      status,
      sort: effectiveSort,
      page,
      pageSize: 24,
    }).then((next) => {
      if (requestID !== requestIDRef.current) return
      setResult(next)
      if (next.totalPages > 0 && page > next.totalPages) setPage(next.totalPages)
    }).catch((reason) => {
      if (requestID !== requestIDRef.current) return
      setError(reason instanceof APIError ? reason.message : '无法搜索书库。')
    }).finally(() => {
      if (requestID === requestIDRef.current) setLoading(false)
    })
  }, [category, debouncedQuery, format, page, sort, status])

  function resetPageAnd(action: () => void) {
    setPage(1)
    action()
  }

  return (
    <div className="catalog-page">
      <section className="page-heading">
        <div><p className="eyebrow">共享书库</p><h1>全部书籍</h1><p className="muted">搜索、筛选并排序 NAS 中的 EPUB 与 PDF。</p></div>
        <strong>{result.total} 本</strong>
      </section>

      <section className="catalog-controls" aria-label="书库搜索和筛选">
        <label className="catalog-search-field">
          <span aria-hidden="true">⌕</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="书名、作者、ISBN、出版社、年份或题材" aria-label="搜索书库" />
        </label>
        <select value={category} onChange={(event) => resetPageAnd(() => setCategory(event.target.value))} aria-label="按题材筛选">
          <option value="">全部题材</option>
          {categories.map((item) => <option key={item.id} value={item.slug}>{item.name}</option>)}
        </select>
        <select value={format} onChange={(event) => resetPageAnd(() => setFormat(event.target.value as CatalogQuery['format']))} aria-label="按格式筛选">
          <option value="">全部格式</option><option value="pdf">PDF</option><option value="epub">EPUB</option>
        </select>
        <select value={status} onChange={(event) => resetPageAnd(() => setStatus(event.target.value as CatalogQuery['status']))} aria-label="按阅读状态筛选">
          <option value="">全部状态</option><option value="unread">未读</option><option value="reading">正在阅读</option><option value="paused">已暂停</option><option value="finished">已读完</option><option value="abandoned">已放弃</option>
        </select>
        <select value={sort} onChange={(event) => resetPageAnd(() => setSort(event.target.value as CatalogQuery['sort']))} aria-label="排序方式">
          <option value="relevance" disabled={!query.trim()}>相关度</option>
          <option value="title">书名</option><option value="newest">最近加入</option><option value="hot">近期热门</option>
        </select>
      </section>

      {error && <div className="notice error" role="alert">{error}</div>}
      {loading && result.items.length === 0 ? (
        <section className="catalog-loading">正在搜索书库…</section>
      ) : result.items.length === 0 ? (
        <section className="empty-state"><h2>没有匹配的书籍</h2><p>尝试减少筛选条件或使用其他关键词。</p></section>
      ) : (
        <>
          <div className={`book-grid catalog-grid${loading ? ' is-updating' : ''}`}>
            {result.items.map((book) => <BookCard key={book.id} book={book} onOpen={onOpenBook} onDetails={onViewBook} onEdit={isAdmin ? onManageBook : undefined} />)}
          </div>
          <nav className="catalog-pagination" aria-label="书库分页">
            <button className="secondary" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>上一页</button>
            <span>第 <strong>{result.page}</strong> / {Math.max(1, result.totalPages)} 页</span>
            <button className="secondary" disabled={page >= result.totalPages || loading} onClick={() => setPage((current) => current + 1)}>下一页</button>
          </nav>
        </>
      )}
    </div>
  )
}

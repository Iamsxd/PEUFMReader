import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { APIError, api } from '../api'
import type { BookFile, CatalogQuery, CategorySummary, HomeBook, HomeDashboard } from '../types'
import { formatDuration, formatRelativeTime } from '../utils'
import { BookCard } from './BookCard'

interface Props {
  username: string
  onOpenBook: (book: BookFile) => void
  onBrowse: (query?: CatalogQuery) => void
  onCategories: () => void
}

export function HomePage({ username, onOpenBook, onBrowse, onCategories }: Props) {
  const [dashboard, setDashboard] = useState<HomeDashboard | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void api.getHomeDashboard().then(setDashboard).catch((reason) => {
      setError(reason instanceof APIError ? reason.message : '无法加载首页。')
    })
  }, [])

  function search(event: FormEvent) {
    event.preventDefault()
    onBrowse({ q: query.trim(), sort: query.trim() ? 'relevance' : 'title' })
  }

  if (error) return <div className="notice error" role="alert">{error}</div>
  if (!dashboard) return <section className="dashboard-loading">正在整理你的书架…</section>
  if (dashboard.stats.totalBooks === 0) {
    return (
      <section className="empty-state dashboard-empty">
        <span className="empty-icon">书</span>
        <h2>书库还是空的</h2>
        <p>管理员导入第一本 EPUB 或 PDF 后，首页会展示分类、阅读进度和最近内容。</p>
      </section>
    )
  }

  const primaryReading = dashboard.continueReading[0]
  const otherReading = dashboard.continueReading.slice(1)
  const visibleCategories = dashboard.categories.filter((category) => category.bookCount > 0).slice(0, 8)

  return (
    <div className="dashboard-page">
      <section className="dashboard-hero">
        <div>
          <p className="eyebrow">欢迎回来，{username}</p>
          <h1>今天想读点什么？</h1>
          <p>从上次的位置继续，或者在共享书库中发现下一本书。</p>
        </div>
        <form className="dashboard-search" role="search" onSubmit={search}>
          <span aria-hidden="true">⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索书名、作者、ISBN、年份或题材" aria-label="搜索书库" />
          <button className="primary" type="submit">搜索</button>
        </form>
      </section>

      <div className="dashboard-lead-grid">
        <section className="continue-panel">
          <SectionHeading eyebrow="个人书架" title="继续阅读" actionLabel="查看全部" onAction={() => onBrowse({ status: 'reading', sort: 'newest' })} />
          {primaryReading ? (
            <ContinueCard item={primaryReading} onOpen={onOpenBook} />
          ) : (
            <div className="continue-empty">
              <strong>还没有正在阅读的书</strong>
              <span>从书库打开一本书，系统会自动记录进度。</span>
              <button className="secondary" onClick={() => onBrowse()}>浏览全部书籍</button>
            </div>
          )}
        </section>
        <ReadingStats dashboard={dashboard} />
      </div>

      {otherReading.length > 0 && (
        <BookShelf title="最近阅读" eyebrow="继续你的节奏" items={otherReading} onOpen={onOpenBook} />
      )}

      <section className="dashboard-section">
        <SectionHeading eyebrow="固定题材" title="按分类浏览" actionLabel="全部分类" onAction={onCategories} />
        {visibleCategories.length > 0 ? (
          <div className="category-summary-grid">
            {visibleCategories.map((category) => <CategoryTile key={category.id} category={category} onClick={() => onBrowse({ category: category.slug, sort: 'title' })} />)}
          </div>
        ) : <p className="muted">分类仍在整理中，可以先浏览全部书籍。</p>}
      </section>

      {dashboard.hotBooks.length > 0 && (
        <BookShelf title="近 30 天热门" eyebrow="大家最近在读" items={dashboard.hotBooks} onOpen={onOpenBook} hot />
      )}

      <section className="dashboard-section">
        <SectionHeading eyebrow="书库动态" title="最近加入" actionLabel="查看全部" onAction={() => onBrowse({ sort: 'newest' })} />
        <div className="book-shelf">
          {dashboard.recentlyAdded.map((book) => <BookCard key={book.id} book={book} onOpen={onOpenBook} compact />)}
        </div>
      </section>
    </div>
  )
}

function ContinueCard({ item, onOpen }: { item: HomeBook; onOpen: (book: BookFile) => void }) {
  const progress = Math.round((item.overallProgress ?? 0) * 100)
  return (
    <article className="continue-card">
      {item.book.coverUrl ? <img src={item.book.coverUrl} alt="" /> : <span className="continue-cover-placeholder">{item.book.title.slice(0, 1)}</span>}
      <div>
        <span className={`format-badge ${item.book.format}`}>{item.book.format.toUpperCase()}</span>
        <h3>{item.book.title}</h3>
        <p>{item.book.authors.join('、') || '未知作者'}</p>
        <div className="continue-progress"><span><i style={{ width: `${progress}%` }} /></span><strong>{progress}%</strong></div>
        <small>{item.lastReadAt ? `${formatRelativeTime(item.lastReadAt)}阅读过` : '最近阅读'}{item.totalActiveSeconds ? ` · 累计 ${formatDuration(item.totalActiveSeconds)}` : ''}</small>
        <button className="primary" onClick={() => onOpen(item.book)}>继续阅读</button>
      </div>
    </article>
  )
}

function ReadingStats({ dashboard }: { dashboard: HomeDashboard }) {
  const stats = dashboard.stats
  return (
    <section className="reading-stats-panel">
      <div><p className="eyebrow">我的阅读</p><h2>阅读概况</h2></div>
      <div className="reading-stat primary-stat"><strong>{formatDuration(stats.weekActiveSeconds)}</strong><span>最近 7 天</span></div>
      <div className="reading-stat"><strong>{stats.readingBooks}</strong><span>正在阅读</span></div>
      <div className="reading-stat"><strong>{stats.finishedBooks}</strong><span>已经读完</span></div>
      <div className="reading-stat"><strong>{formatDuration(stats.totalActiveSeconds)}</strong><span>累计时长</span></div>
      <div className="reading-stat"><strong>{stats.totalBooks}</strong><span>书库藏书</span></div>
    </section>
  )
}

function BookShelf({ title, eyebrow, items, onOpen, hot = false }: { title: string; eyebrow: string; items: HomeBook[]; onOpen: (book: BookFile) => void; hot?: boolean }) {
  return (
    <section className="dashboard-section">
      <SectionHeading eyebrow={eyebrow} title={title} />
      <div className="book-shelf">
        {items.map((item) => (
          <BookCard
            key={item.book.id}
            book={item.book}
            onOpen={onOpen}
            compact
            progress={hot ? undefined : item.overallProgress}
            activeSeconds={hot ? undefined : item.totalActiveSeconds}
            lastReadAt={hot ? undefined : item.lastReadAt}
            heatLabel={hot ? hotBookLabel(item) : undefined}
          />
        ))}
      </div>
    </section>
  )
}

function hotBookLabel(item: HomeBook): string {
  const duration = formatDuration(item.totalActiveSeconds ?? 0)
  return (item.readerCount ?? 0) >= 2 ? `${item.readerCount} 位读者 · ${duration}` : `近期阅读 ${duration}`
}

function CategoryTile({ category, onClick }: { category: CategorySummary; onClick: () => void }) {
  return (
    <button className="category-tile" onClick={onClick}>
      <span className="category-cover-stack" aria-hidden="true">
        {category.coverUrls.slice(0, 3).map((url) => <img key={url} src={url} alt="" loading="lazy" />)}
        {category.coverUrls.length === 0 && <i>{category.name.slice(0, 1)}</i>}
      </span>
      <span><strong>{category.name}</strong><small>{category.bookCount} 本书</small></span>
      <b aria-hidden="true">→</b>
    </button>
  )
}

function SectionHeading({ eyebrow, title, actionLabel, onAction }: { eyebrow: string; title: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <div className="dashboard-section-heading">
      <div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div>
      {actionLabel && onAction && <button className="quiet" onClick={onAction}>{actionLabel} →</button>}
    </div>
  )
}

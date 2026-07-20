import { useEffect, useState } from 'react'
import { APIError, api } from '../api'
import type { BookDetail, BookFile, Recommendation } from '../types'
import { formatBytes, formatDuration, formatRelativeTime } from '../utils'
import { BookCard } from './BookCard'

interface Props {
  bookID: number
  isAdmin: boolean
  onBack: () => void
  onOpenBook: (book: BookFile) => void
  onViewBook: (book: BookFile) => void
  onManageBook: (book: BookFile) => void
  onBrowseCategory: (slug: string) => void
}

const statusLabels: Record<BookDetail['readingState']['status'], string> = {
  unread: '尚未开始',
  reading: '正在阅读',
  paused: '暂时搁置',
  finished: '已经读完',
  abandoned: '已放弃',
}

export function BookDetailPage({ bookID, isAdmin, onBack, onOpenBook, onViewBook, onManageBook, onBrowseCategory }: Props) {
  const [detail, setDetail] = useState<BookDetail | null>(null)
  const [recommendations, setRecommendations] = useState<Recommendation[]>([])
  const [error, setError] = useState('')
  const [favoriteBusy, setFavoriteBusy] = useState(false)
  const [coverPage, setCoverPage] = useState(1)
  const [coverJobID, setCoverJobID] = useState<number | null>(null)
  const [coverNotice, setCoverNotice] = useState('')
  const [coverRevision, setCoverRevision] = useState(0)

  useEffect(() => {
    setDetail(null)
    setError('')
    setCoverPage(1)
    setCoverJobID(null)
    setCoverNotice('')
    setCoverRevision(0)
    void Promise.all([api.getBookDetail(bookID), api.getRecommendations(8)]).then(([nextDetail, result]) => {
      setDetail(nextDetail)
      setRecommendations(result.items.filter((item) => item.book.id !== bookID).slice(0, 6))
    }).catch((reason) => {
      setError(reason instanceof APIError && reason.status === 404 ? '这本书不存在或已被移除。' : '无法加载书籍详情。')
    })
  }, [bookID])

  useEffect(() => {
    if (!coverJobID) return
    let cancelled = false
    let timer = 0
    const poll = async () => {
      try {
        const jobs = await api.listBackgroundJobs()
        const job = jobs.find((item) => item.id === coverJobID)
        if (!job) throw new Error('封面任务不在最近任务列表中。')
        if (job.state === 'completed') {
          const nextDetail = await api.getBookDetail(bookID)
          if (cancelled) return
          setDetail(nextDetail)
          setCoverRevision(Date.now())
          setCoverNotice(`已使用 PDF 第 ${coverPage} 页重新生成封面。`)
          setCoverJobID(null)
          return
        }
        if (job.state === 'failed') {
          throw new Error(job.lastError || '封面生成失败。')
        }
        timer = window.setTimeout(() => void poll(), 1500)
      } catch (reason) {
        if (cancelled) return
        setCoverJobID(null)
        setError(reason instanceof Error ? reason.message : '无法确认封面生成结果。')
      }
    }
    timer = window.setTimeout(() => void poll(), 800)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [bookID, coverJobID, coverPage])

  async function toggleFavorite() {
    if (!detail || favoriteBusy) return
    const nextFavorite = !detail.favorite
    setFavoriteBusy(true)
    setError('')
    try {
      const state = await api.setFavorite(detail.book.id, nextFavorite)
      setDetail((current) => current ? {
        ...current,
        favorite: state.favorite,
        favoritedAt: state.createdAt,
        favoriteCount: Math.max(0, current.favoriteCount + (state.favorite ? 1 : -1)),
      } : current)
    } catch (reason) {
      setError(reason instanceof APIError ? reason.message : '无法更新收藏。')
    } finally {
      setFavoriteBusy(false)
    }
  }

  async function regenerateCover() {
    if (!detail || detail.book.format !== 'pdf' || coverJobID) return
    setError('')
    setCoverNotice('正在排队生成封面…')
    try {
      const result = await api.regeneratePDFCover(detail.book.id, coverPage)
      setCoverJobID(result.job.id)
      setCoverNotice(result.created ? `正在从 PDF 第 ${coverPage} 页生成封面…` : '已有封面生成任务正在处理…')
    } catch (reason) {
      setCoverNotice('')
      setError(reason instanceof APIError ? reason.message : '无法启动封面生成任务。')
    }
  }

  if (error && !detail) {
    return <section className="empty-state detail-error"><h2>{error}</h2><button className="secondary" onClick={onBack}>返回书库</button></section>
  }
  if (!detail) return <section className="dashboard-loading">正在打开书籍档案…</section>

  const { book, readingState } = detail
  const progress = Math.round(readingState.overallProgress * 100)
  const readingActionLabel = readingState.status === 'finished' ? '重新阅读' : progress > 0 ? `继续阅读 · ${progress}%` : '开始阅读'
  const coverURL = book.coverUrl ? `${book.coverUrl}?v=${coverRevision || book.id}` : ''
  return (
    <div className="book-detail-page">
      <button className="detail-back quiet" onClick={onBack}>← 返回书库</button>
      {error && <div className="notice error" role="alert">{error}</div>}
      <section className="book-detail-hero">
        <div className="detail-cover-column">
          <div className="detail-cover-wrap">
            {coverURL ? <img src={coverURL} alt={`${book.title}封面`} /> : <span>{book.title.slice(0, 1)}</span>}
          </div>
          {isAdmin && book.format === 'pdf' && (
            <div className="detail-cover-tools">
              <label>封面页<input type="number" min={1} max={book.pageCount ?? undefined} value={coverPage} disabled={Boolean(coverJobID)} onChange={(event) => setCoverPage(Math.max(1, Number(event.target.value) || 1))} /></label>
              <button className="secondary" type="button" disabled={Boolean(coverJobID)} onClick={() => void regenerateCover()}>{coverJobID ? '生成中…' : '重新生成封面'}</button>
            </div>
          )}
          {coverNotice && <small className="detail-cover-notice" role="status">{coverNotice}</small>}
        </div>
        <div className="detail-main">
          <div className="card-badges">
            <span className={`format-badge ${book.format}`}>{book.format.toUpperCase()}</span>
            {book.textExtractionMethod === 'ocr' && <span className="format-badge ocr">OCR</span>}
            {book.textExtractionMethod === 'embedded' && <span className="format-badge text">可搜索文本</span>}
          </div>
          <h1>{book.title}</h1>
          <p className="detail-authors">{book.authors.join('、') || '未知作者'}</p>
          <div className="detail-category-list">
            {book.categories.map((category) => <button key={category.id} onClick={() => onBrowseCategory(category.slug)}>{category.name}</button>)}
          </div>
          <p className="detail-description">{detail.description || '这本书暂时还没有简介，管理员可以在管理后台补充书目信息。'}</p>
          <div className="detail-actions">
            <button className="primary" onClick={() => onOpenBook(book)}>{readingActionLabel}</button>
            <button className={detail.favorite ? 'favorite-button active' : 'favorite-button'} disabled={favoriteBusy} onClick={() => void toggleFavorite()}>
              {detail.favorite ? '♥ 已收藏' : '♡ 加入收藏'}
            </button>
            {isAdmin && <button className="secondary" onClick={() => onManageBook(book)}>整理书籍信息</button>}
          </div>
          {readingState.status !== 'unread' && readingState.updatedAt && <small className="detail-last-read">上次记录于 {formatRelativeTime(readingState.updatedAt)}</small>}
        </div>
      </section>

      <section className="detail-information-grid">
        <article className="detail-reading-card">
          <p className="eyebrow">个人阅读</p><h2>{statusLabels[readingState.status]}</h2>
          <div className="detail-progress"><span><i style={{ width: `${progress}%` }} /></span><strong>{progress}%</strong></div>
          <dl><div><dt>累计时长</dt><dd>{formatDuration(readingState.totalActiveSeconds)}</dd></div><div><dt>阅读状态</dt><dd>{statusLabels[readingState.status]}</dd></div></dl>
        </article>
        <article className="detail-meta-card">
          <p className="eyebrow">版本信息</p><h2>书籍档案</h2>
          <dl>
            <div><dt>出版年份</dt><dd>{book.publishedYear ?? '未知'}</dd></div>
            <div><dt>出版社</dt><dd>{book.publisher || '未知'}</dd></div>
            <div><dt>语言</dt><dd>{book.language || '未知'}</dd></div>
            <div><dt>ISBN</dt><dd>{book.isbn || '未记录'}</dd></div>
            <div><dt>文件</dt><dd>{book.format.toUpperCase()} · {formatBytes(book.sizeBytes)}</dd></div>
            <div><dt>页数</dt><dd>{book.pageCount ? `${book.pageCount} 页` : '未统计'}</dd></div>
          </dl>
        </article>
        <article className="detail-community-card">
          <p className="eyebrow">共享书库</p><h2>阅读热度</h2>
          <div><strong>{detail.readerCount}</strong><span>位读者</span></div>
          <div><strong>{detail.favoriteCount}</strong><span>人收藏</span></div>
          <div><strong>{formatDuration(detail.totalActiveSeconds)}</strong><span>累计阅读</span></div>
        </article>
      </section>

      {recommendations.length > 0 && (
        <section className="dashboard-section detail-recommendations">
          <div className="dashboard-section-heading"><div><p className="eyebrow">接下来可以读</p><h2>为你推荐</h2></div></div>
          <div className="book-shelf">
            {recommendations.map((item) => <BookCard key={item.book.id} book={item.book} onOpen={onOpenBook} onDetails={onViewBook} recommendationReason={item.reason} compact />)}
          </div>
        </section>
      )}
    </div>
  )
}

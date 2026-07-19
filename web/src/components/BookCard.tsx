import type { BookFile } from '../types'
import { formatBytes, formatDuration, formatRelativeTime } from '../utils'

interface Props {
  book: BookFile
  onOpen: (book: BookFile) => void
  onDetails?: (book: BookFile) => void
  onEdit?: (book: BookFile) => void
  onToggleFavorite?: (book: BookFile) => void
  favorite?: boolean
  progress?: number
  activeSeconds?: number
  lastReadAt?: string
  heatLabel?: string
  recommendationReason?: string
  activityLabel?: string
  compact?: boolean
}

export function BookCard({ book, onOpen, onDetails, onEdit, onToggleFavorite, favorite = false, progress, activeSeconds, lastReadAt, heatLabel, recommendationReason, activityLabel, compact = false }: Props) {
  return (
    <article className={`book-card${compact ? ' compact' : ''}`}>
      <button className="book-open" onClick={() => (onDetails ?? onOpen)(book)} aria-label={`${onDetails ? '查看详情：' : '阅读：'}${book.title}`}>
        {book.coverUrl ? <img className="book-cover" src={book.coverUrl} alt="" loading="lazy" /> : <span className="cover-placeholder">{book.title.slice(0, 1)}</span>}
        <span className="book-card-content">
          <span className="card-badges">
            <span className={`format-badge ${book.format}`}>{book.format.toUpperCase()}</span>
            {book.textExtractionMethod === 'ocr' && <span className="format-badge ocr">OCR</span>}
            {book.textExtractionMethod === 'embedded' && <span className="format-badge text">文本</span>}
            {favorite && <span className="favorite-badge">♥ 已收藏</span>}
            {book.reviewRequired && onEdit && <span className="review-badge">待整理</span>}
          </span>
          <span className="book-title">{book.title}</span>
          <span className="book-authors">{book.authors.join('、') || '未知作者'}{book.publishedYear ? ` · ${book.publishedYear}` : ''}</span>
          {progress !== undefined && (
            <span className="book-progress">
              <span><i style={{ width: `${Math.round(progress * 100)}%` }} /></span>
              <small>{Math.round(progress * 100)}%</small>
            </span>
          )}
          {book.categories.length > 0 && <span className="category-chips">{book.categories.slice(0, 3).map((category) => <span key={category.id}>{category.name}</span>)}</span>}
          {heatLabel && <span className="book-activity">{heatLabel}</span>}
          {recommendationReason && <span className="recommendation-reason">{recommendationReason}</span>}
          {activityLabel && <span className="book-activity">{activityLabel}</span>}
          {lastReadAt && <span className="book-activity">上次阅读于 {formatRelativeTime(lastReadAt)}</span>}
          {activeSeconds !== undefined && activeSeconds > 0 && <span className="book-activity">累计 {formatDuration(activeSeconds)}</span>}
          {!compact && <span className="book-meta">{formatBytes(book.sizeBytes)}{book.pageCount ? ` · ${book.pageCount} 页` : ''}</span>}
        </span>
      </button>
      {(onDetails || onEdit || onToggleFavorite || book.textUrl) && (
        <div className="book-card-actions">
          {onDetails && <button onClick={() => onOpen(book)}>开始阅读</button>}
          {onToggleFavorite && <button className={favorite ? 'favorite-action active' : 'favorite-action'} onClick={() => onToggleFavorite(book)}>{favorite ? '移出收藏' : '加入收藏'}</button>}
          {book.textUrl && <a href={book.textUrl} target="_blank" rel="noreferrer">查看提取文本</a>}
          {onEdit && <button onClick={() => onEdit(book)}>整理元数据与分类</button>}
        </div>
      )}
    </article>
  )
}

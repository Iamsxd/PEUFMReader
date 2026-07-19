import { useEffect, useState } from 'react'
import { APIError, api } from '../api'
import type { BookFile, RecommendationPage as RecommendationResult } from '../types'
import { BookCard } from './BookCard'

interface Props {
  onOpenBook: (book: BookFile) => void
  onViewBook: (book: BookFile) => void
  onBrowse: () => void
}

export function RecommendationsPage({ onOpenBook, onViewBook, onBrowse }: Props) {
  const [result, setResult] = useState<RecommendationResult | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void api.getRecommendations(24).then(setResult).catch((reason) => {
      setError(reason instanceof APIError ? reason.message : '无法生成推荐。')
    })
  }, [])

  return (
    <div className="recommendations-page">
      <section className="page-heading">
        <div>
          <p className="eyebrow">发现下一本书</p><h1>为你推荐</h1>
          <p className="muted">{result?.personalized ? '根据你的收藏、阅读题材和作者偏好生成，并结合书库近期热度。' : '阅读或收藏几本书后，推荐会逐渐更懂你的偏好。当前先展示热门与新加入内容。'}</p>
        </div>
        <strong>{result?.items.length ?? 0} 本</strong>
      </section>
      {error && <div className="notice error" role="alert">{error}</div>}
      {!result && !error ? (
        <section className="catalog-loading">正在理解你的阅读偏好…</section>
      ) : result && result.items.length > 0 ? (
        <div className="book-grid recommendation-grid">
          {result.items.map((item) => <BookCard key={item.book.id} book={item.book} onOpen={onOpenBook} onDetails={onViewBook} recommendationReason={item.reason} />)}
        </div>
      ) : (
        <section className="empty-state"><h2>暂时没有新的推荐</h2><p>你可能已经读过或收藏了当前书库中的全部候选书籍。</p><button className="primary" onClick={onBrowse}>浏览全部书籍</button></section>
      )}
    </div>
  )
}

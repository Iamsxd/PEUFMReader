import { useCallback, useEffect, useState } from 'react'
import { APIError, api } from '../api'
import type { BookFile, FavoritePage as FavoriteResult } from '../types'
import { formatRelativeTime } from '../utils'
import { BookCard } from './BookCard'

interface Props {
  onOpenBook: (book: BookFile) => void
  onViewBook: (book: BookFile) => void
  onBrowse: () => void
}

export function FavoritesPage({ onOpenBook, onViewBook, onBrowse }: Props) {
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<FavoriteResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshVersion, setRefreshVersion] = useState(0)

  const removeFavorite = useCallback(async (book: BookFile) => {
    setError('')
    try {
      await api.setFavorite(book.id, false)
      if (result?.items.length === 1 && page > 1) setPage((current) => current - 1)
      else setRefreshVersion((current) => current + 1)
    } catch (reason) {
      setError(reason instanceof APIError ? reason.message : '无法移出收藏。')
    }
  }, [page, result?.items.length])

  useEffect(() => {
    setLoading(true)
    setError('')
    void api.listFavorites(page, 24).then(setResult).catch((reason) => {
      setError(reason instanceof APIError ? reason.message : '无法加载收藏书架。')
    }).finally(() => setLoading(false))
  }, [page, refreshVersion])

  return (
    <div className="favorites-page">
      <section className="page-heading">
        <div><p className="eyebrow">个人书架</p><h1>我的收藏</h1><p className="muted">把想读、常读和舍不得忘记的书放在这里。</p></div>
        <strong>{result?.total ?? 0} 本</strong>
      </section>
      {error && <div className="notice error" role="alert">{error}</div>}
      {loading && !result ? (
        <section className="catalog-loading">正在整理收藏书架…</section>
      ) : !result || result.items.length === 0 ? (
        <section className="empty-state favorites-empty"><span className="empty-icon">♥</span><h2>还没有收藏书籍</h2><p>在书籍详情页点击“加入收藏”，它就会出现在这里。</p><button className="primary" onClick={onBrowse}>去书库看看</button></section>
      ) : (
        <>
          <div className={`book-grid catalog-grid${loading ? ' is-updating' : ''}`}>
            {result.items.map((item) => (
              <BookCard key={item.book.id} book={item.book} onOpen={onOpenBook} onDetails={onViewBook} onToggleFavorite={(book) => void removeFavorite(book)} favorite activityLabel={`收藏于 ${formatRelativeTime(item.favoritedAt)}`} />
            ))}
          </div>
          <nav className="catalog-pagination" aria-label="收藏书架分页">
            <button className="secondary" disabled={page <= 1 || loading} onClick={() => setPage((current) => current - 1)}>上一页</button>
            <span>第 <strong>{result.page}</strong> / {Math.max(1, result.totalPages)} 页</span>
            <button className="secondary" disabled={page >= result.totalPages || loading} onClick={() => setPage((current) => current + 1)}>下一页</button>
          </nav>
        </>
      )}
    </div>
  )
}

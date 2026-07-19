import { useEffect, useMemo, useState } from 'react'
import { APIError, api } from '../api'
import type { CatalogQuery, CategorySummary } from '../types'

interface Props {
  onBrowse: (query: CatalogQuery) => void
}

export function CategoriesPage({ onBrowse }: Props) {
  const [categories, setCategories] = useState<CategorySummary[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    void api.getHomeDashboard().then((dashboard) => setCategories(dashboard.categories)).catch((reason) => {
      setError(reason instanceof APIError ? reason.message : '无法加载分类。')
    }).finally(() => setLoading(false))
  }, [])

  const visibleCategories = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return categories.filter((category) => !normalized || category.name.toLocaleLowerCase().includes(normalized) || category.slug.includes(normalized))
  }, [categories, query])

  return (
    <div className="categories-page">
      <section className="page-heading">
        <div><p className="eyebrow">固定题材</p><h1>书籍分类</h1><p className="muted">按题材进入书库，分类数量会随整理结果自动更新。</p></div>
        <label className="category-search"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="查找分类" aria-label="查找分类" /></label>
      </section>
      {error && <div className="notice error" role="alert">{error}</div>}
      {loading ? <section className="dashboard-loading">正在统计分类…</section> : (
        <div className="categories-directory">
          {visibleCategories.map((category) => (
            <button key={category.id} className="category-directory-card" onClick={() => onBrowse({ category: category.slug, sort: 'title' })}>
              <span className="category-directory-covers" aria-hidden="true">
                {category.coverUrls.slice(0, 3).map((url) => <img key={url} src={url} alt="" loading="lazy" />)}
                {category.coverUrls.length === 0 && <i>{category.name.slice(0, 1)}</i>}
              </span>
              <span><strong>{category.name}</strong><small>{category.bookCount > 0 ? `${category.bookCount} 本书` : '暂无书籍'}</small></span>
              <b aria-hidden="true">→</b>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

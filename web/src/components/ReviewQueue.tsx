import { type FormEvent, useEffect, useRef, useState } from 'react'
import { APIError, api } from '../api'
import type { BibliographyMatch, Category, ReviewInput, ReviewItem, ReviewQueuePage, ReviewQueueQuery } from '../types'

interface Props {
  categories: Category[]
  initialEditionID?: number
  onTotalChange: (total: number) => void
}

const emptyPage: ReviewQueuePage = { items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 }

export function ReviewQueue({ categories, initialEditionID, onTotalChange }: Props) {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [format, setFormat] = useState<ReviewQueueQuery['format']>('')
  const [reason, setReason] = useState<ReviewQueueQuery['reason']>('')
  const [sort, setSort] = useState<ReviewQueueQuery['sort']>('oldest')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<ReviewQueuePage>(emptyPage)
  const [activeItem, setActiveItem] = useState<ReviewItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [error, setError] = useState('')
  const [refreshVersion, setRefreshVersion] = useState(0)
  const pageRequestID = useRef(0)
  const detailRequestID = useRef(0)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim())
      setPage(1)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => {
    const requestID = ++pageRequestID.current
    setLoading(true)
    setError('')
    void api.listReviewQueue({ q: debouncedSearch, format, reason, sort, page, pageSize: 20 }).then((next) => {
      if (requestID !== pageRequestID.current) return
      setResult(next)
      if (!debouncedSearch && !format && !reason) onTotalChange(next.total)
      if (next.totalPages > 0 && page > next.totalPages) setPage(next.totalPages)
    }).catch((requestError) => {
      if (requestID !== pageRequestID.current) return
      setError(requestError instanceof APIError ? requestError.message : '无法加载待整理书目。')
    }).finally(() => {
      if (requestID === pageRequestID.current) setLoading(false)
    })
  }, [debouncedSearch, format, onTotalChange, page, reason, refreshVersion, sort])

  useEffect(() => {
    if (!initialEditionID) return
    void openReview(initialEditionID)
  }, [initialEditionID])

  async function openReview(editionID: number) {
    const requestID = ++detailRequestID.current
    setLoadingDetail(true)
    setError('')
    try {
      const item = await api.getEditionReview(editionID)
      if (requestID === detailRequestID.current) setActiveItem(item)
    } catch (requestError) {
      if (requestID === detailRequestID.current) setError(requestError instanceof APIError ? requestError.message : '无法打开整理表单。')
    } finally {
      if (requestID === detailRequestID.current) setLoadingDetail(false)
    }
  }

  async function saved() {
    setActiveItem(null)
    setRefreshVersion((value) => value + 1)
  }

  async function updated(item: ReviewItem) {
    setActiveItem(item)
    setRefreshVersion((value) => value + 1)
  }

  function resetPageAnd(action: () => void) {
    setPage(1)
    action()
  }

  return (
    <section className="review-panel">
      <div className="section-title">
        <div>
          <p className="eyebrow">待整理</p>
          <h2>{result.total} 本需要确认</h2>
        </div>
        <button className="secondary" type="button" disabled={loading} onClick={() => setRefreshVersion((value) => value + 1)}>刷新队列</button>
      </div>

      <div className="review-queue-filters" aria-label="待整理书目筛选">
        <label className="review-search-field">搜索<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="书名、作者或文件名" /></label>
        <label>格式<select value={format} onChange={(event) => resetPageAnd(() => setFormat(event.target.value as ReviewQueueQuery['format']))}><option value="">全部格式</option><option value="pdf">PDF</option><option value="epub">EPUB</option><option value="mobi">MOBI</option><option value="azw3">AZW3</option></select></label>
        <label>原因<select value={reason} onChange={(event) => resetPageAnd(() => setReason(event.target.value as ReviewQueueQuery['reason']))}><option value="">全部原因</option><option value="metadata">元数据待确认</option><option value="classification">分类建议待确认</option></select></label>
        <label>排序<select value={sort} onChange={(event) => resetPageAnd(() => setSort(event.target.value as ReviewQueueQuery['sort']))}><option value="oldest">最早待整理</option><option value="newest">最近更新</option><option value="title">书名</option></select></label>
      </div>

      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="review-queue-workspace">
        <div className={`review-summary-panel${loading ? ' is-updating' : ''}`}>
          {loading && result.items.length === 0 ? <div className="review-queue-empty">正在加载待整理书目…</div> : result.items.length === 0 ? <div className="review-queue-empty">{result.total === 0 && !debouncedSearch && !format && !reason ? '分类队列已清空。' : '没有符合筛选条件的书籍。'}</div> : result.items.map((item) => (
            <button className={`review-summary-row${activeItem?.editionId === item.editionId ? ' active' : ''}`} type="button" key={item.editionId} onClick={() => void openReview(item.editionId)}>
              <span className={`format-badge ${item.format}`}>{item.format.toUpperCase()}</span>
              <span><strong>{item.title}</strong><small>{item.authors.join('、') || '未知作者'} · Edition {item.editionId}</small><small title={item.originalFilename}>{item.originalFilename}</small></span>
              <span className="review-summary-reasons">{item.metadataPending && <small>元数据 · {item.candidateCount}</small>}{item.suggestedClassificationCount > 0 && <small>分类建议 · {item.suggestedClassificationCount}</small>}</span>
            </button>
          ))}
          {result.totalPages > 1 && <nav className="catalog-pagination" aria-label="待整理书目分页"><button className="secondary" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button><span>第 <strong>{result.page}</strong> / {result.totalPages} 页 · 每页 {result.pageSize} 本</span><button className="secondary" disabled={page >= result.totalPages || loading} onClick={() => setPage((value) => value + 1)}>下一页</button></nav>}
        </div>

        <div className="review-editor-panel">
          {loadingDetail ? <div className="review-queue-empty">正在加载书目证据…</div> : activeItem ? <ReviewCard key={`${activeItem.editionId}-${activeItem.candidates.length}-${activeItem.classifications.length}`} item={activeItem} categories={categories} onSaved={saved} onUpdated={updated} /> : <div className="review-queue-empty"><strong>选择一本书开始整理</strong><span>列表只加载摘要；完整元数据、分类建议和证据会在选中后按需读取。</span></div>}
        </div>
      </div>
    </section>
  )
}

function ReviewCard({ item, categories, onSaved, onUpdated }: { item: ReviewItem; categories: Category[]; onSaved: () => Promise<void>; onUpdated: (item: ReviewItem) => Promise<void> }) {
  const [form, setForm] = useState<ReviewInput>(() => toForm(item))
  const [saving, setSaving] = useState(false)
  const [askingAI, setAskingAI] = useState(false)
  const [searchingBibliography, setSearchingBibliography] = useState(false)
  const [bibliographyMatches, setBibliographyMatches] = useState<BibliographyMatch[]>([])
  const [bibliographyWarnings, setBibliographyWarnings] = useState<string[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    setForm(toForm(item))
    setBibliographyMatches([])
    setBibliographyWarnings([])
  }, [item])

  function update<K extends keyof ReviewInput>(key: K, value: ReviewInput[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function toggleCategory(slug: string) {
    update('categorySlugs', form.categorySlugs.includes(slug)
      ? form.categorySlugs.filter((value) => value !== slug)
      : [...form.categorySlugs, slug])
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api.reviewEdition(item.editionId, form)
      await onSaved()
    } catch (reason) {
      setError(reason instanceof APIError ? reason.message : '保存审核结果失败。')
    } finally {
      setSaving(false)
    }
  }

  async function askAI() {
    setAskingAI(true)
    setError('')
    try {
      const updatedItem = await api.aiClassifyEdition(item.editionId)
      await onUpdated(updatedItem)
    } catch (reason) {
      setError(reason instanceof APIError ? reason.message : 'AI 分类失败。')
    } finally {
      setAskingAI(false)
    }
  }

  async function searchBibliography() {
    setSearchingBibliography(true)
    setError('')
    try {
      const result = await api.searchBibliography(item.editionId)
      setBibliographyMatches(result.matches)
      setBibliographyWarnings(result.warnings)
      if (result.matches.length === 0) setError('外部书目服务没有找到匹配结果。')
    } catch (reason) {
      setError(reason instanceof APIError ? reason.message : '外部书目查询失败。')
    } finally {
      setSearchingBibliography(false)
    }
  }

  function applyBibliographyMatch(match: BibliographyMatch) {
    setForm((current) => ({
      ...current,
      title: match.title || current.title,
      authors: match.authors.length > 0 ? match.authors : current.authors,
      publishedYear: match.publishedYear ?? current.publishedYear,
      language: match.language || current.language,
      isbn: match.isbn || current.isbn,
      publisher: match.publisher || current.publisher,
      description: match.description || current.description,
    }))
  }

  const suggested = item.classifications.filter((decision) => decision.status === 'suggested')

  return (
    <form className="review-card" onSubmit={save}>
      <div className="review-card-heading">
        <div>
          <span className="format-badge">Edition {item.editionId}</span>
          <h3>{form.title}</h3>
        </div>
        <div className="review-provider-actions">
          <button className="quiet external-metadata-button" type="button" onClick={() => void searchBibliography()} disabled={searchingBibliography}>
            {searchingBibliography ? '查询中…' : '查询外部书目'}
          </button>
          <button className="quiet ai-button" type="button" onClick={() => void askAI()} disabled={askingAI}>
            {askingAI ? 'AI 判断中…' : '请求 AI 建议'}
          </button>
        </div>
      </div>

      {error && <div className="notice error" role="alert">{error}</div>}

      {bibliographyMatches.length > 0 && (
        <section className="bibliography-results" aria-label="外部书目候选">
          <div><strong>外部书目候选</strong><span>点击候选会填入表单，保存前仍可编辑。</span></div>
          <div className="bibliography-match-list">
            {bibliographyMatches.map((match) => (
              <button className="bibliography-match" type="button" key={`${match.source}:${match.sourceId}`} onClick={() => applyBibliographyMatch(match)}>
                <span><strong>{match.title}</strong><small>{match.authors.join('、') || '未知作者'}{match.publishedYear ? ` · ${match.publishedYear}` : ''}</small></span>
                <span><b>{Math.round(match.confidence * 100)}%</b><small>{providerLabel(match.source)} · {match.reason}</small></span>
                <small>{[match.publisher, match.isbn, ...match.subjects.slice(0, 3)].filter(Boolean).join(' · ')}</small>
              </button>
            ))}
          </div>
          {bibliographyWarnings.length > 0 && <p className="muted">部分服务异常：{bibliographyWarnings.join('；')}</p>}
        </section>
      )}

      <div className="metadata-form-grid">
        <label>书名<input value={form.title} onChange={(event) => update('title', event.target.value)} required /></label>
        <label>作者<input value={form.authors.join('; ')} onChange={(event) => update('authors', splitAuthors(event.target.value))} placeholder="多个作者用分号分隔" /></label>
        <label>出版年<input type="number" min="0" max="9999" value={form.publishedYear ?? ''} onChange={(event) => update('publishedYear', event.target.value ? Number(event.target.value) : undefined)} /></label>
        <label>语言<input value={form.language} onChange={(event) => update('language', event.target.value)} placeholder="zh-CN" /></label>
        <label>ISBN<input value={form.isbn} onChange={(event) => update('isbn', event.target.value)} /></label>
        <label>出版社<input value={form.publisher} onChange={(event) => update('publisher', event.target.value)} /></label>
      </div>
      <label>简介<textarea value={form.description} onChange={(event) => update('description', event.target.value)} rows={3} /></label>

      {suggested.length > 0 && (
        <div className="suggestion-list">
          {suggested.map((decision) => (
            <button className="suggestion" type="button" key={decision.id} onClick={() => toggleCategory(decision.categorySlug)}>
              <strong>{decision.categoryName}</strong>
              <span>{Math.round(decision.confidence * 100)}% · {decision.source}</span>
              <small>{decision.reason}</small>
            </button>
          ))}
        </div>
      )}

      <fieldset className="category-picker">
        <legend>固定题材分类</legend>
        <div>
          {categories.map((category) => (
            <label key={category.id} className={form.categorySlugs.includes(category.slug) ? 'selected' : ''}>
              <input type="checkbox" checked={form.categorySlugs.includes(category.slug)} onChange={() => toggleCategory(category.slug)} />
              {category.name}
            </label>
          ))}
        </div>
      </fieldset>

      <details className="evidence">
        <summary>查看 {item.candidates.length} 条当前元数据证据</summary>
        <ul>
          {item.candidates.map((candidate) => (
            <li key={candidate.id}><strong>{candidate.fieldName}</strong> · {formatCandidateValue(candidate.value)} · {candidate.source} · {Math.round(candidate.confidence * 100)}% · {candidate.status}</li>
          ))}
        </ul>
      </details>

      <div className="review-actions">
        <span className="muted">选择至少一个题材后，此书会移出待整理。</span>
        <button className="primary" type="submit" disabled={saving}>{saving ? '保存中…' : '保存并确认'}</button>
      </div>
    </form>
  )
}

function toForm(item: ReviewItem): ReviewInput {
  return {
    title: item.title,
    authors: item.authors,
    publishedYear: item.publishedYear,
    language: item.language ?? '',
    isbn: item.isbn ?? '',
    publisher: item.publisher ?? '',
    description: item.description ?? '',
    categorySlugs: item.classifications.filter((decision) => decision.status === 'accepted').map((decision) => decision.categorySlug),
  }
}

function splitAuthors(value: string): string[] {
  return value.split(/[;；]/).map((part) => part.trim()).filter(Boolean)
}

function providerLabel(source: string): string {
  return { openlibrary: 'Open Library', 'google-books': 'Google Books' }[source] ?? source
}

function formatCandidateValue(value: unknown): string {
  const text = Array.isArray(value) ? value.join('、') : typeof value === 'string' ? value : JSON.stringify(value)
  return (text || '—').slice(0, 120)
}

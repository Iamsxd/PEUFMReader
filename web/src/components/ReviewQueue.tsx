import { type FormEvent, useState } from 'react'
import { APIError, api } from '../api'
import type { BibliographyMatch, Category, ReviewInput, ReviewItem } from '../types'

interface Props {
  categories: Category[]
  items: ReviewItem[]
  onChanged: () => Promise<void>
}

export function ReviewQueue({ categories, items, onChanged }: Props) {
  if (items.length === 0) {
    return (
      <section className="review-panel complete-panel">
        <div>
          <p className="eyebrow">待整理</p>
          <h2>分类队列已清空</h2>
          <p className="muted">高置信度内容已自动采用，其余建议会出现在这里。</p>
        </div>
      </section>
    )
  }

  return (
    <section className="review-panel">
      <div className="section-title">
        <div>
          <p className="eyebrow">待整理</p>
          <h2>{items.length} 本需要确认</h2>
        </div>
        <p className="muted">AI 与规则只提供建议，保存前不会覆盖人工选择。</p>
      </div>
      <div className="review-list">
        {items.map((item) => (
          <ReviewCard key={item.editionId} item={item} categories={categories} onChanged={onChanged} />
        ))}
      </div>
    </section>
  )
}

function ReviewCard({ item, categories, onChanged }: { item: ReviewItem; categories: Category[]; onChanged: () => Promise<void> }) {
  const [form, setForm] = useState<ReviewInput>(() => toForm(item))
  const [saving, setSaving] = useState(false)
  const [askingAI, setAskingAI] = useState(false)
  const [searchingBibliography, setSearchingBibliography] = useState(false)
  const [bibliographyMatches, setBibliographyMatches] = useState<BibliographyMatch[]>([])
  const [bibliographyWarnings, setBibliographyWarnings] = useState<string[]>([])
  const [error, setError] = useState('')

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
      await onChanged()
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
      await api.aiClassifyEdition(item.editionId)
      await onChanged()
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

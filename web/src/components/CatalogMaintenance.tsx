import { type FormEvent, useEffect, useState } from 'react'
import { APIError, api } from '../api'
import type { BatchMetadataPatch, BookFile, Category, ClassificationRule, DuplicateCatalogGroup } from '../types'

interface Props {
  categories: Category[]
  onError: (message: string) => void
  onNotice: (message: string) => void
}

export function CatalogMaintenance({ categories, onError, onNotice }: Props) {
  const [query, setQuery] = useState('')
  const [books, setBooks] = useState<BookFile[]>([])
  const [selected, setSelected] = useState<number[]>([])
  const [rules, setRules] = useState<ClassificationRule[]>([])
  const [duplicates, setDuplicates] = useState<DuplicateCatalogGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [reclassifying, setReclassifying] = useState(false)

  async function loadMaintenance() {
    setLoading(true)
    try {
      const [ruleItems, duplicateItems] = await Promise.all([api.listClassificationRules(), api.listDuplicateCatalogGroups()])
      setRules(ruleItems)
      setDuplicates(duplicateItems)
    } catch (reason) {
      onError(reason instanceof APIError ? reason.message : '目录维护数据加载失败。')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadMaintenance() }, [])

  async function search(event: FormEvent) {
    event.preventDefault()
    try {
      const page = await api.listBooks({ q: query, pageSize: 50, sort: query.trim() ? 'relevance' : 'newest' })
      setBooks(page.items)
      setSelected([])
    } catch (reason) {
      onError(reason instanceof APIError ? reason.message : '书籍搜索失败。')
    }
  }

  function toggleEdition(editionID: number) {
    setSelected((current) => current.includes(editionID) ? current.filter((id) => id !== editionID) : [...current, editionID])
  }

  async function reclassifyUnclassified() {
    if (!window.confirm('将使用当前规则重新分析所有尚无已接受分类的书籍。人工分类不会被修改，是否继续？')) return
    setReclassifying(true)
    onError('')
    try {
      const result = await api.reclassifyUnclassified()
      onNotice(result.created ? `重新分类任务 #${result.job.id} 已排队，可在后台任务中查看进度。` : `重新分类任务 #${result.job.id} 已在运行。`)
    } catch (reason) {
      onError(reason instanceof APIError ? reason.message : '重新分类任务创建失败。')
    } finally {
      setReclassifying(false)
    }
  }

  return (
    <>
      <section className="integration-panel catalog-maintenance-panel">
        <div className="section-title">
          <div><p className="eyebrow">批量书目维护</p><h2>批量修改与重复合并</h2><p className="muted">先搜索并选择版本，再统一修改出版信息或分类。合并操作保留书籍文件和用户阅读记录。</p></div>
        </div>
        <form className="catalog-maintenance-search" onSubmit={search}>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索书名、作者、ISBN 或出版社" />
          <button className="secondary" type="submit">搜索书库</button>
        </form>
        {books.length > 0 && (
          <div className="catalog-maintenance-results">
            {books.map((book) => (
              <label key={book.id} className={selected.includes(book.editionId) ? 'selected' : ''}>
                <input type="checkbox" checked={selected.includes(book.editionId)} onChange={() => toggleEdition(book.editionId)} />
                <span><strong>{book.title}</strong><small>Work {book.workId} · Edition {book.editionId} · {book.format.toUpperCase()} · {book.authors.join('、') || '未知作者'}</small></span>
              </label>
            ))}
          </div>
        )}
        <BatchMetadataForm editionIDs={selected} categories={categories} onError={onError} onNotice={onNotice} />

        <div className="duplicate-heading"><strong>疑似重复作品 / 版本</strong><span>{duplicates.length} 组</span></div>
        <div className="duplicate-group-list">
          {duplicates.length === 0 && <p className="muted">没有检测到同名作品或重复 ISBN。</p>}
          {duplicates.map((group) => <DuplicateGroup key={`${group.kind}:${group.key}`} group={group} onChanged={loadMaintenance} onError={onError} onNotice={onNotice} />)}
        </div>
      </section>

      <section className="integration-panel classification-rule-panel">
        <div className="section-title">
          <div><p className="eyebrow">可视化分类规则</p><h2>{rules.filter((rule) => rule.enabled).length} 条规则已启用</h2><p className="muted">强关键词仅凭书名即可自动分类；普通关键词需要题材或多项证据。排序值越小，同分时越优先。</p></div>
          <button className="secondary" type="button" disabled={reclassifying} onClick={() => void reclassifyUnclassified()}>{reclassifying ? '正在创建任务…' : '重新分类未归类书籍'}</button>
        </div>
        {loading ? <p className="muted">正在加载分类规则…</p> : (
          <div className="classification-rule-grid">
            {rules.map((rule) => <ClassificationRuleCard key={rule.id} rule={rule} onSaved={(saved) => setRules((items) => items.map((item) => item.id === saved.id ? saved : item))} onError={onError} />)}
          </div>
        )}
      </section>
    </>
  )
}

function BatchMetadataForm({ editionIDs, categories, onError, onNotice }: { editionIDs: number[]; categories: Category[]; onError: (message: string) => void; onNotice: (message: string) => void }) {
  const [language, setLanguage] = useState('')
  const [publisher, setPublisher] = useState('')
  const [year, setYear] = useState('')
  const [categoryMode, setCategoryMode] = useState<'add' | 'replace'>('add')
  const [categorySlugs, setCategorySlugs] = useState<string[]>([])
  const [applyLanguage, setApplyLanguage] = useState(false)
  const [applyPublisher, setApplyPublisher] = useState(false)
  const [applyYear, setApplyYear] = useState(false)
  const [applyCategories, setApplyCategories] = useState(false)
  const [saving, setSaving] = useState(false)

  async function save(event: FormEvent) {
    event.preventDefault()
    if (editionIDs.length === 0) return
    const input: BatchMetadataPatch = { editionIds: editionIDs }
    if (applyLanguage) input.language = language
    if (applyPublisher) input.publisher = publisher
    if (applyYear && year) input.publishedYear = Number(year)
    if (applyCategories) {
      input.categoryMode = categoryMode
      input.categorySlugs = categorySlugs
    }
    setSaving(true)
    onError('')
    try {
      const result = await api.batchUpdateMetadata(input)
      onNotice(`已批量更新 ${result.updated} 个版本。`)
    } catch (reason) {
      onError(reason instanceof APIError ? reason.message : '批量修改失败。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="batch-metadata-form" onSubmit={save}>
      <strong>已选择 {editionIDs.length} 个版本</strong>
      <label><input type="checkbox" checked={applyLanguage} onChange={(event) => setApplyLanguage(event.target.checked)} />语言<input value={language} onChange={(event) => setLanguage(event.target.value)} placeholder="zh-CN" disabled={!applyLanguage} /></label>
      <label><input type="checkbox" checked={applyPublisher} onChange={(event) => setApplyPublisher(event.target.checked)} />出版社<input value={publisher} onChange={(event) => setPublisher(event.target.value)} disabled={!applyPublisher} /></label>
      <label><input type="checkbox" checked={applyYear} onChange={(event) => setApplyYear(event.target.checked)} />出版年<input type="number" min="0" max="9999" value={year} onChange={(event) => setYear(event.target.value)} disabled={!applyYear} /></label>
      <fieldset disabled={!applyCategories}>
        <legend><label><input type="checkbox" checked={applyCategories} onChange={(event) => setApplyCategories(event.target.checked)} />分类</label></legend>
        <select value={categoryMode} onChange={(event) => setCategoryMode(event.target.value as 'add' | 'replace')}><option value="add">追加分类</option><option value="replace">替换分类</option></select>
        <div>{categories.map((category) => <label key={category.id}><input type="checkbox" checked={categorySlugs.includes(category.slug)} onChange={() => setCategorySlugs((items) => items.includes(category.slug) ? items.filter((slug) => slug !== category.slug) : [...items, category.slug])} />{category.name}</label>)}</div>
      </fieldset>
      <button className="primary" type="submit" disabled={saving || editionIDs.length === 0 || !(applyLanguage || applyPublisher || applyYear || applyCategories)}>{saving ? '批量保存中…' : '应用批量修改'}</button>
    </form>
  )
}

function DuplicateGroup({ group, onChanged, onError, onNotice }: { group: DuplicateCatalogGroup; onChanged: () => Promise<void>; onError: (message: string) => void; onNotice: (message: string) => void }) {
  const target = group.items[0]
  const [busy, setBusy] = useState('')

  async function merge(sourceIndex: number, kind: 'work' | 'edition') {
    const source = group.items[sourceIndex]
    if (!window.confirm(`将 ${kind === 'work' ? `Work ${source.workId}` : `Edition ${source.editionId}`} 合并到 ${kind === 'work' ? `Work ${target.workId}` : `Edition ${target.editionId}`}？此操作不可自动撤销。`)) return
    setBusy(`${sourceIndex}-${kind}`)
    onError('')
    try {
      if (kind === 'work') await api.mergeWorks(source.workId, target.workId)
      else await api.mergeEditions(source.editionId, target.editionId)
      onNotice('合并完成，书籍文件和阅读记录已保留。')
      await onChanged()
    } catch (reason) {
      onError(reason instanceof APIError ? reason.message : '合并失败。')
    } finally {
      setBusy('')
    }
  }

  return (
    <article className="duplicate-group">
      <header><strong>{group.kind === 'isbn' ? `ISBN ${group.key}` : group.key}</strong><span>{group.items.length} 项 · 第一项作为目标</span></header>
      {group.items.map((item, index) => (
        <div key={item.editionId}>
          <span><b>{item.title}</b><small>Work {item.workId} · Edition {item.editionId} · {item.format.toUpperCase()} · {item.originalFilename}</small></span>
          {index > 0 && <span className="duplicate-actions"><button type="button" disabled={Boolean(busy)} onClick={() => void merge(index, 'edition')}>合并版本</button><button type="button" disabled={Boolean(busy) || item.workId === target.workId} onClick={() => void merge(index, 'work')}>合并作品</button></span>}
        </div>
      ))}
    </article>
  )
}

function ClassificationRuleCard({ rule, onSaved, onError }: { rule: ClassificationRule; onSaved: (rule: ClassificationRule) => void; onError: (message: string) => void }) {
  const [keywords, setKeywords] = useState(rule.keywords.join('、'))
  const [strongKeywords, setStrongKeywords] = useState(rule.strongKeywords.join('、'))
  const [enabled, setEnabled] = useState(rule.enabled)
  const [priority, setPriority] = useState(rule.priority)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    onError('')
    try {
      const saved = await api.updateClassificationRule(rule.id, {
        keywords: keywords.split(/[、,，;；\n]/).map((item) => item.trim()).filter(Boolean),
        strongKeywords: strongKeywords.split(/[、,，;；\n]/).map((item) => item.trim()).filter(Boolean),
        enabled, priority,
      })
      onSaved(saved)
    } catch (reason) {
      onError(reason instanceof APIError ? reason.message : '分类规则保存失败。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <article className={enabled ? '' : 'disabled'}>
      <header><strong>{rule.categoryName}</strong><label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用</label></header>
      <label>强关键词<textarea rows={2} value={strongKeywords} onChange={(event) => setStrongKeywords(event.target.value)} aria-label={`${rule.categoryName}强关键词`} /></label>
      <label>普通关键词<textarea rows={2} value={keywords} onChange={(event) => setKeywords(event.target.value)} aria-label={`${rule.categoryName}普通关键词`} /></label>
      <footer><label>排序 <input type="number" min="1" max="10000" value={priority} onChange={(event) => setPriority(Number(event.target.value))} /></label><button className="secondary" type="button" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存规则'}</button></footer>
    </article>
  )
}

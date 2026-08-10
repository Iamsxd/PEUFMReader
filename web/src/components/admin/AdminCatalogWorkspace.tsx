import { type FormEvent, useEffect, useState } from 'react'
import { APIError, api } from '../../api'
import type { AIClassificationPreview, BibliographySource, BibliographySourceInput, Category } from '../../types'
import { formatRelativeTime } from '../../utils'
import { CatalogMaintenance } from '../CatalogMaintenance'
import { ReviewQueue } from '../ReviewQueue'

interface Props {
  initialEditionID?: number
  onReviewTotalChange: (total: number) => void
  onError: (message: string) => void
  onNotice: (message: string) => void
  onDataChanged: () => void
}

export default function AdminCatalogWorkspace({ initialEditionID, onReviewTotalChange, onError, onNotice, onDataChanged }: Props) {
  const [categories, setCategories] = useState<Category[]>([])
  const [adminCategories, setAdminCategories] = useState<Category[]>([])
  const [bibliographySources, setBibliographySources] = useState<BibliographySource[]>([])

  async function refreshCatalog() {
    const [active, all, sources] = await Promise.all([api.listCategories(), api.listAdminCategories(), api.listBibliographySources()])
    setCategories(active)
    setAdminCategories(all)
    setBibliographySources(sources)
  }

  async function refreshCategories() {
    const [active, all] = await Promise.all([api.listCategories(), api.listAdminCategories()])
    setCategories(active)
    setAdminCategories(all)
    onDataChanged()
  }

  useEffect(() => {
    void refreshCatalog().catch((reason) => onError(reason instanceof APIError ? reason.message : '无法加载书目与分类工作区。'))
  }, [])

  return <div className="admin-workspace-module">
    <AIClassificationPanel onError={onError} onNotice={onNotice} />
    <ReviewQueue categories={categories} initialEditionID={initialEditionID} onTotalChange={onReviewTotalChange} />
    <CategoryManager categories={adminCategories} onError={onError} onChanged={refreshCategories} />
    <CatalogMaintenance categories={categories} onError={onError} onNotice={onNotice} />
    <BibliographySourceManager sources={bibliographySources} onError={onError} onNotice={onNotice} onChanged={async () => setBibliographySources(await api.listBibliographySources())} />
  </div>
}

function AIClassificationPanel({ onError, onNotice }: { onError: (message: string) => void; onNotice: (message: string) => void }) {
  const [preview, setPreview] = useState<AIClassificationPreview | null>(null)
  const [busy, setBusy] = useState<'test' | 'batch' | ''>('')

  async function refresh() {
    setPreview(await api.getAIClassificationPreview())
  }

  useEffect(() => {
    void refresh().catch((reason) => onError(reason instanceof APIError ? reason.message : '无法读取 AI 分类状态。'))
  }, [])

  async function testConnection() {
    setBusy('test')
    onError('')
    onNotice('')
    try {
      await api.testAIClassification()
      onNotice('AI 服务连接正常，尚未发送任何书籍信息。')
    } catch (reason) {
      onError(reason instanceof APIError ? reason.message : 'AI 连接测试失败。')
    } finally {
      setBusy('')
    }
  }

  async function enqueue(limit: number) {
    if (!preview) return
    const batchSize = Math.min(limit, preview.unclassifiedCount, preview.maxBatchSize)
    if (batchSize < 1 || !window.confirm(`将把 ${batchSize} 本书的书名、作者、摘要、主题和现有分类发送给已配置的 AI 服务。不会发送正文，所有结果仍需人工确认。是否继续？`)) return
    setBusy('batch')
    onError('')
    onNotice('')
    try {
      const result = await api.enqueueAIClassification(batchSize)
      onNotice(result.created ? `AI 分类任务 #${result.job.id} 已排队，将处理 ${result.limit} 本书；完成后请在待整理中确认建议。` : `AI 分类任务 #${result.job.id} 已在处理或排队中。`)
    } catch (reason) {
      onError(reason instanceof APIError ? reason.message : 'AI 分类任务创建失败。')
    } finally {
      setBusy('')
    }
  }

  const canClassify = Boolean(preview?.configured && preview.activeCategoryCount > 0 && preview.unclassifiedCount > 0)
  const firstBatch = Math.min(50, preview?.unclassifiedCount ?? 0)
  const allBatch = Math.min(preview?.unclassifiedCount ?? 0, preview?.maxBatchSize ?? 0)
  return <section className="integration-panel ai-classification-panel">
    <div className="section-title"><div><p className="eyebrow">DeepSeek / AI 分类建议</p><h2>批量给未归类书籍生成建议</h2><p className="muted">先测试连接，再选择小批量或全部处理。AI 只给建议，不会直接改动已确认分类。</p></div><span className={`source-status ${preview?.configured ? 'healthy' : 'failed'}`}>{preview?.configured ? '已配置' : '尚未配置'}</span></div>
    {preview ? <>
      <div className="ai-classification-summary"><div><strong>{preview.unclassifiedCount}</strong><span>本尚无已确认分类</span></div><div><strong>{preview.activeCategoryCount}</strong><span>个可供选择的启用分类</span></div><div><strong>{preview.maxBatchSize}</strong><span>本为单次任务上限</span></div></div>
      <p className="ai-classification-provider">当前服务：{preview.configured ? `${providerLabel(preview.provider)} · ${preview.model || '未设置模型'}` : '请在服务器 .env 中设置 AI_PROVIDER、AI_MODEL 和 AI_API_KEY 后重新部署。'}</p>
      <div className="ai-classification-actions"><button className="secondary" type="button" disabled={!preview.configured || Boolean(busy)} onClick={() => void testConnection()}>{busy === 'test' ? '测试中…' : '测试连接'}</button><button className="secondary" type="button" disabled={!canClassify || Boolean(busy)} onClick={() => void enqueue(firstBatch)}>{busy === 'batch' ? '正在排队…' : `先分类 ${firstBatch} 本`}</button><button className="primary" type="button" disabled={!canClassify || Boolean(busy)} onClick={() => void enqueue(allBatch)}>{allBatch < (preview.unclassifiedCount ?? 0) ? `分类前 ${allBatch} 本` : `分类全部 ${allBatch} 本`}</button></div>
      {!preview.activeCategoryCount && <p className="source-last-error">请先至少启用一个固定分类，再启动 AI 分类。</p>}
    </> : <p className="muted">正在读取 AI 分类状态…</p>}
    <p className="ai-classification-privacy-note">隐私说明：仅发送书名、作者、出版年份、语言、摘要、主题和可选分类；不发送电子书正文、文件内容、阅读进度或用户信息。任务逐本限速，单次最多处理 5000 本，可在“任务与运维”查看进度和失败原因。</p>
  </section>
}

function providerLabel(provider?: string): string {
  return provider === 'deepseek' ? 'DeepSeek' : provider === 'ollama' ? 'Ollama' : provider === 'openai-compatible' ? '兼容云端 AI' : provider || '未配置'
}

function BibliographySourceManager({ sources, onChanged, onError, onNotice }: {
  sources: BibliographySource[]
  onChanged: () => Promise<void>
  onError: (message: string) => void
  onNotice: (message: string) => void
}) {
  return (
    <section className="integration-panel bibliography-source-panel">
      <div className="section-title"><div><p className="eyebrow">外部书目信息源</p><h2>元数据查询与导入建议</h2><p className="muted">自动查询只添加待确认建议，不会覆盖现有书名、作者或分类。优先级数字越小越靠前。</p></div></div>
      <div className="bibliography-source-list">
        {sources.map((source) => <BibliographySourceCard key={source.id} source={source} onChanged={onChanged} onError={onError} onNotice={onNotice} />)}
        {sources.length === 0 && <p className="job-empty">没有可配置的书目信息源。</p>}
      </div>
      <p className="bibliography-privacy-note">启用公网服务时，书名、作者、ISBN 和语言可能发送给第三方；豆瓣地址可填写 NAS 局域网中的 douban-api-rs 服务。</p>
    </section>
  )
}

function BibliographySourceCard({ source, onChanged, onError, onNotice }: {
  source: BibliographySource
  onChanged: () => Promise<void>
  onError: (message: string) => void
  onNotice: (message: string) => void
}) {
  const [input, setInput] = useState<BibliographySourceInput>(() => sourceInput(source))
  const [busy, setBusy] = useState<'save' | 'test' | ''>('')

  useEffect(() => setInput(sourceInput(source)), [source])

  function change<K extends keyof BibliographySourceInput>(key: K, value: BibliographySourceInput[K]) {
    setInput((current) => ({ ...current, [key]: value }))
  }

  async function save(testAfterSave = false) {
    setBusy(testAfterSave ? 'test' : 'save')
    onError('')
    onNotice('')
    try {
      await api.updateBibliographySource(source.id, { ...input, baseUrl: input.baseUrl.trim() })
      if (testAfterSave) {
        const response = await api.testBibliographySource(source.id)
        if (response.result.success) onNotice(`${bibliographySourceLabel(source.provider)}连接成功，响应 ${response.result.latencyMs} ms。`)
        else onError(`${bibliographySourceLabel(source.provider)}连接失败：${response.result.error || '未知错误'}`)
      } else {
        onNotice(`${bibliographySourceLabel(source.provider)}设置已保存。`)
      }
      await onChanged()
    } catch (reason) {
      onError(reason instanceof APIError ? reason.message : testAfterSave ? '连接测试失败。' : '书目信息源保存失败。')
    } finally {
      setBusy('')
    }
  }

  const status = source.lastCheckedAt ? source.lastError ? 'failed' : 'healthy' : 'untested'
  return (
    <article className={`bibliography-source-card ${source.enabled ? 'enabled' : 'disabled'}`}>
      <div className="bibliography-source-heading"><div><span className={`source-status ${status}`}>{status === 'healthy' ? '连接正常' : status === 'failed' ? '最近失败' : '尚未测试'}</span><h3>{bibliographySourceLabel(source.provider)}</h3><p>{bibliographySourceDescription(source.provider)}</p></div><label className="source-toggle"><input type="checkbox" checked={input.enabled} onChange={(event) => change('enabled', event.target.checked)} /><span>启用查询</span></label></div>
      <div className="bibliography-source-form"><label className="source-url-field"><span>服务地址</span><input type="url" value={input.baseUrl} onChange={(event) => change('baseUrl', event.target.value)} placeholder={source.provider === 'douban' ? 'http://192.168.3.118:5890' : 'https://…'} maxLength={2048} required={input.enabled} /></label><label><span>优先级</span><input type="number" min={1} max={1000} value={input.priority} onChange={(event) => change('priority', Number(event.target.value))} /></label><label><span>超时（秒）</span><input type="number" min={1} max={60} value={input.timeoutMs / 1000} onChange={(event) => change('timeoutMs', Math.round(Number(event.target.value) * 1000))} /></label><label><span>最大候选数</span><input type="number" min={1} max={20} value={input.maxResults} onChange={(event) => change('maxResults', Number(event.target.value))} /></label></div>
      <div className="bibliography-source-footer"><label className="auto-source-toggle"><input type="checkbox" checked={input.autoSearch} onChange={(event) => change('autoSearch', event.target.checked)} /><span>导入后自动查询建议</span></label><div className="source-actions"><button className="secondary" type="button" disabled={Boolean(busy)} onClick={() => void save(true)}>{busy === 'test' ? '测试中…' : '保存并测试'}</button><button className="primary" type="button" disabled={Boolean(busy)} onClick={() => void save(false)}>{busy === 'save' ? '保存中…' : '保存设置'}</button></div></div>
      <dl className="bibliography-source-health"><div><dt>最近成功</dt><dd>{source.lastSuccessAt ? formatRelativeTime(source.lastSuccessAt) : '暂无'}</dd></div><div><dt>最近检查</dt><dd>{source.lastCheckedAt ? formatRelativeTime(source.lastCheckedAt) : '暂无'}</dd></div><div><dt>响应耗时</dt><dd>{source.lastLatencyMs === undefined ? '暂无' : `${source.lastLatencyMs} ms`}</dd></div></dl>
      {source.lastError && <p className="source-last-error" title={source.lastError}>最近错误：{source.lastError}</p>}
    </article>
  )
}

function sourceInput(source: BibliographySource): BibliographySourceInput {
  return { enabled: source.enabled, baseUrl: source.baseUrl, priority: source.priority, timeoutMs: source.timeoutMs, maxResults: source.maxResults, autoSearch: source.autoSearch }
}

function bibliographySourceLabel(provider: string): string {
  return { douban: '豆瓣书目（douban-api-rs）', openlibrary: 'Open Library', 'google-books': 'Google Books' }[provider] ?? provider
}

function bibliographySourceDescription(provider: string): string {
  return { douban: '中文书籍、作者、出版社、标签和封面信息', openlibrary: '开放书目数据，适合 ISBN 与外文书籍补全', 'google-books': 'Google Books 书目与封面，需要在环境变量配置 API Key' }[provider] ?? '外部书目信息服务'
}

function CategoryManager({ categories, onChanged, onError }: { categories: Category[]; onChanged: () => Promise<void>; onError: (message: string) => void }) {
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [parentID, setParentID] = useState('')
  const [creating, setCreating] = useState(false)
  const activeCount = categories.filter((category) => category.active).length
  const roots = categories.filter((category) => !category.parentId && category.active)

  async function create(event: FormEvent) {
    event.preventDefault()
    setCreating(true)
    onError('')
    try {
      await api.createCategory({ slug, name, parentId: parentID ? Number(parentID) : undefined })
      setSlug('')
      setName('')
      setParentID('')
      await onChanged()
    } catch (reason) {
      onError(reason instanceof APIError ? reason.message : '分类创建失败。')
    } finally {
      setCreating(false)
    }
  }

  return (
    <section className="integration-panel category-management-panel">
      <div className="section-title"><div><p className="eyebrow">固定题材体系</p><h2>{activeCount} 个启用分类 · {roots.length} 个主类</h2><p className="muted">父类筛选会包含全部子类；停用不会删除已有书籍分类记录。</p></div></div>
      <form className="category-create-form" onSubmit={create}><input value={name} onChange={(event) => setName(event.target.value)} placeholder="分类名称，如 建筑设计" maxLength={60} required /><input value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase())} placeholder="固定标识，如 architecture" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxLength={80} required /><select value={parentID} onChange={(event) => setParentID(event.target.value)} aria-label="父分类"><option value="">作为主类</option>{categories.filter((category) => category.active).map((category) => <option key={category.id} value={category.id}>{category.parentId ? `↳ ${category.name}` : category.name}</option>)}</select><button className="primary" type="submit" disabled={creating}>{creating ? '添加中…' : '添加分类'}</button></form>
      <div className="category-management-list">{categories.map((category) => <CategoryManagementRow key={category.id} category={category} categories={categories} onChanged={onChanged} onError={onError} />)}</div>
    </section>
  )
}

function CategoryManagementRow({ category, categories, onChanged, onError }: { category: Category; categories: Category[]; onChanged: () => Promise<void>; onError: (message: string) => void }) {
  const [name, setName] = useState(category.name)
  const [parentID, setParentID] = useState(category.parentId ? String(category.parentId) : '')
  const [saving, setSaving] = useState(false)

  useEffect(() => { setName(category.name); setParentID(category.parentId ? String(category.parentId) : '') }, [category.name, category.parentId])

  async function save(active = Boolean(category.active)) {
    setSaving(true)
    onError('')
    try {
      await api.updateCategory(category.id, { name, parentId: parentID ? Number(parentID) : undefined, active })
      await onChanged()
    } catch (reason) {
      onError(reason instanceof APIError ? reason.message : '分类更新失败。')
    } finally {
      setSaving(false)
    }
  }

  return <div className={`category-management-row${category.active ? '' : ' inactive'}`}><span className="category-identity"><strong>{category.parentId ? '↳ ' : ''}{category.slug}</strong><small>{category.bookCount ?? 0} 本 · {category.system ? '内置' : '自定义'}</small></span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} aria-label={`${category.slug} 分类名称`} /><select value={parentID} onChange={(event) => setParentID(event.target.value)} aria-label={`${category.slug} 父分类`}><option value="">主类</option>{categories.filter((candidate) => candidate.id !== category.id && candidate.active && !isDescendantCandidate(candidate, category, categories)).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.parentId ? `↳ ${candidate.name}` : candidate.name}</option>)}</select><button className="secondary" type="button" disabled={saving || !name.trim()} onClick={() => void save()}>{saving ? '保存中' : '保存'}</button><button className={category.active ? 'quiet danger-text' : 'quiet'} type="button" disabled={saving || category.slug === 'other'} onClick={() => void save(!category.active)}>{category.active ? '停用' : '启用'}</button></div>
}

function isDescendantCandidate(candidate: Category, category: Category, categories: Category[]): boolean {
  let current: Category | undefined = candidate
  const visited = new Set<number>()
  while (current?.parentId && !visited.has(current.id)) {
    if (current.parentId === category.id) return true
    visited.add(current.id)
    current = categories.find((item) => item.id === current?.parentId)
  }
  return false
}

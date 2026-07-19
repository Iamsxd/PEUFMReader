import { type ChangeEvent, type DragEvent, type FormEvent, useEffect, useMemo, useState } from 'react'
import { APIError, api } from '../api'
import type { AuditEvent, BackgroundJob, CalibrePreview, Category, ImportJob, ReviewItem, StorageAuditReport, User } from '../types'
import { formatBytes, formatRelativeTime } from '../utils'
import { ReviewQueue } from './ReviewQueue'

interface Props {
  initialEditionID?: number
}

type UploadState = 'queued' | 'uploading' | 'processing' | 'completed' | 'duplicate' | 'failed'

interface UploadItem {
  id: string
  file: File
  state: UploadState
  progress: number
  message: string
}

export function AdminPage({ initialEditionID }: Props) {
  const [categories, setCategories] = useState<Category[]>([])
  const [adminCategories, setAdminCategories] = useState<Category[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([])
  const [manualReviewItem, setManualReviewItem] = useState<ReviewItem | null>(null)
  const [importJobs, setImportJobs] = useState<ImportJob[]>([])
  const [backgroundJobs, setBackgroundJobs] = useState<BackgroundJob[]>([])
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([])
  const [storageReport, setStorageReport] = useState<StorageAuditReport | null>(null)
  const [calibrePreview, setCalibrePreview] = useState<CalibrePreview | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [uploading, setUploading] = useState(false)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const [scanningCalibre, setScanningCalibre] = useState(false)
  const [migratingCalibre, setMigratingCalibre] = useState(false)
  const [checkingStorage, setCheckingStorage] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')

  async function refreshAdmin() {
    try {
      const [categoryItems, managedCategories, userItems, queueItems, jobs, asyncJobs, audits] = await Promise.all([
        api.listCategories(), api.listAdminCategories(), api.listUsers(), api.listReviewQueue(), api.listImportJobs(), api.listBackgroundJobs(), api.listAuditEvents(),
      ])
      setCategories(categoryItems)
      setAdminCategories(managedCategories)
      setUsers(userItems)
      setReviewItems(queueItems)
      setImportJobs(jobs)
      setBackgroundJobs(asyncJobs)
      setAuditEvents(audits)
    } catch (reason) {
      setError(reason instanceof APIError ? reason.message : '无法加载管理后台。')
    }
  }

  useEffect(() => { void refreshAdmin() }, [])

  useEffect(() => {
    if (!initialEditionID) return
    void api.getEditionReview(initialEditionID).then((item) => {
      setManualReviewItem(item)
      window.setTimeout(() => document.querySelector('.review-panel')?.scrollIntoView({ behavior: 'smooth' }), 0)
    }).catch((reason) => setError(reason instanceof APIError ? reason.message : '无法打开整理表单。'))
  }, [initialEditionID])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void api.listBackgroundJobs().then(async (jobs) => {
        setBackgroundJobs(jobs)
        if (jobs.some((job) => job.state === 'queued' || job.state === 'running')) {
          const [queueItems, imports] = await Promise.all([api.listReviewQueue(), api.listImportJobs()])
          setReviewItems(queueItems)
          setImportJobs(imports)
        }
      }).catch(() => undefined)
    }, 2000)
    return () => window.clearInterval(timer)
  }, [])

  const visibleReviewItems = useMemo(() => {
    if (!manualReviewItem || reviewItems.some((item) => item.editionId === manualReviewItem.editionId)) return reviewItems
    return [manualReviewItem, ...reviewItems]
  }, [manualReviewItem, reviewItems])

  function changeUpload(id: string, update: Partial<Omit<UploadItem, 'id' | 'file'>>) {
    setUploads((current) => current.map((item) => item.id === id ? { ...item, ...update } : item))
  }

  async function uploadFiles(files: File[]) {
    if (uploading || files.length === 0) return
    const accepted = files.filter((file) => /\.(pdf|epub)$/i.test(file.name))
    const rejected = files.length - accepted.length
    if (accepted.length === 0) {
      setError('请选择 PDF 或 EPUB 文件。')
      return
    }
    const batch = accepted.map((file, index): UploadItem => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${index}`,
      file,
      state: 'queued',
      progress: 0,
      message: '等待上传',
    }))
    setUploads(batch)
    setUploading(true)
    setError('')
    setNotice('')

    let cursor = 0
    let completed = 0
    let duplicated = 0
    let failed = 0
    async function worker() {
      while (cursor < batch.length) {
        const item = batch[cursor++]
        changeUpload(item.id, { state: 'uploading', message: '正在上传' })
        try {
          const result = await api.uploadBook(item.file, (progress) => {
            changeUpload(item.id, {
              progress,
              state: progress >= 100 ? 'processing' : 'uploading',
              message: progress >= 100 ? '正在提取元数据并分类' : `正在上传 ${progress}%`,
            })
          })
          if (result.duplicate) {
            duplicated++
            changeUpload(item.id, { state: 'duplicate', progress: 100, message: '文件已存在，沿用原记录' })
          } else {
            completed++
            changeUpload(item.id, { state: 'completed', progress: 100, message: `已导入《${result.bookFile.title}》` })
          }
        } catch (reason) {
          failed++
          changeUpload(item.id, { state: 'failed', message: reason instanceof APIError ? reason.message : '上传失败' })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, batch.length) }, () => worker()))
    setUploading(false)
    setNotice(`批量导入完成：新增 ${completed} 本，重复 ${duplicated} 本，失败 ${failed} 本${rejected ? `，忽略 ${rejected} 个非 PDF/EPUB 文件` : ''}。`)
    await refreshAdmin()
  }

  function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    void uploadFiles(files)
  }

  function dropFiles(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    setDraggingFiles(false)
    if (!uploading) void uploadFiles(Array.from(event.dataTransfer.files))
  }

  async function createReader(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      await api.createUser(newUsername, newPassword, 'reader')
      setNewUsername('')
      setNewPassword('')
      setUsers(await api.listUsers())
    } catch (reason) {
      setError(reason instanceof APIError ? reason.message : '用户创建失败。')
    }
  }

  async function scanCalibre() {
    setScanningCalibre(true)
    setError('')
    try {
      setCalibrePreview(await api.previewCalibre())
    } catch (reason) {
      setError(reason instanceof APIError ? reason.message : 'Calibre 书库扫描失败。')
    } finally {
      setScanningCalibre(false)
    }
  }

  async function migrateCalibre() {
    setMigratingCalibre(true)
    setError('')
    try {
      const result = await api.importCalibre()
      setNotice(`Calibre 迁移已排队：新增 ${result.queued} 项，已有 ${result.existing} 项。任务可在服务重启后继续。`)
      setBackgroundJobs(await api.listBackgroundJobs())
    } catch (reason) {
      setError(reason instanceof APIError ? reason.message : 'Calibre 迁移排队失败。')
    } finally {
      setMigratingCalibre(false)
    }
  }

  async function retryJob(jobID: number) {
    setError('')
    try {
      await api.retryBackgroundJob(jobID)
      setBackgroundJobs(await api.listBackgroundJobs())
    } catch (reason) {
      setError(reason instanceof APIError ? reason.message : '任务重试失败。')
    }
  }

  async function checkStorage(deep: boolean) {
    setCheckingStorage(true)
    setError('')
    try {
      setStorageReport(await api.auditStorage(deep))
    } catch (reason) {
      setError(reason instanceof APIError ? reason.message : '书库一致性检查失败。')
    } finally {
      setCheckingStorage(false)
    }
  }

  async function reviewChanged() {
    setManualReviewItem(null)
    await refreshAdmin()
  }

  return (
    <div className="admin-page">
      <section className="page-heading admin-heading">
        <div><p className="eyebrow">系统管理</p><h1>管理后台</h1><p className="muted">导入书籍、确认分类、管理用户和检查后台任务。</p></div>
        <label className={`upload-button ${uploading ? 'disabled' : ''}`}>
          {uploading ? '正在批量导入…' : '选择 EPUB / PDF'}
          <input type="file" multiple accept=".epub,.pdf,application/epub+zip,application/pdf" onChange={selectFiles} disabled={uploading} />
        </label>
      </section>

      {error && <div className="notice error" role="alert">{error}</div>}
      {notice && <div className="notice success" role="status">{notice}</div>}

      <section
        className={`upload-drop-zone${draggingFiles ? ' dragging' : ''}${uploading ? ' busy' : ''}`}
        onDragEnter={(event) => { event.preventDefault(); if (!uploading) setDraggingFiles(true) }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false) }}
        onDrop={dropFiles}
      >
        <div><p className="eyebrow">批量导入</p><h2>{uploading ? '正在处理导入队列' : '拖放 PDF / EPUB 到这里'}</h2><p className="muted">每次最多 2 本并行处理；文件会复制到应用书库，原上传文件不受影响。</p></div>
        {uploads.length > 0 && (
          <div className="upload-queue" aria-live="polite">
            {uploads.map((item) => (
              <div className="upload-queue-item" key={item.id}>
                <span className={`job-state ${item.state}`}>{uploadStateLabel(item.state)}</span>
                <span><strong>{item.file.name}</strong><small>{item.message}</small></span>
                <span className="job-progress"><i><b style={{ width: `${item.progress}%` }} /></i><small>{item.progress}%</small></span>
              </div>
            ))}
          </div>
        )}
      </section>

      <CategoryManager
        categories={adminCategories}
        onError={setError}
        onChanged={async () => {
          const [active, all] = await Promise.all([api.listCategories(), api.listAdminCategories()])
          setCategories(active)
          setAdminCategories(all)
        }}
      />

      <ReviewQueue categories={categories} items={visibleReviewItems} onChanged={reviewChanged} />

      <section className="integration-panel">
        <div className="section-title">
          <div><p className="eyebrow">Calibre 批量迁移</p><h2>只读预检并复制到应用书库</h2></div>
          <div className="integration-actions">
            <button className="secondary" type="button" disabled={scanningCalibre} onClick={() => void scanCalibre()}>{scanningCalibre ? '扫描中…' : '扫描 Calibre'}</button>
            <button className="primary" type="button" disabled={!calibrePreview?.total || migratingCalibre} onClick={() => void migrateCalibre()}>{migratingCalibre ? '排队中…' : '迁移全部'}</button>
          </div>
        </div>
        {calibrePreview && (
          <div className="calibre-preview">
            <p><strong>{calibrePreview.total}</strong> 个文件 · PDF {calibrePreview.pdfCount} · EPUB {calibrePreview.epubCount} · 来源挂载 <code>{calibrePreview.rootLabel}</code></p>
            {calibrePreview.total === 0 && <p className="muted">没有找到含 metadata.opf 的 Calibre 书目，请检查 CALIBRE_LIBRARY_PATH 挂载。</p>}
            {calibrePreview.books.slice(0, 6).map((book) => (
              <div className="calibre-row" key={book.sourcePath}>
                <span className={`format-badge ${book.format}`}>{book.format.toUpperCase()}</span><strong>{book.title}</strong><span>{book.authors.join('、') || '未知作者'}</span>
              </div>
            ))}
            {calibrePreview.total > 6 && <p className="muted">另有 {calibrePreview.total - 6} 个文件将在“迁移全部”后逐项排队。</p>}
            {calibrePreview.errors.length > 0 && <details><summary>{calibrePreview.errors.length} 个扫描警告</summary><ul>{calibrePreview.errors.slice(0, 20).map((message) => <li key={message}>{message}</li>)}</ul></details>}
          </div>
        )}
      </section>

      <section className="jobs-panel">
        <div className="section-title"><div><p className="eyebrow">可恢复后台任务</p><h2>处理队列</h2></div><span className="muted">服务重启后自动接续；失败任务可人工重试</span></div>
        <div className="job-list">
          {backgroundJobs.length === 0 && <div className="job-empty">暂无后台任务</div>}
          {backgroundJobs.slice(0, 20).map((job) => (
            <div className="job-row background-job-row" key={job.id}>
              <span className={`job-state ${job.state}`}>{jobStateLabel(job.state)}</span>
              <span><strong>{jobKindLabel(job.kind)}</strong><small>{jobSourceLabel(job)}</small></span>
              <span className="job-progress"><span>{job.lastError || job.progressMessage || `尝试 ${job.attempts} / ${job.maxAttempts}`}</span><i><b style={{ width: `${job.progress}%` }} /></i><small>{job.progress}%</small></span>
              {job.state === 'failed' && <button className="secondary" type="button" onClick={() => void retryJob(job.id)}>重试</button>}
            </div>
          ))}
        </div>
      </section>

      <section className="admin-panel">
        <div><p className="eyebrow">用户管理</p><h2>{users.length} 个账号</h2></div>
        <form className="inline-form" onSubmit={createReader}>
          <input aria-label="新用户名" placeholder="新用户名" value={newUsername} onChange={(event) => setNewUsername(event.target.value)} required />
          <input aria-label="新用户密码" type="password" placeholder="至少 12 位密码" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required />
          <button className="secondary" type="submit">添加阅读者</button>
        </form>
      </section>

      <section className="integration-panel operations-panel">
        <div className="section-title">
          <div><p className="eyebrow">存储与备份</p><h2>书库一致性</h2><p className="muted">快速检查文件是否缺失或大小异常；深度校验会读取全部书籍并核对 SHA-256。</p></div>
          <div className="integration-actions">
            <button className="secondary" type="button" disabled={checkingStorage} onClick={() => void checkStorage(false)}>{checkingStorage ? '检查中…' : '快速检查'}</button>
            <button className="secondary" type="button" disabled={checkingStorage} onClick={() => void checkStorage(true)}>深度校验</button>
          </div>
        </div>
        {storageReport && (
          <div className="storage-report">
            <div><strong>{storageReport.databaseFileCount}</strong><span>数据库文件</span></div>
            <div><strong>{storageReport.diskFileCount}</strong><span>磁盘文件</span></div>
            <div className={storageReport.missingCount ? 'has-issue' : ''}><strong>{storageReport.missingCount}</strong><span>缺失</span></div>
            <div className={storageReport.mismatchCount ? 'has-issue' : ''}><strong>{storageReport.mismatchCount}</strong><span>不一致</span></div>
            <div className={storageReport.orphanCount ? 'has-issue' : ''}><strong>{storageReport.orphanCount}</strong><span>孤儿文件</span></div>
            <p>数据库 {formatBytes(storageReport.expectedBytes)} · 磁盘 {formatBytes(storageReport.actualBytes)} · {storageReport.deep ? '已做 SHA-256 深度校验' : '快速检查'} · {formatRelativeTime(storageReport.checkedAt)}</p>
            {storageReport.issues.length > 0 && <details><summary>查看前 {storageReport.issues.length} 个问题</summary><ul>{storageReport.issues.map((issue, index) => <li key={`${issue.path}-${index}`}>{storageIssueLabel(issue.issue)}：<code>{issue.path}</code></li>)}</ul></details>}
          </div>
        )}
        <p className="backup-hint">一致性无误后，在 Unraid 终端运行 <code>sh scripts/backup.sh</code> 创建停写快照；恢复必须使用 <code>sh scripts/restore.sh 快照名 --yes</code>。</p>
      </section>

      <section className="jobs-panel">
        <div className="section-title"><div><p className="eyebrow">导入审计</p><h2>最近任务</h2></div></div>
        <div className="job-list">
          {importJobs.slice(0, 8).map((job) => (
            <div className="job-row" key={job.id}><span className={`job-state ${job.state}`}>{job.state}</span><strong>{job.sourceName}</strong><span>{job.warnings?.join('；') || '无警告'}</span></div>
          ))}
        </div>
      </section>

      <section className="jobs-panel audit-panel">
        <div className="section-title"><div><p className="eyebrow">安全审计</p><h2>最近操作</h2></div><span className="muted">登录事件与管理员写操作</span></div>
        <div className="job-list">
          {auditEvents.length === 0 && <div className="job-empty">暂无审计事件</div>}
          {auditEvents.slice(0, 20).map((event) => (
            <div className="job-row audit-row" key={event.id}>
              <span className={`job-state ${event.statusCode >= 400 ? 'failed' : 'completed'}`}>{event.statusCode}</span>
              <span><strong>{auditActionLabel(event.action)}</strong><small>{event.actorName || '未知账号'} · {event.clientIp || '未知地址'}</small></span>
              <span>{formatRelativeTime(event.createdAt)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function jobStateLabel(state: BackgroundJob['state']): string {
  return { queued: '排队', running: '处理中', completed: '完成', failed: '失败' }[state]
}

function jobKindLabel(kind: string): string {
  return { 'calibre-import': 'Calibre 迁移', 'inbox-import': '收件箱导入', 'pdf-assets': 'PDF 封面 / OCR' }[kind] ?? kind
}

function jobSourceLabel(job: BackgroundJob): string {
  const source = job.payload.sourcePath
  return typeof source === 'string' && source ? source : job.dedupeKey
}

function uploadStateLabel(state: UploadState): string {
  return { queued: '等待', uploading: '上传', processing: '处理', completed: '完成', duplicate: '重复', failed: '失败' }[state]
}

function storageIssueLabel(issue: string): string {
  return { missing: '文件缺失', size_mismatch: '大小不符', checksum_mismatch: '校验值不符', unsafe_path: '路径不安全', orphaned: '数据库外文件' }[issue] ?? issue
}

function auditActionLabel(action: string): string {
  if (action === 'auth.login.succeeded') return '登录成功'
  if (action === 'auth.login.failed') return '登录失败'
  if (action === 'auth.login.blocked') return '登录被限流'
  const labels: Record<string, string> = {
    'POST /api/v1/users': '创建用户',
    'POST /api/v1/book-files': '上传书籍',
    'PUT /api/v1/editions/{id}/review': '确认书目分类',
    'POST /api/v1/editions/{id}/ai-classify': '请求 AI 分类',
    'POST /api/v1/editions/{id}/bibliography-search': '查询外部书目',
    'POST /api/v1/background-jobs/{id}/retry': '重试后台任务',
    'POST /api/v1/calibre/import': '启动 Calibre 迁移',
    'POST /api/v1/admin/categories': '创建题材分类',
    'PATCH /api/v1/admin/categories/{id}': '修改题材分类',
  }
  return labels[action] ?? action
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
      <div className="section-title">
        <div><p className="eyebrow">固定题材体系</p><h2>{activeCount} 个启用分类 · {roots.length} 个主类</h2><p className="muted">父类筛选会包含全部子类；停用不会删除已有书籍分类记录。</p></div>
      </div>
      <form className="category-create-form" onSubmit={create}>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="分类名称，如 建筑设计" maxLength={60} required />
        <input value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase())} placeholder="固定标识，如 architecture" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxLength={80} required />
        <select value={parentID} onChange={(event) => setParentID(event.target.value)} aria-label="父分类">
          <option value="">作为主类</option>
          {categories.filter((category) => category.active).map((category) => <option key={category.id} value={category.id}>{category.parentId ? `↳ ${category.name}` : category.name}</option>)}
        </select>
        <button className="primary" type="submit" disabled={creating}>{creating ? '添加中…' : '添加分类'}</button>
      </form>
      <div className="category-management-list">
        {categories.map((category) => <CategoryManagementRow key={category.id} category={category} categories={categories} onChanged={onChanged} onError={onError} />)}
      </div>
    </section>
  )
}

function CategoryManagementRow({ category, categories, onChanged, onError }: { category: Category; categories: Category[]; onChanged: () => Promise<void>; onError: (message: string) => void }) {
  const [name, setName] = useState(category.name)
  const [parentID, setParentID] = useState(category.parentId ? String(category.parentId) : '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setName(category.name)
    setParentID(category.parentId ? String(category.parentId) : '')
  }, [category.name, category.parentId])

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

  return (
    <div className={`category-management-row${category.active ? '' : ' inactive'}`}>
      <span className="category-identity"><strong>{category.parentId ? '↳ ' : ''}{category.slug}</strong><small>{category.bookCount ?? 0} 本 · {category.system ? '内置' : '自定义'}</small></span>
      <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} aria-label={`${category.slug} 分类名称`} />
      <select value={parentID} onChange={(event) => setParentID(event.target.value)} aria-label={`${category.slug} 父分类`}>
        <option value="">主类</option>
        {categories.filter((candidate) => candidate.id !== category.id && candidate.active && !isDescendantCandidate(candidate, category, categories)).map((candidate) => (
          <option key={candidate.id} value={candidate.id}>{candidate.parentId ? `↳ ${candidate.name}` : candidate.name}</option>
        ))}
      </select>
      <button className="secondary" type="button" disabled={saving || !name.trim()} onClick={() => void save()}>{saving ? '保存中' : '保存'}</button>
      <button className={category.active ? 'quiet danger-text' : 'quiet'} type="button" disabled={saving || category.slug === 'other'} onClick={() => void save(!category.active)}>{category.active ? '停用' : '启用'}</button>
    </div>
  )
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

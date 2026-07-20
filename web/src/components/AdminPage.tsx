import { type ChangeEvent, type DragEvent, type FormEvent, useEffect, useMemo, useState } from 'react'
import { APIError, api } from '../api'
import type { AuditEvent, BackgroundJob, BibliographySource, BibliographySourceInput, CalibrePreview, Category, ImportJob, ImportSource, ReviewItem, StorageAuditReport } from '../types'
import { formatBytes, formatRelativeTime } from '../utils'
import { ReviewQueue } from './ReviewQueue'
import { UserManagement } from './UserManagement'

interface Props {
  initialEditionID?: number
  currentUserID: number
}

type UploadState = 'queued' | 'uploading' | 'processing' | 'completed' | 'duplicate' | 'failed'

interface UploadItem {
  id: string
  file: File
  state: UploadState
  progress: number
  message: string
}

export function AdminPage({ initialEditionID, currentUserID }: Props) {
  const [categories, setCategories] = useState<Category[]>([])
  const [adminCategories, setAdminCategories] = useState<Category[]>([])
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([])
  const [manualReviewItem, setManualReviewItem] = useState<ReviewItem | null>(null)
  const [importJobs, setImportJobs] = useState<ImportJob[]>([])
  const [importSources, setImportSources] = useState<ImportSource[]>([])
  const [backgroundJobs, setBackgroundJobs] = useState<BackgroundJob[]>([])
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([])
  const [storageReport, setStorageReport] = useState<StorageAuditReport | null>(null)
  const [calibrePreview, setCalibrePreview] = useState<CalibrePreview | null>(null)
  const [bibliographySources, setBibliographySources] = useState<BibliographySource[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [uploading, setUploading] = useState(false)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const [scanningCalibre, setScanningCalibre] = useState(false)
  const [migratingCalibre, setMigratingCalibre] = useState(false)
  const [checkingStorage, setCheckingStorage] = useState(false)

  async function refreshAdmin() {
    try {
      const [categoryItems, managedCategories, queueItems, jobs, asyncJobs, audits, sources, configuredImportSources] = await Promise.all([
        api.listCategories(), api.listAdminCategories(), api.listReviewQueue(), api.listImportJobs(), api.listBackgroundJobs(), api.listAuditEvents(), api.listBibliographySources(), api.listImportSources(),
      ])
      setCategories(categoryItems)
      setAdminCategories(managedCategories)
      setReviewItems(queueItems)
      setImportJobs(jobs)
      setBackgroundJobs(asyncJobs)
      setAuditEvents(audits)
      setBibliographySources(sources)
      setImportSources(configuredImportSources)
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
    const accepted = files.filter((file) => /\.(pdf|epub|mobi|azw3)$/i.test(file.name))
    const rejected = files.length - accepted.length
    if (accepted.length === 0) {
      setError('请选择 PDF、EPUB、MOBI 或 AZW3 文件。')
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
              message: progress >= 100
                ? /\.(mobi|azw3)$/i.test(item.file.name) ? '正在生成 EPUB 阅读副本并提取元数据' : '正在提取元数据并分类'
                : `正在上传 ${progress}%`,
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
    setNotice(`批量导入完成：新增 ${completed} 本，重复 ${duplicated} 本，失败 ${failed} 本${rejected ? `，忽略 ${rejected} 个非 PDF/EPUB/MOBI/AZW3 文件` : ''}。`)
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
          {uploading ? '正在批量导入…' : '选择电子书'}
          <input type="file" multiple accept=".epub,.pdf,.mobi,.azw3,application/epub+zip,application/pdf,application/x-mobipocket-ebook,application/vnd.amazon.ebook" onChange={selectFiles} disabled={uploading} />
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
        <div><p className="eyebrow">批量导入</p><h2>{uploading ? '正在处理导入队列' : '拖放 PDF / EPUB / MOBI / AZW3 到这里'}</h2><p className="muted">每次最多 2 本并行处理；原文件会复制到应用书库，MOBI/AZW3 会额外生成可再生的 EPUB 阅读缓存。</p></div>
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

      <section className="integration-panel import-sources-panel">
        <div className="section-title">
          <div><p className="eyebrow">导入入口</p><h2>上传、移动与只读监控</h2><p className="muted">三个入口共用内容校验、SHA-256 去重、元数据提取与可恢复后台任务。</p></div>
        </div>
        <div className="import-source-grid">
          {importSources.map((source) => (
            <article className={`import-source-card${source.enabled ? '' : ' disabled'}`} key={source.id}>
              <div className="import-source-heading"><strong>{source.name}</strong><span className={source.enabled ? 'enabled' : ''}>{source.enabled ? '已启用' : '未启用'}</span></div>
              <p>{importSourceDescription(source)}</p>
              {source.path && <code title={source.path}>{source.path}</code>}
              <dl>
                <div><dt>处理方式</dt><dd>{importModeLabel(source.mode)}</dd></div>
                {source.maxFileBytes ? <div><dt>单文件上限</dt><dd>{formatBytes(source.maxFileBytes)}</dd></div> : null}
                {source.scanIntervalSeconds ? <div><dt>扫描 / 稳定</dt><dd>{formatCompactSeconds(source.scanIntervalSeconds)} / {formatCompactSeconds(source.stableAgeSeconds ?? 0)}</dd></div> : null}
              </dl>
            </article>
          ))}
        </div>
        <p className="import-source-hint">目录模式由 <code>.env</code> 和 Compose 挂载控制；修改后运行 <code>docker compose up -d</code> 重建容器。</p>
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

      <BibliographySourceManager
        sources={bibliographySources}
        onError={setError}
        onNotice={setNotice}
        onChanged={async () => setBibliographySources(await api.listBibliographySources())}
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
            <p><strong>{calibrePreview.total}</strong> 个文件 · PDF {calibrePreview.pdfCount} · EPUB {calibrePreview.epubCount} · MOBI {calibrePreview.mobiCount} · AZW3 {calibrePreview.azw3Count} · 来源挂载 <code>{calibrePreview.rootLabel}</code></p>
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

      <UserManagement currentUserID={currentUserID} onError={setError} onNotice={setNotice} />

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
  return { 'calibre-import': 'Calibre 迁移', 'inbox-import': '移动导入箱', 'watched-library-import': '只读目录增量导入', 'pdf-assets': 'PDF 封面 / OCR', 'bibliography-enrichment': '外部书目自动查询' }[kind] ?? kind
}

function jobSourceLabel(job: BackgroundJob): string {
  const source = job.payload.sourcePath
  return typeof source === 'string' && source ? source : job.dedupeKey
}

function uploadStateLabel(state: UploadState): string {
  return { queued: '等待', uploading: '上传', processing: '处理', completed: '完成', duplicate: '重复', failed: '失败' }[state]
}

function importModeLabel(mode: string): string {
  return { upload: '网页上传并复制', move: '导入后移动归档', copy: '复制入库，源文件保留' }[mode] ?? mode
}

function importSourceDescription(source: ImportSource): string {
  return {
    'browser-upload': '需要时在管理后台选择或拖放多个文件，作为手动备用入口。',
    'moving-inbox': '递归扫描 inbox；成功后移到 processed，连续失败后移到 failed。',
    'watched-library': '递归发现新增或变更书籍，只读复制进托管书库，源目录保持原样。',
  }[source.id] ?? '电子书导入入口。'
}

function formatCompactSeconds(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} 小时`
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} 分钟`
  return `${seconds} 秒`
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
    'PATCH /api/v1/users/{id}': '修改用户',
    'DELETE /api/v1/users/{id}': '删除用户',
    'POST /api/v1/users/{id}/password': '重置用户密码',
    'DELETE /api/v1/users/{id}/sessions': '下线用户全部设备',
    'DELETE /api/v1/users/{id}/sessions/{sessionId}': '下线用户设备',
    'POST /api/v1/book-files': '上传书籍',
    'PUT /api/v1/editions/{id}/review': '确认书目分类',
    'POST /api/v1/editions/{id}/ai-classify': '请求 AI 分类',
    'POST /api/v1/editions/{id}/bibliography-search': '查询外部书目',
    'POST /api/v1/background-jobs/{id}/retry': '重试后台任务',
    'POST /api/v1/calibre/import': '启动 Calibre 迁移',
    'POST /api/v1/admin/categories': '创建题材分类',
    'PATCH /api/v1/admin/categories/{id}': '修改题材分类',
    'PATCH /api/v1/admin/bibliography-sources/{id}': '修改外部书目源',
    'POST /api/v1/admin/bibliography-sources/{id}/test': '测试外部书目源',
  }
  return labels[action] ?? action
}

function BibliographySourceManager({ sources, onChanged, onError, onNotice }: {
  sources: BibliographySource[]
  onChanged: () => Promise<void>
  onError: (message: string) => void
  onNotice: (message: string) => void
}) {
  return (
    <section className="integration-panel bibliography-source-panel">
      <div className="section-title">
        <div>
          <p className="eyebrow">外部书目信息源</p>
          <h2>元数据查询与导入建议</h2>
          <p className="muted">自动查询只添加待确认建议，不会覆盖现有书名、作者或分类。优先级数字越小越靠前。</p>
        </div>
      </div>
      <div className="bibliography-source-list">
        {sources.map((source) => (
          <BibliographySourceCard key={source.id} source={source} onChanged={onChanged} onError={onError} onNotice={onNotice} />
        ))}
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
        if (response.result.success) {
          onNotice(`${bibliographySourceLabel(source.provider)}连接成功，响应 ${response.result.latencyMs} ms。`)
        } else {
          onError(`${bibliographySourceLabel(source.provider)}连接失败：${response.result.error || '未知错误'}`)
        }
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

  const status = source.lastCheckedAt
    ? source.lastError ? 'failed' : 'healthy'
    : 'untested'

  return (
    <article className={`bibliography-source-card ${source.enabled ? 'enabled' : 'disabled'}`}>
      <div className="bibliography-source-heading">
        <div>
          <span className={`source-status ${status}`}>{status === 'healthy' ? '连接正常' : status === 'failed' ? '最近失败' : '尚未测试'}</span>
          <h3>{bibliographySourceLabel(source.provider)}</h3>
          <p>{bibliographySourceDescription(source.provider)}</p>
        </div>
        <label className="source-toggle"><input type="checkbox" checked={input.enabled} onChange={(event) => change('enabled', event.target.checked)} /><span>启用查询</span></label>
      </div>
      <div className="bibliography-source-form">
        <label className="source-url-field"><span>服务地址</span><input type="url" value={input.baseUrl} onChange={(event) => change('baseUrl', event.target.value)} placeholder={source.provider === 'douban' ? 'http://192.168.3.118:5890' : 'https://…'} maxLength={2048} required={input.enabled} /></label>
        <label><span>优先级</span><input type="number" min={1} max={1000} value={input.priority} onChange={(event) => change('priority', Number(event.target.value))} /></label>
        <label><span>超时（秒）</span><input type="number" min={1} max={60} value={input.timeoutMs / 1000} onChange={(event) => change('timeoutMs', Math.round(Number(event.target.value) * 1000))} /></label>
        <label><span>最大候选数</span><input type="number" min={1} max={20} value={input.maxResults} onChange={(event) => change('maxResults', Number(event.target.value))} /></label>
      </div>
      <div className="bibliography-source-footer">
        <label className="auto-source-toggle"><input type="checkbox" checked={input.autoSearch} onChange={(event) => change('autoSearch', event.target.checked)} /><span>导入后自动查询建议</span></label>
        <div className="source-actions">
          <button className="secondary" type="button" disabled={Boolean(busy)} onClick={() => void save(true)}>{busy === 'test' ? '测试中…' : '保存并测试'}</button>
          <button className="primary" type="button" disabled={Boolean(busy)} onClick={() => void save(false)}>{busy === 'save' ? '保存中…' : '保存设置'}</button>
        </div>
      </div>
      <dl className="bibliography-source-health">
        <div><dt>最近成功</dt><dd>{source.lastSuccessAt ? formatRelativeTime(source.lastSuccessAt) : '暂无'}</dd></div>
        <div><dt>最近检查</dt><dd>{source.lastCheckedAt ? formatRelativeTime(source.lastCheckedAt) : '暂无'}</dd></div>
        <div><dt>响应耗时</dt><dd>{source.lastLatencyMs === undefined ? '暂无' : `${source.lastLatencyMs} ms`}</dd></div>
      </dl>
      {source.lastError && <p className="source-last-error" title={source.lastError}>最近错误：{source.lastError}</p>}
    </article>
  )
}

function sourceInput(source: BibliographySource): BibliographySourceInput {
  return {
    enabled: source.enabled,
    baseUrl: source.baseUrl,
    priority: source.priority,
    timeoutMs: source.timeoutMs,
    maxResults: source.maxResults,
    autoSearch: source.autoSearch,
  }
}

function bibliographySourceLabel(provider: string): string {
  return { douban: '豆瓣书目（douban-api-rs）', openlibrary: 'Open Library', 'google-books': 'Google Books' }[provider] ?? provider
}

function bibliographySourceDescription(provider: string): string {
  return {
    douban: '中文书籍、作者、出版社、标签和封面信息',
    openlibrary: '开放书目数据，适合 ISBN 与外文书籍补全',
    'google-books': 'Google Books 书目与封面，需要在环境变量配置 API Key',
  }[provider] ?? '外部书目信息服务'
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

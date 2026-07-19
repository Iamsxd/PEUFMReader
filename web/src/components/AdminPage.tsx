import { type ChangeEvent, type FormEvent, useEffect, useMemo, useState } from 'react'
import { APIError, api } from '../api'
import type { BackgroundJob, CalibrePreview, Category, ImportJob, ReviewItem, User } from '../types'
import { ReviewQueue } from './ReviewQueue'

interface Props {
  initialEditionID?: number
}

export function AdminPage({ initialEditionID }: Props) {
  const [categories, setCategories] = useState<Category[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([])
  const [manualReviewItem, setManualReviewItem] = useState<ReviewItem | null>(null)
  const [importJobs, setImportJobs] = useState<ImportJob[]>([])
  const [backgroundJobs, setBackgroundJobs] = useState<BackgroundJob[]>([])
  const [calibrePreview, setCalibrePreview] = useState<CalibrePreview | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [uploading, setUploading] = useState(false)
  const [scanningCalibre, setScanningCalibre] = useState(false)
  const [migratingCalibre, setMigratingCalibre] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')

  async function refreshAdmin() {
    try {
      const [categoryItems, userItems, queueItems, jobs, asyncJobs] = await Promise.all([
        api.listCategories(), api.listUsers(), api.listReviewQueue(), api.listImportJobs(), api.listBackgroundJobs(),
      ])
      setCategories(categoryItems)
      setUsers(userItems)
      setReviewItems(queueItems)
      setImportJobs(jobs)
      setBackgroundJobs(asyncJobs)
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
    }, 4000)
    return () => window.clearInterval(timer)
  }, [])

  const visibleReviewItems = useMemo(() => {
    if (!manualReviewItem || reviewItems.some((item) => item.editionId === manualReviewItem.editionId)) return reviewItems
    return [manualReviewItem, ...reviewItems]
  }, [manualReviewItem, reviewItems])

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setUploading(true)
    setError('')
    setNotice('')
    try {
      const result = await api.uploadBook(file)
      setNotice(result.duplicate ? '文件已存在，沿用原有书籍记录。' : `已导入《${result.bookFile.title}》，元数据和分类建议已生成。`)
      await refreshAdmin()
    } catch (reason) {
      setError(reason instanceof APIError ? reason.message : '上传失败。')
    } finally {
      setUploading(false)
      event.target.value = ''
    }
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

  async function reviewChanged() {
    setManualReviewItem(null)
    await refreshAdmin()
  }

  return (
    <div className="admin-page">
      <section className="page-heading admin-heading">
        <div><p className="eyebrow">系统管理</p><h1>管理后台</h1><p className="muted">导入书籍、确认分类、管理用户和检查后台任务。</p></div>
        <label className={`upload-button ${uploading ? 'disabled' : ''}`}>
          {uploading ? '正在提取与分类…' : '导入 EPUB / PDF'}
          <input type="file" accept=".epub,.pdf,application/epub+zip,application/pdf" onChange={upload} disabled={uploading} />
        </label>
      </section>

      {error && <div className="notice error" role="alert">{error}</div>}
      {notice && <div className="notice success" role="status">{notice}</div>}

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
              <span><strong>{jobKindLabel(job.kind)}</strong><small>{job.dedupeKey}</small></span>
              <span>{job.lastError || `尝试 ${job.attempts} / ${job.maxAttempts}`}</span>
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

      <section className="jobs-panel">
        <div className="section-title"><div><p className="eyebrow">导入审计</p><h2>最近任务</h2></div></div>
        <div className="job-list">
          {importJobs.slice(0, 8).map((job) => (
            <div className="job-row" key={job.id}><span className={`job-state ${job.state}`}>{job.state}</span><strong>{job.sourceName}</strong><span>{job.warnings?.join('；') || '无警告'}</span></div>
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
  return { 'calibre-import': 'Calibre 迁移', 'pdf-assets': 'PDF 封面 / OCR' }[kind] ?? kind
}

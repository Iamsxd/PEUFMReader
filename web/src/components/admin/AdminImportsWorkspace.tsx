import { type ChangeEvent, type DragEvent, useEffect, useState } from 'react'
import { APIError, api } from '../../api'
import type { CalibrePreview, ImportJob, ImportSource } from '../../types'
import { formatBytes } from '../../utils'

interface Props {
  onError: (message: string) => void
  onNotice: (message: string) => void
  onDataChanged: () => void
}

type UploadState = 'queued' | 'uploading' | 'processing' | 'completed' | 'duplicate' | 'failed'

interface UploadItem {
  id: string
  file: File
  state: UploadState
  progress: number
  message: string
}

export default function AdminImportsWorkspace({ onError, onNotice, onDataChanged }: Props) {
  const [importJobs, setImportJobs] = useState<ImportJob[]>([])
  const [importSources, setImportSources] = useState<ImportSource[]>([])
  const [calibrePreview, setCalibrePreview] = useState<CalibrePreview | null>(null)
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const [uploading, setUploading] = useState(false)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [scanningCalibre, setScanningCalibre] = useState(false)
  const [migratingCalibre, setMigratingCalibre] = useState(false)
  const [referencingCalibre, setReferencingCalibre] = useState(false)

  async function refreshImports() {
    const [jobs, sources] = await Promise.all([api.listImportJobs(), api.listImportSources()])
    setImportJobs(jobs)
    setImportSources(sources)
  }

  useEffect(() => {
    void refreshImports().catch((reason) => onError(reason instanceof APIError ? reason.message : '无法加载导入工作区。'))
  }, [])

  function changeUpload(id: string, update: Partial<Omit<UploadItem, 'id' | 'file'>>) {
    setUploads((current) => current.map((item) => item.id === id ? { ...item, ...update } : item))
  }

  async function uploadFiles(files: File[]) {
    if (uploading || files.length === 0) return
    const accepted = files.filter((file) => /\.(pdf|epub|mobi|azw3)$/i.test(file.name))
    const rejected = files.length - accepted.length
    if (accepted.length === 0) {
      onError('请选择 PDF、EPUB、MOBI 或 AZW3 文件。')
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
    onError('')
    onNotice('')

    let cursor = 0
    let completed = 0
    let duplicated = 0
    let failed = 0
    async function worker() {
      while (cursor < batch.length) {
        const item = batch[cursor++]
        changeUpload(item.id, { state: 'uploading', message: '正在上传' })
        try {
          const result = await api.uploadBook(item.file, (progress) => changeUpload(item.id, {
            progress,
            state: progress >= 100 ? 'processing' : 'uploading',
            message: progress >= 100
              ? /\.(mobi|azw3)$/i.test(item.file.name) ? '正在生成 EPUB 阅读副本并提取元数据' : '正在提取元数据并分类'
              : `正在上传 ${progress}%`,
          }))
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
    onNotice(`批量导入完成：新增 ${completed} 本，重复 ${duplicated} 本，失败 ${failed} 本${rejected ? `，忽略 ${rejected} 个非 PDF/EPUB/MOBI/AZW3 文件` : ''}。`)
    await refreshImports()
    onDataChanged()
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
    onError('')
    try {
      setCalibrePreview(await api.previewCalibre())
    } catch (reason) {
      onError(reason instanceof APIError ? reason.message : 'Calibre 书库扫描失败。')
    } finally {
      setScanningCalibre(false)
    }
  }

  async function migrateCalibre() {
    setMigratingCalibre(true)
    onError('')
    try {
      const result = await api.importCalibre()
      onNotice(`Calibre 迁移已排队：新增 ${result.queued} 项，已有 ${result.existing} 项。任务可在服务重启后继续。`)
      onDataChanged()
    } catch (reason) {
      onError(reason instanceof APIError ? reason.message : 'Calibre 迁移排队失败。')
    } finally {
      setMigratingCalibre(false)
    }
  }

  async function syncCalibreReferences() {
    setReferencingCalibre(true)
    onError('')
    try {
      const result = await api.syncCalibreReferences()
      onNotice(result.created ? 'Calibre 只读引用同步已排队：不会复制或移动原始电子书。' : 'Calibre 只读引用同步已在后台队列中。')
      onDataChanged()
    } catch (reason) {
      onError(reason instanceof APIError ? reason.message : 'Calibre 只读引用同步排队失败。')
    } finally {
      setReferencingCalibre(false)
    }
  }

  return <div className="admin-workspace-module">
    <section className={`upload-drop-zone${draggingFiles ? ' dragging' : ''}${uploading ? ' busy' : ''}`} onDragEnter={(event) => { event.preventDefault(); if (!uploading) setDraggingFiles(true) }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false) }} onDrop={dropFiles}>
      <div><p className="eyebrow">批量导入</p><h2>{uploading ? '正在处理导入队列' : '拖放 PDF / EPUB / MOBI / AZW3 到这里'}</h2><p className="muted">每次最多 2 本并行处理；原文件会复制到应用书库，MOBI/AZW3 会额外生成可再生的 EPUB 阅读缓存。</p></div>
      <label className={`upload-button ${uploading ? 'disabled' : ''}`}>{uploading ? '正在批量导入…' : '选择电子书'}<input type="file" multiple accept=".epub,.pdf,.mobi,.azw3,application/epub+zip,application/pdf,application/x-mobipocket-ebook,application/vnd.amazon.ebook" onChange={selectFiles} disabled={uploading} /></label>
      {uploads.length > 0 && <div className="upload-queue" aria-live="polite">{uploads.map((item) => <div className="upload-queue-item" key={item.id}><span className={`job-state ${item.state}`}>{uploadStateLabel(item.state)}</span><span><strong>{item.file.name}</strong><small>{item.message}</small></span><span className="job-progress"><i><b style={{ width: `${item.progress}%` }} /></i><small>{item.progress}%</small></span></div>)}</div>}
    </section>

    <section className="integration-panel import-sources-panel">
      <div className="section-title"><div><p className="eyebrow">导入入口</p><h2>上传、移动与只读监控</h2><p className="muted">三个入口共用内容校验、SHA-256 去重、元数据提取与可恢复后台任务。</p></div></div>
      <div className="import-source-grid">{importSources.map((source) => <article className={`import-source-card${source.enabled ? '' : ' disabled'}`} key={source.id}><div className="import-source-heading"><strong>{source.name}</strong><span className={source.enabled ? 'enabled' : ''}>{source.enabled ? '已启用' : '未启用'}</span></div><p>{importSourceDescription(source)}</p>{source.path && <code title={source.path}>{source.path}</code>}<dl><div><dt>处理方式</dt><dd>{importModeLabel(source.mode)}</dd></div>{source.maxFileBytes ? <div><dt>单文件上限</dt><dd>{formatBytes(source.maxFileBytes)}</dd></div> : null}{source.scanIntervalSeconds ? <div><dt>扫描 / 稳定</dt><dd>{formatCompactSeconds(source.scanIntervalSeconds)} / {formatCompactSeconds(source.stableAgeSeconds ?? 0)}</dd></div> : null}</dl></article>)}</div>
      <p className="import-source-hint">目录模式由 <code>.env</code> 和 Compose 挂载控制；修改后运行 <code>docker compose up -d</code> 重建容器。</p>
    </section>

    <section className="integration-panel">
      <div className="section-title"><div><p className="eyebrow">Calibre 批量迁移</p><h2>只读预检并复制到应用书库</h2></div><div className="integration-actions"><button className="secondary" type="button" disabled={scanningCalibre} onClick={() => void scanCalibre()}>{scanningCalibre ? '扫描中…' : '扫描 Calibre'}</button><button className="primary" type="button" disabled={!calibrePreview?.total || migratingCalibre} onClick={() => void migrateCalibre()}>{migratingCalibre ? '排队中…' : '迁移全部'}</button></div></div>
      {calibrePreview && <div className="calibre-preview"><p><strong>{calibrePreview.total}</strong> 个文件 · PDF {calibrePreview.pdfCount} · EPUB {calibrePreview.epubCount} · MOBI {calibrePreview.mobiCount} · AZW3 {calibrePreview.azw3Count} · 来源挂载 <code>{calibrePreview.rootLabel}</code></p>{calibrePreview.total === 0 && <p className="muted">没有找到含 metadata.opf 的 Calibre 书目，请检查 CALIBRE_LIBRARY_PATH 挂载。</p>}{calibrePreview.books.slice(0, 6).map((book) => <div className="calibre-row" key={book.sourcePath}><span className={`format-badge ${book.format}`}>{book.format.toUpperCase()}</span><strong>{book.title}</strong><span>{book.authors.join('、') || '未知作者'}</span></div>)}{calibrePreview.total > 6 && <p className="muted">另有 {calibrePreview.total - 6} 个文件将在“迁移全部”后逐项排队。</p>}{calibrePreview.errors.length > 0 && <details><summary>{calibrePreview.errors.length} 个扫描警告</summary><ul>{calibrePreview.errors.slice(0, 20).map((message) => <li key={message}>{message}</li>)}</ul></details>}</div>}
    </section>

    <section className="integration-panel">
      <div className="section-title"><div><p className="eyebrow">Calibre 只读引用</p><h2>索引现有书库，不复制电子书</h2><p className="muted">从 metadata.db 读取书名、作者、出版信息、封面与文件位置；阅读时直接从只读挂载提供内容。Calibre 的标签不会导入为本系统分类。</p></div><div className="integration-actions"><button className="primary" type="button" disabled={!calibrePreview?.total || referencingCalibre} onClick={() => void syncCalibreReferences()}>{referencingCalibre ? '排队中…' : '同步为只读引用'}</button></div></div>
      {!calibrePreview && <p className="muted">先执行“扫描 Calibre”确认挂载与书目数量，再启动同步。</p>}
    </section>

    <section className="jobs-panel compact-admin-panel"><div className="section-title"><div><p className="eyebrow">导入审计</p><h2>最近任务</h2></div></div><div className="job-list">{importJobs.length === 0 && <div className="job-empty">暂无导入任务</div>}{importJobs.slice(0, 8).map((job) => <div className="job-row" key={job.id}><span className={`job-state ${job.state}`}>{job.state}</span><strong>{job.sourceName}</strong><span>{job.warnings?.join('；') || '无警告'}</span></div>)}</div></section>
  </div>
}

function uploadStateLabel(state: UploadState): string {
  return { queued: '等待', uploading: '上传', processing: '处理', completed: '完成', duplicate: '重复', failed: '失败' }[state]
}

function importModeLabel(mode: string): string {
  if (mode === 'reference') return '只读引用，不复制书籍'
  return { upload: '网页上传并复制', move: '导入后移动归档', copy: '复制入库，源文件保留' }[mode] ?? mode
}

function importSourceDescription(source: ImportSource): string {
  if (source.id === 'calibre-reference') return '读取 Calibre 的 metadata.db 并建立引用索引；电子书仍保留在 Calibre 书库中。'
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

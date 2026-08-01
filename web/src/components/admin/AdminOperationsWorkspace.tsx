import { useEffect, useState } from 'react'
import { APIError, api } from '../../api'
import type { AuditEvent, BackgroundJob, StorageAuditReport } from '../../types'
import { formatBytes, formatRelativeTime } from '../../utils'

interface Props {
  onError: (message: string) => void
  onDataChanged: () => void
  onActiveJobCountChange: (count: number) => void
}

export default function AdminOperationsWorkspace({ onError, onDataChanged, onActiveJobCountChange }: Props) {
  const [backgroundJobs, setBackgroundJobs] = useState<BackgroundJob[]>([])
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([])
  const [storageReport, setStorageReport] = useState<StorageAuditReport | null>(null)
  const [checkingStorage, setCheckingStorage] = useState(false)

  async function refreshOperations() {
    const [jobs, audits] = await Promise.all([api.listBackgroundJobs(), api.listAuditEvents()])
    setBackgroundJobs(jobs)
    setAuditEvents(audits)
    onActiveJobCountChange(jobs.filter((job) => job.state === 'queued' || job.state === 'running').length)
  }

  useEffect(() => {
    void refreshOperations().catch((reason) => onError(reason instanceof APIError ? reason.message : '无法加载任务与运维工作区。'))
    const timer = window.setInterval(() => void refreshOperations().catch(() => undefined), 5_000)
    return () => window.clearInterval(timer)
  }, [])

  async function retryJob(jobID: number) {
    onError('')
    try {
      await api.retryBackgroundJob(jobID)
      await refreshOperations()
      onDataChanged()
    } catch (reason) {
      onError(reason instanceof APIError ? reason.message : '任务重试失败。')
    }
  }

  async function checkStorage(deep: boolean) {
    setCheckingStorage(true)
    onError('')
    try {
      setStorageReport(await api.auditStorage(deep))
    } catch (reason) {
      onError(reason instanceof APIError ? reason.message : '书库一致性检查失败。')
    } finally {
      setCheckingStorage(false)
    }
  }

  return <div className="admin-workspace-module">
    <section className="jobs-panel compact-admin-panel">
      <div className="section-title"><div><p className="eyebrow">可恢复后台任务</p><h2>处理队列</h2></div><span className="muted">服务重启后自动接续；失败任务可人工重试</span></div>
      <div className="job-list">{backgroundJobs.length === 0 && <div className="job-empty">暂无后台任务</div>}{backgroundJobs.slice(0, 20).map((job) => <div className="job-row background-job-row" key={job.id}><span className={`job-state ${job.state}`}>{jobStateLabel(job.state)}</span><span><strong>{jobKindLabel(job.kind)}</strong><small>{jobSourceLabel(job)}</small></span><span className="job-progress"><span>{job.lastError || job.progressMessage || `尝试 ${job.attempts} / ${job.maxAttempts}`}</span><i><b style={{ width: `${job.progress}%` }} /></i><small>{job.progress}%</small></span>{job.state === 'failed' && <button className="secondary" type="button" onClick={() => void retryJob(job.id)}>重试</button>}</div>)}</div>
    </section>

    <section className="integration-panel operations-panel">
      <div className="section-title"><div><p className="eyebrow">存储与备份</p><h2>书库一致性</h2><p className="muted">快速检查文件是否缺失或大小异常；深度校验会读取全部书籍并核对 SHA-256。</p></div><div className="integration-actions"><button className="secondary" type="button" disabled={checkingStorage} onClick={() => void checkStorage(false)}>{checkingStorage ? '检查中…' : '快速检查'}</button><button className="secondary" type="button" disabled={checkingStorage} onClick={() => void checkStorage(true)}>深度校验</button></div></div>
      {storageReport && <div className="storage-report"><div><strong>{storageReport.databaseFileCount}</strong><span>数据库文件</span></div><div><strong>{storageReport.diskFileCount}</strong><span>磁盘文件</span></div><div className={storageReport.missingCount ? 'has-issue' : ''}><strong>{storageReport.missingCount}</strong><span>缺失</span></div><div className={storageReport.mismatchCount ? 'has-issue' : ''}><strong>{storageReport.mismatchCount}</strong><span>不一致</span></div><div className={storageReport.orphanCount ? 'has-issue' : ''}><strong>{storageReport.orphanCount}</strong><span>孤儿文件</span></div><p>数据库 {formatBytes(storageReport.expectedBytes)} · 磁盘 {formatBytes(storageReport.actualBytes)} · {storageReport.deep ? '已做 SHA-256 深度校验' : '快速检查'} · {formatRelativeTime(storageReport.checkedAt)}</p>{storageReport.issues.length > 0 && <details><summary>查看前 {storageReport.issues.length} 个问题</summary><ul>{storageReport.issues.map((issue, index) => <li key={`${issue.path}-${index}`}>{storageIssueLabel(issue.issue)}：<code>{issue.path}</code></li>)}</ul></details>}</div>}
      <p className="backup-hint">一致性无误后，在 Unraid 终端运行 <code>sh scripts/backup.sh</code> 创建停写快照；恢复必须使用 <code>sh scripts/restore.sh 快照名 --yes</code>。</p>
    </section>

    <section className="jobs-panel audit-panel"><div className="section-title"><div><p className="eyebrow">安全审计</p><h2>最近操作</h2></div><span className="muted">登录事件与管理员写操作</span></div><div className="job-list">{auditEvents.length === 0 && <div className="job-empty">暂无审计事件</div>}{auditEvents.slice(0, 20).map((event) => <div className="job-row audit-row" key={event.id}><span className={`job-state ${event.statusCode >= 400 ? 'failed' : 'completed'}`}>{event.statusCode}</span><span><strong>{auditActionLabel(event.action)}</strong><small>{event.actorName || '未知账号'} · {event.clientIp || '未知地址'}</small></span><span>{formatRelativeTime(event.createdAt)}</span></div>)}</div></section>
  </div>
}

function jobStateLabel(state: BackgroundJob['state']): string {
  return { queued: '排队', running: '处理中', completed: '完成', failed: '失败' }[state]
}

function jobKindLabel(kind: string): string {
  if (kind === 'calibre-reference-sync') return 'Calibre 只读引用同步'
  return { 'calibre-import': 'Calibre 迁移', 'inbox-import': '移动导入箱', 'watched-library-import': '只读目录增量导入', 'pdf-assets': 'PDF 封面 / OCR', 'bibliography-enrichment': '外部书目自动查询' }[kind] ?? kind
}

function jobSourceLabel(job: BackgroundJob): string {
  const source = job.payload.sourcePath
  return typeof source === 'string' && source ? source : job.dedupeKey
}

function storageIssueLabel(issue: string): string {
  return { missing: '文件缺失', size_mismatch: '大小不符', checksum_mismatch: '校验值不符', unsafe_path: '路径不安全', orphaned: '数据库外文件' }[issue] ?? issue
}

function auditActionLabel(action: string): string {
  if (action === 'auth.login.succeeded') return '登录成功'
  if (action === 'auth.login.failed') return '登录失败'
  if (action === 'auth.login.blocked') return '登录被限流'
  if (action === 'POST /api/v1/calibre/references/sync') return '启动 Calibre 只读引用同步'
  const labels: Record<string, string> = {
    'POST /api/v1/users': '创建用户',
    'PATCH /api/v1/users/{id}': '修改用户',
    'DELETE /api/v1/users/{id}': '删除用户',
    'POST /api/v1/users/{id}/password': '重置用户密码',
    'DELETE /api/v1/users/{id}/sessions': '下线用户全部设备',
    'DELETE /api/v1/users/{id}/sessions/{sessionId}': '下线用户设备',
    'POST /api/v1/book-files': '上传书籍',
    'POST /api/v1/book-files/{id}/cover/regenerate': '重新生成 PDF 封面',
    'PUT /api/v1/editions/{id}/review': '确认书目分类',
    'POST /api/v1/editions/{id}/ai-classify': '请求 AI 分类',
    'POST /api/v1/editions/{id}/bibliography-search': '查询外部书目',
    'POST /api/v1/background-jobs/{id}/retry': '重试后台任务',
    'POST /api/v1/admin/classification/reclassify': '重新分类未归类书籍',
    'POST /api/v1/calibre/import': '启动 Calibre 迁移',
    'POST /api/v1/admin/categories': '创建题材分类',
    'PATCH /api/v1/admin/categories/{id}': '修改题材分类',
    'PATCH /api/v1/admin/bibliography-sources/{id}': '修改外部书目源',
    'POST /api/v1/admin/bibliography-sources/{id}/test': '测试外部书目源',
  }
  return labels[action] ?? action
}

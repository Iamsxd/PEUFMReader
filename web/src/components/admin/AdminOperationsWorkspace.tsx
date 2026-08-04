import { useEffect, useState } from 'react'
import { APIError, api } from '../../api'
import type { AuditEvent, BackgroundJob, OperationsHealthIssue, OperationsOverview, StorageAuditReport } from '../../types'
import { formatBytes, formatDuration, formatRelativeTime } from '../../utils'

interface Props {
  onError: (message: string) => void
  onDataChanged: () => void
  onActiveJobCountChange: (count: number) => void
}

export default function AdminOperationsWorkspace({ onError, onDataChanged, onActiveJobCountChange }: Props) {
  const [backgroundJobs, setBackgroundJobs] = useState<BackgroundJob[]>([])
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([])
  const [storageReport, setStorageReport] = useState<StorageAuditReport | null>(null)
  const [overview, setOverview] = useState<OperationsOverview | null>(null)
  const [checkingStorage, setCheckingStorage] = useState(false)

  async function refreshOperations() {
    const [jobs, audits, nextOverview] = await Promise.all([api.listBackgroundJobs(), api.listAuditEvents(), api.getOperationsOverview()])
    setBackgroundJobs(jobs)
    setAuditEvents(audits)
    setOverview(nextOverview)
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
    <section className="integration-panel operations-overview-panel">
      <div className="section-title"><div><p className="eyebrow">运行概览</p><h2>服务状态</h2><p className="muted">仅展示聚合运维数据；不记录书名、正文、路径或个人阅读内容。</p></div><button className="secondary" type="button" onClick={() => void refreshOperations().catch((reason) => onError(reason instanceof APIError ? reason.message : '无法刷新运行状态。'))}>刷新</button></div>
      {overview ? <><div className="operations-metric-grid">
        <Metric label="综合健康" value={healthStatusLabel(overview.health.status)} attention={overview.health.status !== 'healthy'} />
        <Metric label="服务已运行" value={formatDuration(overview.uptimeSeconds)} />
        <Metric label="活跃读者（24 小时）" value={String(overview.snapshot.activeUsers24Hours)} />
        <Metric label="当前阅读会话" value={String(overview.snapshot.activeReadingSessions)} />
        <Metric label="数据库连接" value={String(overview.snapshot.databaseConnections)} />
        <Metric label="等待 / 运行任务" value={`${overview.snapshot.queuedJobs} / ${overview.snapshot.runningJobs}`} />
        <Metric label="24 小时失败" value={String(overview.snapshot.failedJobsLast24Hours)} attention={overview.snapshot.failedJobsLast24Hours >= overview.health.thresholds.failedJobsWarning} />
        <Metric label="可重试任务" value={String(overview.snapshot.retryingJobs)} attention={overview.snapshot.retryingJobs > 0} />
        <Metric label="最长等待" value={formatDuration(overview.snapshot.oldestQueuedSeconds)} attention={overview.snapshot.oldestQueuedSeconds >= overview.health.thresholds.queueWarningSeconds} />
        <Metric label="应用堆内存" value={formatBytes(overview.heapAllocBytes)} />
        <Metric label="Go 协程" value={String(overview.goRoutines)} />
      </div>
      <div className={`operations-health-summary ${overview.health.status}`}>
        <strong>{overview.health.issues.length === 0 ? '所有健康阈值均正常' : `${overview.health.issues.length} 项需要关注`}</strong>
        <span>磁盘 {overview.health.thresholds.diskWarningPercent}% / {overview.health.thresholds.diskCriticalPercent}% · 队列 {formatDuration(overview.health.thresholds.queueWarningSeconds)} / {formatDuration(overview.health.thresholds.queueCriticalSeconds)} · 失败任务 {overview.health.thresholds.failedJobsWarning} / {overview.health.thresholds.failedJobsCritical}（预警 / 严重）</span>
        {overview.health.issues.map((issue) => <small key={`${issue.code}-${issue.resource}`}>{healthIssueLabel(issue)}</small>)}
      </div>
      <div className="operations-detail-grid">
        <div className="operations-request-list"><div><strong>磁盘空间</strong><small>可用 / 总量 / 已用</small></div>{overview.disks.map((disk) => <p key={disk.label}><span>{diskLabel(disk.label)}</span><span>{disk.available ? `${formatBytes(disk.availableBytes)} / ${formatBytes(disk.totalBytes)} / ${disk.usedPercent.toFixed(1)}%` : '无法读取'}</span></p>)}</div>
        <div className="operations-request-list"><div><strong>任务分类耗时（24 小时）</strong><small>完成 / 失败 / 平均 / P95</small></div>{overview.jobKinds.length === 0 ? <p><span>暂无已结束任务</span><span>—</span></p> : overview.jobKinds.map((metric) => <p key={metric.kind}><span>{jobKindLabel(metric.kind)}</span><span>{metric.completedLast24Hours} / {metric.failedLast24Hours} / {formatDuration(metric.averageDurationSeconds)} / {formatDuration(metric.p95DurationSeconds)}</span></p>)}</div>
      </div>
      <div className="operations-request-list"><div><strong>近期请求（服务启动后，单接口保留最近 200 次）</strong><small>请求 / 错误 / P95</small></div>{overview.requests.slice(0, 8).map((metric) => <p key={metric.route}><code>{metric.route}</code><span>{metric.requests} / {metric.errors} / {metric.p95DurationMs} ms</span></p>)}</div></> : <div className="job-empty">正在汇总运行状态…</div>}
    </section>
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

function Metric({ label, value, attention = false }: { label: string; value: string; attention?: boolean }) {
  return <div className={attention ? 'has-issue' : ''}><strong>{value}</strong><span>{label}</span></div>
}

function healthStatusLabel(status: OperationsOverview['health']['status']): string {
  return { healthy: '正常', warning: '预警', critical: '严重' }[status]
}

function healthIssueLabel(issue: OperationsHealthIssue): string {
  if (issue.code === 'disk_unavailable') return `${diskLabel(issue.resource)}空间无法读取`
  if (issue.code === 'disk_usage') return `${diskLabel(issue.resource)}已用 ${issue.value.toFixed(1)}%，达到${issue.severity === 'critical' ? '严重' : '预警'}阈值 ${issue.threshold}%`
  if (issue.code === 'queue_wait') return `最长排队 ${formatDuration(issue.value)}，达到阈值 ${formatDuration(issue.threshold)}`
  if (issue.code === 'failed_jobs') return `24 小时失败任务 ${issue.value}，达到阈值 ${issue.threshold}`
  return `${issue.resource} 达到${issue.severity === 'critical' ? '严重' : '预警'}阈值`
}

function diskLabel(label: string): string {
  return { library: '书库', staging: '暂存区', cache: '缓存' }[label] ?? label
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

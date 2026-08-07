import { useEffect, useState } from 'react'
import { APIError, api } from '../../api'
import type { AuditEvent, BackgroundJob, OperationsHealthIssue, OperationsOverview, StorageAuditReport } from '../../types'
import { formatBytes, formatDuration, formatRelativeTime } from '../../utils'

type JobFilter = 'attention' | 'failed' | 'queued' | 'running' | 'all'

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
  const [jobFilter, setJobFilter] = useState<JobFilter>('attention')

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

  function showRelatedJobs(issue: OperationsHealthIssue) {
    setJobFilter(issue.code === 'failed_jobs' ? 'failed' : 'queued')
    window.requestAnimationFrame(() => document.getElementById('background-job-queue')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const visibleJobs = backgroundJobs.filter((job) => {
    if (jobFilter === 'all') return true
    if (jobFilter === 'attention') return job.state === 'queued' || job.state === 'running' || job.state === 'failed'
    return job.state === jobFilter
  })

  return <div className="admin-workspace-module">
    <section className="integration-panel operations-overview-panel">
      <div className="section-title"><div><p className="eyebrow">运行概览</p><h2>服务状态</h2><p className="muted">仅展示聚合运维数据；不记录书名、正文、路径或个人阅读内容。</p></div><button className="secondary" type="button" onClick={() => void refreshOperations().catch((reason) => onError(reason instanceof APIError ? reason.message : '无法刷新运行状态。'))}>刷新</button></div>
      {overview ? <><div className="operations-metric-grid">
        <Metric label="综合健康" value={healthStatusLabel(overview.health.status)} attention={overview.health.status !== 'healthy'} />
        <Metric label="服务已运行" value={formatDuration(overview.uptimeSeconds)} />
        <Metric label="活跃读者（24 小时）" value={String(overview.snapshot.activeUsers24Hours)} />
        <Metric label="当前阅读会话" value={String(overview.snapshot.activeReadingSessions)} />
        <Metric label="数据库连接" value={String(overview.snapshot.databaseConnections)} />
        <Metric label="后台任务" value={`等待 ${overview.snapshot.queuedJobs} · 运行 ${overview.snapshot.runningJobs}`} />
        <Metric label="最近 24 小时失败任务" value={`${overview.snapshot.failedJobsLast24Hours} 个`} attention={overview.snapshot.failedJobsLast24Hours >= overview.health.thresholds.failedJobsWarning} />
        <Metric label="可重试任务" value={String(overview.snapshot.retryingJobs)} attention={overview.snapshot.retryingJobs > 0} />
        <Metric label="最长等待" value={formatDuration(overview.snapshot.oldestQueuedSeconds)} attention={overview.snapshot.oldestQueuedSeconds >= overview.health.thresholds.queueWarningSeconds} />
        <Metric label="应用堆内存" value={formatBytes(overview.heapAllocBytes)} />
        <Metric label="应用内部并发（Go 协程）" value={String(overview.goRoutines)} />
      </div>
      <div className={`operations-health-summary ${overview.health.status}`}>
        <div className="operations-health-heading"><div><strong>{overview.health.issues.length === 0 ? '当前监测值均正常' : `${overview.health.issues.length} 项当前状态需要关注`}</strong><span>下面先显示实际触发原因，再单独列出系统告警线。</span></div>{overview.health.issues.some((issue) => issue.resource === 'background_jobs') && <button className="secondary" type="button" onClick={() => showRelatedJobs(overview.health.issues.find((issue) => issue.resource === 'background_jobs')!)}>查看相关任务</button>}</div>
        {overview.health.issues.length > 0 && <div className="operations-health-issues">{overview.health.issues.map((issue) => <div key={`${issue.code}-${issue.resource}`}><b>{issue.severity === 'critical' ? '严重' : '预警'}</b><span>{healthIssueLabel(issue)}</span>{issue.resource === 'background_jobs' && <button type="button" onClick={() => showRelatedJobs(issue)}>定位任务</button>}</div>)}</div>}
        <div className="operations-threshold-grid">
          <div><strong>磁盘占用告警线</strong><span>达到 {overview.health.thresholds.diskWarningPercent}% 预警 · 达到 {overview.health.thresholds.diskCriticalPercent}% 严重</span><small>这是阈值，不是当前占用；当前值见下方“磁盘空间”。</small></div>
          <div><strong>任务排队告警线</strong><span>等待 {formatDuration(overview.health.thresholds.queueWarningSeconds)} 预警 · 等待 {formatDuration(overview.health.thresholds.queueCriticalSeconds)} 严重</span><small>当前最长等待：{formatDuration(overview.snapshot.oldestQueuedSeconds)}</small></div>
          <div><strong>失败任务告警线（24 小时）</strong><span>达到 {overview.health.thresholds.failedJobsWarning} 个预警 · 达到 {overview.health.thresholds.failedJobsCritical} 个严重</span><small>当前实际失败：{overview.snapshot.failedJobsLast24Hours} 个</small></div>
        </div>
      </div>
      <div className="operations-detail-grid">
        <div className="operations-request-list"><div><strong>当前磁盘空间</strong><small>每一行都是实际读取值</small></div>{overview.disks.map((disk) => <p key={disk.label}><span>{diskLabel(disk.label)}</span><span>{disk.available ? `已用 ${disk.usedPercent.toFixed(1)}% · 可用 ${formatBytes(disk.availableBytes)} · 总量 ${formatBytes(disk.totalBytes)}` : '无法读取磁盘信息'}</span></p>)}</div>
        <div className="operations-request-list"><div><strong>任务分类耗时（最近 24 小时）</strong><small>P95 表示 95% 的任务不超过该时长</small></div>{overview.jobKinds.length === 0 ? <p><span>暂无已结束任务</span><span>—</span></p> : overview.jobKinds.map((metric) => <p key={metric.kind}><span>{jobKindLabel(metric.kind)}</span><span>完成 {metric.completedLast24Hours} · 失败 {metric.failedLast24Hours} · 平均 {formatDuration(metric.averageDurationSeconds)} · P95 {formatDuration(metric.p95DurationSeconds)}</span></p>)}</div>
      </div>
      <div className="operations-request-list"><div><strong>近期请求（服务启动后，单接口保留最近 200 次）</strong><small>请求次数、错误次数和响应耗时</small></div>{overview.requests.slice(0, 8).map((metric) => <p key={metric.route}><code>{metric.route}</code><span>请求 {metric.requests} · 错误 {metric.errors} · P95 {metric.p95DurationMs} ms</span></p>)}</div></> : <div className="job-empty">正在汇总运行状态…</div>}
    </section>
    <section className="jobs-panel compact-admin-panel" id="background-job-queue">
      <div className="section-title"><div><p className="eyebrow">可恢复后台任务</p><h2>处理队列与失败详情</h2><p className="muted">失败任务会显示具体来源、错误原因和尝试次数，可在这里人工重试。</p></div></div>
      <div className="job-filter-bar" aria-label="任务筛选">{(['attention', 'failed', 'queued', 'running', 'all'] as JobFilter[]).map((filter) => <button className={jobFilter === filter ? 'active' : ''} type="button" key={filter} onClick={() => setJobFilter(filter)}>{jobFilterLabel(filter)} <span>{jobFilterCount(filter, backgroundJobs)}</span></button>)}</div>
      <div className="job-list">{visibleJobs.length === 0 && <div className="job-empty">{jobFilter === 'failed' ? '当前没有失败任务' : '此筛选下暂无后台任务'}</div>}{visibleJobs.slice(0, 50).map((job) => <div className={`job-row background-job-row${job.state === 'failed' ? ' failed-job' : ''}`} key={job.id}><span className={`job-state ${job.state}`}>{jobStateLabel(job.state)}</span><span><strong>{jobKindLabel(job.kind)}</strong><small title={jobSourceLabel(job)}>{jobSourceLabel(job)}</small><small>任务 #{job.id} · 更新于 {formatRelativeTime(job.updatedAt)} · 尝试 {job.attempts} / {job.maxAttempts}</small></span><span className="job-progress"><span className={job.lastError ? 'job-error-message' : ''}>{job.lastError || job.progressMessage || '等待任务处理器'}</span><i><b style={{ width: `${job.progress}%` }} /></i><small>{job.progress}%</small>{job.lastError && <details><summary>展开完整失败原因</summary><p>{job.lastError}</p></details>}</span>{job.state === 'failed' && <button className="secondary" type="button" onClick={() => void retryJob(job.id)}>重新排队</button>}</div>)}</div>
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

function jobFilterLabel(filter: JobFilter): string {
  return { attention: '需要关注', failed: '失败', queued: '排队', running: '处理中', all: '全部' }[filter]
}

function jobFilterCount(filter: JobFilter, jobs: BackgroundJob[]): number {
  if (filter === 'all') return jobs.length
  if (filter === 'attention') return jobs.filter((job) => job.state === 'queued' || job.state === 'running' || job.state === 'failed').length
  return jobs.filter((job) => job.state === filter).length
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

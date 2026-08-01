import { lazy, Suspense, useEffect, useState } from 'react'
import { api } from '../api'

const AdminImportsWorkspace = lazy(() => import('./admin/AdminImportsWorkspace'))
const AdminCatalogWorkspace = lazy(() => import('./admin/AdminCatalogWorkspace'))
const AdminUsersWorkspace = lazy(() => import('./admin/AdminUsersWorkspace'))
const AdminOperationsWorkspace = lazy(() => import('./admin/AdminOperationsWorkspace'))

interface Props {
  initialEditionID?: number
  currentUserID: number
}

type AdminSection = 'imports' | 'catalog' | 'users' | 'operations'

const ADMIN_SECTIONS: Array<{ id: AdminSection; label: string; eyebrow: string; description: string }> = [
  { id: 'imports', label: '书籍导入', eyebrow: '采集', description: '网页上传、目录监控与 Calibre 迁移' },
  { id: 'catalog', label: '书目与分类', eyebrow: '整理', description: '元数据审核、分类规则与重复合并' },
  { id: 'users', label: '用户与权限', eyebrow: '访问', description: '账号、登录设备与书库访问控制' },
  { id: 'operations', label: '任务与运维', eyebrow: '系统', description: '后台任务、存储检查与安全审计' },
]

export function AdminPage({ initialEditionID, currentUserID }: Props) {
  const [activeSection, setActiveSection] = useState<AdminSection>(initialEditionID ? 'catalog' : 'imports')
  const [reviewTotal, setReviewTotal] = useState(0)
  const [activeJobCount, setActiveJobCount] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function refreshBadges() {
    const [queueTotal, jobs] = await Promise.all([api.getReviewQueueCount(), api.listBackgroundJobs()])
    setReviewTotal(queueTotal)
    setActiveJobCount(jobs.filter((job) => job.state === 'queued' || job.state === 'running').length)
  }

  useEffect(() => {
    void refreshBadges().catch(() => undefined)
    const timer = window.setInterval(() => void refreshBadges().catch(() => undefined), 15_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (initialEditionID) setActiveSection('catalog')
  }, [initialEditionID])

  const activeDefinition = ADMIN_SECTIONS.find((section) => section.id === activeSection) ?? ADMIN_SECTIONS[0]
  const feedback = {
    onError: setError,
    onNotice: setNotice,
    onDataChanged: () => void refreshBadges().catch(() => undefined),
  }

  return (
    <div className="admin-page">
      <section className="page-heading admin-heading">
        <div><p className="eyebrow">系统管理</p><h1>管理后台</h1><p className="muted">按工作区管理书库，不必在一个长页面中寻找功能。</p></div>
      </section>

      {error && <div className="notice error" role="alert">{error}</div>}
      {notice && <div className="notice success" role="status">{notice}</div>}

      <div className="admin-workspace">
        <nav className="admin-section-navigation" aria-label="管理后台工作区">
          {ADMIN_SECTIONS.map((section) => {
            const count = section.id === 'catalog' ? reviewTotal : section.id === 'operations' ? activeJobCount : 0
            return (
              <button key={section.id} className={activeSection === section.id ? 'active' : ''} type="button" onClick={() => { setActiveSection(section.id); setError(''); setNotice('') }} aria-current={activeSection === section.id ? 'page' : undefined}>
                <span><small>{section.eyebrow}</small><strong>{section.label}</strong></span>
                {count > 0 && <b>{count}</b>}
                <i aria-hidden="true">›</i>
              </button>
            )
          })}
        </nav>

        <div className="admin-workspace-content">
          <header className="admin-section-heading">
            <div><p className="eyebrow">{activeDefinition.eyebrow}</p><h2>{activeDefinition.label}</h2><p className="muted">{activeDefinition.description}</p></div>
          </header>
          <Suspense fallback={<section className="admin-workspace-loading" role="status"><span className="loading-spinner" /><strong>正在加载工作区…</strong></section>}>
            {activeSection === 'imports' && <AdminImportsWorkspace {...feedback} />}
            {activeSection === 'catalog' && <AdminCatalogWorkspace {...feedback} initialEditionID={initialEditionID} onReviewTotalChange={setReviewTotal} />}
            {activeSection === 'users' && <AdminUsersWorkspace currentUserID={currentUserID} onError={setError} onNotice={setNotice} />}
            {activeSection === 'operations' && <AdminOperationsWorkspace {...feedback} onActiveJobCountChange={setActiveJobCount} />}
          </Suspense>
        </div>
      </div>
    </div>
  )
}

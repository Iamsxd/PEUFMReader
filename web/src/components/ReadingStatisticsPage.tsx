import { type CSSProperties, useEffect, useMemo, useState } from 'react'
import { APIError, api } from '../api'
import type { BookFile, ReadingStatistics } from '../types'
import { formatDuration, formatRelativeTime } from '../utils'
import { BookCard } from './BookCard'

interface Props {
  onOpenBook: (book: BookFile) => void
  onViewBook: (book: BookFile) => void
}

export function ReadingStatisticsPage({ onOpenBook, onViewBook }: Props) {
  const [statistics, setStatistics] = useState<ReadingStatistics | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let disposed = false
    void api.getReadingStatistics().then((result) => {
      if (!disposed) setStatistics(result)
    }).catch((reason) => {
      if (!disposed) setError(reason instanceof APIError ? reason.message : '无法加载阅读统计。')
    })
    return () => { disposed = true }
  }, [])

  if (error) return <section className="empty-state"><h2>阅读统计暂不可用</h2><p>{error}</p></section>
  if (!statistics) return <section className="catalog-loading">正在汇总你的阅读记录…</section>

  const completionRate = statistics.trackedBooks > 0 ? Math.round((statistics.finishedBooks / statistics.trackedBooks) * 100) : 0
  return <div className="reading-statistics-page">
    <header className="page-heading"><div><p className="eyebrow">我的阅读</p><h1>阅读统计</h1><p>统计仅基于你有权限访问的书籍和已同步的阅读时长。</p></div><span className="stats-updated">更新于 {formatRelativeTime(statistics.generatedAt)}</span></header>

    <section className="reading-stat-summary-grid">
      <StatisticCard label="今天阅读" value={formatDuration(statistics.todayActiveSeconds)} detail="按阅读会话开始日期统计" primary />
      <StatisticCard label="最近 7 天" value={formatDuration(statistics.weekActiveSeconds)} detail="本周累计有效阅读" />
      <StatisticCard label="最近 30 天" value={formatDuration(statistics.monthActiveSeconds)} detail={`读完 ${statistics.completedLast30Days} 本`} />
      <StatisticCard label="累计阅读" value={formatDuration(statistics.totalActiveSeconds)} detail={`${statistics.trackedBooks} 本留下记录`} />
    </section>

    <section className="reading-activity-panel">
      <div className="dashboard-section-heading"><div><p className="eyebrow">近 {statistics.windowDays} 天</p><h2>阅读热力图</h2></div><div className="streak-summary"><span>连续 <strong>{statistics.currentStreakDays}</strong> 天</span><span>最长 <strong>{statistics.longestStreakDays}</strong> 天</span></div></div>
      <ActivityHeatmap activity={statistics.dailyActivity} />
      <ActivityTrend activity={statistics.dailyActivity.slice(-14)} />
    </section>

    <div className="reading-stat-detail-grid">
      <section className="reading-breakdown-panel">
        <div className="dashboard-section-heading"><div><p className="eyebrow">阅读成果</p><h2>书籍进度</h2></div></div>
        <div className="completion-ring" style={{ '--completion': `${completionRate * 3.6}deg` } as CSSProperties}><strong>{completionRate}%</strong><span>完成率</span></div>
        <dl className="reading-breakdown-list"><div><dt>正在阅读</dt><dd>{statistics.readingBooks} 本</dd></div><div><dt>已经读完</dt><dd>{statistics.finishedBooks} 本</dd></div><div><dt>累计有记录</dt><dd>{statistics.trackedBooks} 本</dd></div></dl>
      </section>
      <BreakdownPanel title="格式分布" eyebrow="我常用的阅读格式" items={statistics.formats.map((item) => ({ label: item.format.toUpperCase(), detail: `${item.bookCount} 本 · ${formatDuration(item.activeSeconds)}`, value: item.activeSeconds }))} empty="开始阅读后会显示格式分布。" />
      <BreakdownPanel title="题材偏好" eyebrow="按有效阅读时长排序" items={statistics.categories.map((item) => ({ label: item.name, detail: `${item.bookCount} 本 · ${formatDuration(item.activeSeconds)}`, value: item.activeSeconds }))} empty="为书籍补充分类后，这里会显示阅读题材偏好。" />
    </div>

    <section className="dashboard-section recently-finished-section">
      <div className="dashboard-section-heading"><div><p className="eyebrow">完成一本书</p><h2>最近读完</h2></div></div>
      {statistics.recentlyFinished.length === 0 ? <p className="muted">读完一本书后，它会出现在这里。</p> : <div className="book-shelf">{statistics.recentlyFinished.map((item) => <BookCard key={item.book.id} book={item.book} onOpen={onOpenBook} onDetails={onViewBook} compact activeSeconds={item.totalActiveSeconds} lastReadAt={item.finishedAt} />)}</div>}
    </section>
  </div>
}

function StatisticCard({ label, value, detail, primary = false }: { label: string; value: string; detail: string; primary?: boolean }) {
  return <article className={`reading-summary-card${primary ? ' primary' : ''}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>
}

function ActivityHeatmap({ activity }: { activity: ReadingStatistics['dailyActivity'] }) {
  const maximum = Math.max(1, ...activity.map((item) => item.activeSeconds))
  return <div className="reading-heatmap" aria-label="近十二周阅读热力图">{activity.map((item) => {
    const level = heatLevel(item.activeSeconds, maximum)
    return <span className={`heat-level-${level}`} key={item.date} title={`${item.date} · ${formatDuration(item.activeSeconds)}`} aria-label={`${item.date} 阅读 ${formatDuration(item.activeSeconds)}`} />
  })}</div>
}

function ActivityTrend({ activity }: { activity: ReadingStatistics['dailyActivity'] }) {
  const maximum = Math.max(1, ...activity.map((item) => item.activeSeconds))
  return <div className="reading-activity-trend">{activity.map((item) => <div key={item.date} title={`${item.date} · ${formatDuration(item.activeSeconds)}`}><i style={{ height: `${Math.max(item.activeSeconds > 0 ? 7 : 2, Math.round((item.activeSeconds / maximum) * 100))}%` }} /><span>{item.date.slice(5).replace('-', '/')}</span></div>)}</div>
}

function BreakdownPanel({ title, eyebrow, items, empty }: { title: string; eyebrow: string; items: { label: string; detail: string; value: number }[]; empty: string }) {
  const maximum = useMemo(() => Math.max(1, ...items.map((item) => item.value)), [items])
  return <section className="reading-breakdown-panel"><div className="dashboard-section-heading"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div></div>{items.length === 0 ? <p className="muted">{empty}</p> : <div className="reading-rank-list">{items.map((item) => <div key={item.label}><span><strong>{item.label}</strong><small>{item.detail}</small></span><i><b style={{ width: `${Math.max(4, Math.round((item.value / maximum) * 100))}%` }} /></i></div>)}</div>}</section>
}

function heatLevel(value: number, maximum: number): number {
  if (value <= 0) return 0
  const ratio = value / maximum
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}

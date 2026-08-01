import { useEffect, useState } from 'react'
import { listOfflineBooks, offlineStorageEstimate, offlineStorageSupported, removeOfflineBook, type OfflineBookRecord } from '../offline'
import type { BookFile } from '../types'
import { formatBytes, formatRelativeTime } from '../utils'
import { BookCard } from './BookCard'

interface Props {
  userID: number
  offlineMode: boolean
  onOpenBook: (book: BookFile) => void
  onBrowse: () => void
}

export function OfflineBooksPage({ userID, offlineMode, onOpenBook, onBrowse }: Props) {
  const [records, setRecords] = useState<OfflineBookRecord[]>([])
  const [usage, setUsage] = useState({ usage: 0, quota: 0 })
  const [busyBookID, setBusyBookID] = useState<number | null>(null)
  const [error, setError] = useState('')

  const refresh = () => {
    setRecords(listOfflineBooks(userID))
    void offlineStorageEstimate().then(setUsage).catch(() => undefined)
  }

  useEffect(refresh, [userID])

  async function remove(record: OfflineBookRecord) {
    setBusyBookID(record.book.id)
    setError('')
    try {
      await removeOfflineBook(userID, record.book.id)
      refresh()
    } catch {
      setError('无法删除这个离线副本，请检查浏览器站点存储权限。')
    } finally {
      setBusyBookID(null)
    }
  }

  const savedBytes = records.reduce((total, item) => total + item.contentBytes, 0)
  const supported = offlineStorageSupported()
  return (
    <section className="offline-books-page">
      <div className="page-heading">
        <div><p className="eyebrow">此设备</p><h1>离线书籍</h1><p>主动保存到当前浏览器的书籍；退出登录会清除此账号的设备副本。</p></div>
        {!offlineMode && <button className="secondary" onClick={onBrowse}>添加更多书籍</button>}
      </div>
      {offlineMode && <div className="notice offline-notice" role="status">当前无法连接服务器。可以继续阅读已保存书籍；进度和时长会在恢复联网后同步，书签与高亮暂时只读。</div>}
      {!supported && <div className="notice error" role="alert">当前地址不允许浏览器离线存储。请通过 HTTPS 访问，或在部署服务器本机使用 localhost。</div>}
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="offline-storage-summary">
        <div><strong>{records.length}</strong><span>离线书籍</span></div>
        <div><strong>{formatBytes(savedBytes)}</strong><span>书籍副本</span></div>
        <div><strong>{usage.quota > 0 ? `${formatBytes(usage.usage)} / ${formatBytes(usage.quota)}` : '由浏览器管理'}</strong><span>站点存储</span></div>
      </div>
      {records.length === 0 ? (
        <div className="empty-state"><h2>还没有离线书籍</h2><p>{supported ? '联网时打开书籍详情，选择“保存到此设备”。' : '离线书籍需要在 HTTPS 安全上下文中使用。'}</p>{!offlineMode && <button onClick={onBrowse}>浏览全部书籍</button>}</div>
      ) : (
        <div className="offline-book-grid">
          {records.map((record) => (
            <article className="offline-book-record" key={record.book.id}>
              <BookCard book={record.book} onOpen={onOpenBook} compact />
              <footer>
                <span>{formatBytes(record.contentBytes)} · 保存于 {formatRelativeTime(record.cachedAt)}</span>
                <button className="quiet danger-button" disabled={busyBookID === record.book.id} onClick={() => void remove(record)}>{busyBookID === record.book.id ? '删除中…' : '移除设备副本'}</button>
              </footer>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

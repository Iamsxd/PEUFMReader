import { useCallback, useEffect, useState } from 'react'
import { listOfflineBooks, offlineAutoCleanupEnabled, offlineStorageEstimate, offlineStorageSupported, reconcileOfflineBooks, removeOfflineBook, removeOldestOfflineBook, setOfflineAutoCleanupEnabled, type OfflineBookRecord, type OfflineStorageEstimate } from '../offline'
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
  const [usage, setUsage] = useState<OfflineStorageEstimate>({ usage: 0, quota: 0, available: 0, persistent: null })
  const [busyBookID, setBusyBookID] = useState<number | null>(null)
  const [cleaning, setCleaning] = useState(false)
  const [autoCleanup, setAutoCleanup] = useState(() => offlineAutoCleanupEnabled(userID))
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = useCallback(() => {
    setRecords(listOfflineBooks(userID))
    void offlineStorageEstimate().then(setUsage).catch(() => undefined)
  }, [userID])

  useEffect(() => {
    setAutoCleanup(offlineAutoCleanupEnabled(userID))
    void reconcileOfflineBooks(userID).then((result) => {
      if (result.removed.length > 0) setNotice(`已清理 ${result.removed.length} 个失效或最久未读的设备副本。`)
      refresh()
    }).catch(() => refresh())
  }, [refresh, userID])

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

  async function cleanOldest() {
    setCleaning(true)
    setError('')
    setNotice('')
    try {
      const result = await removeOldestOfflineBook(userID)
      setNotice(result.removed.length > 0 ? `已移除最久未读的《${result.removed[0].book.title}》，释放 ${formatBytes(result.freedBytes)}。` : '没有可清理的设备副本。')
      refresh()
    } catch {
      setError('无法自动清理设备副本，请检查浏览器站点存储权限。')
    } finally {
      setCleaning(false)
    }
  }

  function changeAutoCleanup(enabled: boolean) {
    setOfflineAutoCleanupEnabled(userID, enabled)
    setAutoCleanup(enabled)
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
      {notice && <div className="notice success" role="status">{notice}</div>}
      <div className="offline-storage-summary">
        <div><strong>{records.length}</strong><span>离线书籍</span></div>
        <div><strong>{formatBytes(savedBytes)}</strong><span>书籍副本</span></div>
        <div><strong>{usage.quota > 0 ? formatBytes(usage.available) : '由浏览器管理'}</strong><span>浏览器剩余配额</span></div>
      </div>
      <section className="offline-storage-controls" aria-label="离线存储管理">
        <div><strong>设备空间管理</strong><span>{usage.quota > 0 ? `本站已用 ${formatBytes(usage.usage)} / ${formatBytes(usage.quota)}` : '浏览器未提供准确的站点配额'} · {usage.persistent === true ? '已获得持久存储保护' : usage.persistent === false ? '缓存可能被浏览器自动回收' : '持久存储状态未知'}</span></div>
        <label><input type="checkbox" checked={autoCleanup} onChange={(event) => changeAutoCleanup(event.target.checked)} /><span>空间紧张时自动移除最久未读副本</span></label>
        <button className="secondary" type="button" disabled={cleaning || records.length === 0} onClick={() => void cleanOldest()}>{cleaning ? '清理中…' : '清理最久未读副本'}</button>
      </section>
      {records.length === 0 ? (
        <div className="empty-state"><h2>还没有离线书籍</h2><p>{supported ? '联网时打开书籍详情，选择“保存到此设备”。' : '离线书籍需要在 HTTPS 安全上下文中使用。'}</p>{!offlineMode && <button onClick={onBrowse}>浏览全部书籍</button>}</div>
      ) : (
        <div className="offline-book-grid">
          {records.map((record) => (
            <article className="offline-book-record" key={record.book.id}>
              <BookCard book={record.book} onOpen={onOpenBook} compact />
              <footer>
                <span>{formatBytes(record.contentBytes)} · {record.lastOpenedAt ? `最近打开于 ${formatRelativeTime(record.lastOpenedAt)}` : `保存于 ${formatRelativeTime(record.cachedAt)}`}</span>
                <button className="quiet danger-button" disabled={busyBookID === record.book.id} onClick={() => void remove(record)}>{busyBookID === record.book.id ? '删除中…' : '移除设备副本'}</button>
              </footer>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

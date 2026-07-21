import { useEffect, useState } from 'react'
import { APIError, api } from '../api'
import type { BookFile, BookPermission, ManagedUser } from '../types'

interface Props {
  users: ManagedUser[]
  onError: (message: string) => void
  onNotice: (message: string) => void
}

export function LibraryPermissionManager({ users, onError, onNotice }: Props) {
  const [userID, setUserID] = useState(0)
  const [query, setQuery] = useState('')
  const [books, setBooks] = useState<BookFile[]>([])
  const [selected, setSelected] = useState<number[]>([])
  const [rules, setRules] = useState<BookPermission[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!userID && users.length) setUserID(users.find((user) => user.role === 'reader')?.id ?? users[0].id)
  }, [userID, users])

  useEffect(() => {
    if (!userID) return
    void api.listUserBookPermissions(userID).then(setRules).catch((reason) => onError(errorMessage(reason)))
  }, [userID, onError])

  async function search() {
    try {
      const result = await api.listBooks({ q: query, pageSize: 20, sort: query ? 'relevance' : 'title' })
      setBooks(result.items)
      setSelected([])
    } catch (reason) {
      onError(errorMessage(reason))
    }
  }

  async function apply(mode: 'allow' | 'deny' | 'default') {
    if (!userID || selected.length === 0) return
    setBusy(true)
    onError('')
    try {
      for (const bookID of selected) {
        if (mode === 'default') await api.deleteUserBookPermission(userID, bookID).catch((reason) => {
          if (!(reason instanceof APIError) || reason.code !== 'permission_not_found') throw reason
        })
        else await api.setUserBookPermission(userID, bookID, mode === 'allow')
      }
      setRules(await api.listUserBookPermissions(userID))
      onNotice(`已为 ${selected.length} 本书更新访问规则。`)
    } catch (reason) {
      onError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  function toggle(bookID: number) {
    setSelected((current) => current.includes(bookID) ? current.filter((id) => id !== bookID) : [...current, bookID])
  }

  return (
    <section className="library-permission-panel">
      <div className="section-title"><div><p className="eyebrow">书库权限</p><h3>逐书访问控制</h3><p className="muted">默认允许阅读；显式拒绝会同时隐藏详情、文件、封面、搜索、OPDS 和设备进度接口。管理员始终拥有访问权。</p></div></div>
      <div className="permission-toolbar">
        <label><span>用户</span><select value={userID} onChange={(event) => setUserID(Number(event.target.value))}>{users.map((user) => <option key={user.id} value={user.id}>{user.username}（{user.role === 'admin' ? '管理员' : '阅读者'}）</option>)}</select></label>
        <label><span>搜索书籍</span><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void search() }} placeholder="书名、作者、ISBN" /></label>
        <button className="secondary" type="button" onClick={() => void search()}>查询</button>
      </div>
      {books.length > 0 && <div className="permission-book-list">{books.map((book) => {
        const explicit = rules.find((rule) => rule.bookFileId === book.id)
        return <label key={book.id}><input type="checkbox" checked={selected.includes(book.id)} onChange={() => toggle(book.id)} /><span><strong>{book.title}</strong><small>{book.authors.join('、') || book.originalFilename} · {explicit ? explicit.canRead ? '显式允许' : '显式拒绝' : '默认允许'}</small></span></label>
      })}</div>}
      <div className="permission-actions">
        <button className="secondary" disabled={busy || !selected.length} type="button" onClick={() => void apply('allow')}>允许所选</button>
        <button className="danger-button" disabled={busy || !selected.length} type="button" onClick={() => void apply('deny')}>拒绝所选</button>
        <button className="quiet" disabled={busy || !selected.length} type="button" onClick={() => void apply('default')}>恢复默认</button>
        <span>{rules.length} 条显式规则</span>
      </div>
    </section>
  )
}

function errorMessage(reason: unknown): string {
  return reason instanceof APIError ? reason.message : '书库权限更新失败。'
}

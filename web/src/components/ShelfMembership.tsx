import { useState } from 'react'
import { api } from '../api'
import type { PersonalShelf } from '../types'

export function ShelfMembership({ bookID }: { bookID: number }) {
  const [shelves, setShelves] = useState<PersonalShelf[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [name, setName] = useState('')

  async function refresh() {
    setLoading(true)
    setError('')
    try {
      setShelves(await api.listShelves(bookID))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '书架加载失败。')
    } finally {
      setLoading(false)
    }
  }
  async function toggle(shelf: PersonalShelf) {
    setBusy(true)
    setError('')
    const previous = shelves
    setShelves((items) =>
      items.map((item) =>
        item.id === shelf.id
          ? { ...item, containsBook: !item.containsBook, bookCount: item.bookCount + (item.containsBook ? -1 : 1) }
          : item,
      ),
    )
    try {
      await api.setShelfBook(shelf.id, bookID, !shelf.containsBook)
      await refresh()
    } catch (reason) {
      setShelves(previous)
      setError(reason instanceof Error ? reason.message : '更新书架失败。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <details
      className="shelf-membership"
      onToggle={(event) => {
        if (event.currentTarget.open) void refresh()
      }}
    >
      <summary>加入书架／阅读清单</summary>
      <div className="shelf-membership-content">
        <p>只保存到你的个人书架，不复制文件。</p>
        {loading && <p role="status">正在加载书架…</p>}
        {error && (
          <p role="alert">
            {error}{' '}
            <button className="quiet" onClick={() => void refresh()}>
              重试
            </button>
          </p>
        )}
        {shelves.map((shelf) => (
          <label key={shelf.id}>
            <input
              type="checkbox"
              checked={shelf.containsBook}
              disabled={busy || loading}
              onChange={() => void toggle(shelf)}
            />
            <span>{shelf.name}</span>
            <small>{shelf.bookCount} 本</small>
          </label>
        ))}
        <form
          className="personal-search"
          onSubmit={(event) => {
            event.preventDefault()
            setBusy(true)
            setError('')
            void api
              .saveShelf(name.trim(), '')
              .then(async (shelf) => {
                setName('')
                setShelves((items) => [...items, { ...shelf, containsBook: false, bookCount: 0 }])
                try {
                  await api.setShelfBook(shelf.id, bookID, true)
                } catch {
                  throw new Error('书架已创建，但加入书籍失败。请勾选新书架重试，无需重复创建。')
                }
              })
              .then(async () => {
                setName('')
                await refresh()
              })
              .catch((reason) => setError(reason instanceof Error ? reason.message : '创建书架失败。'))
              .finally(() => setBusy(false))
          }}
        >
          <input
            aria-label="新书架名称"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            placeholder="新建书架并加入这本书"
          />
          <button className="secondary" disabled={busy || loading || !name.trim()}>
            创建并加入
          </button>
        </form>
      </div>
    </details>
  )
}

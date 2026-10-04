import { type FormEvent, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { BookFile, CatalogPage } from '../types'

interface Props {
  shelfID: number
  revision: number
  disabled: boolean
  onAdd: (books: BookFile[]) => Promise<{ addedBookIds: number[]; alreadyPresentBookIds: number[] } | undefined>
}

const selectionLimit = 100

export function ShelfBookPicker({ shelfID, revision, disabled, onAdd }: Props) {
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState<{ q: string; page: number } | null>(null)
  const [result, setResult] = useState<CatalogPage | null>(null)
  const [memberships, setMemberships] = useState<number[]>([])
  const [selected, setSelected] = useState<Map<number, BookFile>>(new Map())
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const [selectionError, setSelectionError] = useState('')
  const [retry, setRetry] = useState(0)
  const addLock = useRef(false)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!query) return
    let disposed = false
    setLoading(true)
    setError('')
    void (async () => {
      const next = await api.listBooks({ ...query, pageSize: 12 })
      if (disposed) return
      const present = await api.shelfMemberships(shelfID, next.items.map((book) => book.id))
      if (disposed) return
      setResult(next)
      setMemberships(present)
      setSelected((current) => {
        const remaining = new Map(current)
        for (const id of present) remaining.delete(id)
        return remaining
      })
      setLoading(false)
      if (next.page > Math.max(1, next.totalPages)) setQuery({ ...query, page: Math.max(1, next.totalPages) })
    })().catch((reason) => {
      if (!disposed) {
        setLoading(false)
        setError(reason instanceof Error ? reason.message : '书籍搜索失败，请重试。')
      }
    })
    return () => { disposed = true }
  }, [shelfID, query, revision, retry])

  function search(event: FormEvent) {
    event.preventDefault()
    if (disabled || addLock.current) return
    setSelected(new Map())
    setSelectionError('')
    setLoading(true)
    setQuery({ q: draft.trim(), page: 1 })
  }

  function changePage(page: number) {
    if (!query || disabled || addLock.current) return
    setLoading(true)
    setQuery({ ...query, page })
  }

  function toggle(book: BookFile, included: boolean) {
    setSelectionError('')
    setSelected((current) => {
      const next = new Map(current)
      if (included && next.size < selectionLimit) next.set(book.id, book)
      else if (!included) next.delete(book.id)
      return next
    })
  }

  function selectPage() {
    const available = result?.items.filter((book) => !memberships.includes(book.id)) ?? []
    const next = new Map(selected)
    for (const book of available) next.set(book.id, book)
    if (next.size > selectionLimit) {
      setSelectionError('一次最多勾选 100 本，请先添加已选书籍。')
      return
    }
    setSelectionError('')
    setSelected(next)
  }

  async function add(books: BookFile[]) {
    if (disabled || addLock.current || books.length === 0) return
    addLock.current = true
    setAdding(true)
    try {
      const response = await onAdd(books)
      if (!response || !mounted.current) return
      const completed = [...response.addedBookIds, ...response.alreadyPresentBookIds]
      setMemberships((current) => [...new Set([...current, ...completed])])
      setSelected((current) => {
        const next = new Map(current)
        for (const id of completed) next.delete(id)
        return next
      })
      setSelectionError('')
    } finally {
      addLock.current = false
      if (mounted.current) setAdding(false)
    }
  }

  const locked = disabled || adding
  const available = result?.items.filter((book) => !memberships.includes(book.id)) ?? []

  return (
    <details className="shelf-add-books">
      <summary>＋ 从书库添加书籍</summary>
      <form className="personal-search" onSubmit={search}>
        <input aria-label="搜索要添加的书籍" value={draft} disabled={locked} onChange={(event) => setDraft(event.target.value)} maxLength={200} placeholder="书名或作者…留空浏览书库" />
        <button className="secondary" disabled={locked}>查找书籍</button>
      </form>
      <div className="shelf-selection-bar">
        <span role="status" aria-live="polite">已勾选 {selected.size} 本{selected.size > 0 ? '（含其他页）' : ''}</span>
        <div className="personal-actions">
          <button className="quiet" disabled={locked || loading || !!error || available.length === 0} onClick={selectPage}>勾选本页</button>
          <button className="quiet" disabled={locked || selected.size === 0} onClick={() => { setSelected(new Map()); setSelectionError('') }}>清空勾选</button>
          <button className="primary" disabled={locked || loading || !!error || selected.size === 0} onClick={() => void add([...selected.values()])}>{adding ? '正在添加…' : `添加已选（${selected.size}）`}</button>
        </div>
      </div>
      {selected.size > 0 && <details className="shelf-selected-books">
        <summary>查看已选书籍（{selected.size}）</summary>
        <ul>
          {[...selected.values()].map((book) => <li key={book.id}>
            <span>{book.title}</span>
            <button className="quiet" disabled={locked} aria-label={`取消勾选《${book.title}》`} onClick={() => toggle(book, false)}>取消勾选</button>
          </li>)}
        </ul>
      </details>}
      {selectionError && <p className="notice error" role="alert">{selectionError}</p>}
      {error && <div className="notice error" role="alert">{error} <button className="quiet" disabled={locked} onClick={() => { setLoading(true); setRetry((value) => value + 1) }}>重试搜索</button></div>}
      {loading && <p role="status">正在查找书籍并核对书架…</p>}
      {!loading && !error && result && <>
        <p className="shelf-search-summary">找到 {result.total} 本书 · 每页 {result.pageSize} 本 · 最多勾选 100 本，重新搜索会清空勾选</p>
        {result.items.length === 0 && <p>没有找到符合条件的书籍。</p>}
        <div className="shelf-candidates">
          {result.items.map((book) => {
            const present = memberships.includes(book.id)
            return <div key={book.id}>
              <label className="shelf-candidate-choice">
                <input type="checkbox" aria-label={`勾选《${book.title}》`} checked={selected.has(book.id)} disabled={locked || present || (selected.size >= selectionLimit && !selected.has(book.id))} onChange={(event) => toggle(book, event.target.checked)} />
                <span>{book.title}<small>{book.authors.join('、') || '未知作者'}</small></span>
              </label>
              <button className="secondary" disabled={locked || present} onClick={() => void add([book])}>{present ? '已在书架' : '添加'}</button>
            </div>
          })}
        </div>
        {result.totalPages > 1 && <nav className="personal-pagination" aria-label="添加书籍搜索分页">
          <button className="secondary" disabled={locked || result.page <= 1} onClick={() => changePage(result.page - 1)}>上一页</button>
          <span>{result.page} / {result.totalPages}</span>
          <button className="secondary" disabled={locked || result.page >= result.totalPages} onClick={() => changePage(result.page + 1)}>下一页</button>
        </nav>}
      </>}
    </details>
  )
}

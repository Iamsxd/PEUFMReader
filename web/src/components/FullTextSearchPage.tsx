import { type FormEvent, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { BookFile, ReadingMark, TextIndexStatus, TextSearchHit, TextSearchPage } from '../types'

interface Props { isAdmin: boolean; onOpenBook: (book: BookFile, mark?: ReadingMark) => void }
export function FullTextSearchPage({ isAdmin, onOpenBook }: Props) {
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<TextSearchPage | null>(null)
  const [status, setStatus] = useState<TextIndexStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [indexing, setIndexing] = useState(false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const runRef = useRef(0)
  useEffect(() => {
    let disposed = false
    void api.textIndexStatus().then(value => { if (!disposed) setStatus(value) }).catch(() => {})
    return () => { disposed = true; runRef.current += 1 }
  }, [])
  useEffect(() => {
    if (!submitted) return
    const run = ++runRef.current
    setBusy(true); setError(''); setResult(null)
    void api.searchText(submitted, page).then(value => { if (run === runRef.current) setResult(value) })
      .catch(reason => { if (run === runRef.current) setError(reason instanceof Error ? reason.message : '检索失败，请重试。') })
      .finally(() => { if (run === runRef.current) setBusy(false) })
    return () => { runRef.current += 1 }
  }, [submitted, page])
  function search(event: FormEvent) { event.preventDefault(); setPage(1); setSubmitted(query.trim()) }
  async function open(hit: TextSearchHit) {
    if (opening) return
    setOpening(true); setError('')
    try {
      const detail = await api.getBookDetail(hit.bookFileId)
      if (!Object.keys(hit.position).length) { onOpenBook(detail.book); return }
      const at = new Date().toISOString()
      // A transient navigation location, never written as a saved annotation.
      onOpenBook(detail.book, { id: 0, bookFileId: hit.bookFileId, kind: 'bookmark', label: hit.label, position: hit.position, body: '', quote: '', color: '', overallProgress: 0, createdAt: at, updatedAt: at })
    } catch (reason) { setError(reason instanceof Error ? reason.message : '书籍当前不可访问。') }
    finally { setOpening(false) }
  }
  return <div className="personal-workspace full-text-page">
    <section className="page-heading"><div><p className="eyebrow">从书页中寻找答案</p><h1>正文检索</h1><p className="muted">搜索你有权阅读的 EPUB 和已提取文本的 PDF，返回原文章节或页码。不会自动执行 OCR。</p></div></section>
    <section className="text-index-status"><p>{status ? `${status.indexedBooks} / ${status.eligibleBooks} 本可索引书籍 · ${status.passageCount} 个正文片段` : '正在读取索引状态…'}</p><div className="personal-actions"><button className="quiet" onClick={() => void api.textIndexStatus().then(setStatus).catch(() => setError('索引状态读取失败。'))}>刷新索引状态</button>{isAdmin && <button className="secondary" disabled={indexing} onClick={() => {
      setIndexing(true); setError('')
      void api.buildTextIndex().then(value => setFeedback(`${value.queued} 本书已加入本地索引任务。可在管理后台查看进度；完成后刷新索引状态。`)).catch(reason => setError(reason instanceof Error ? reason.message : '索引任务提交失败。')).finally(() => setIndexing(false))
    }}>补建／更新索引</button>}</div><small>索引只保存在 NAS 数据库；扫描 PDF 仅检索已有提取内容。AI 问答尚未启用，不向外部服务发送正文。</small></section>
    <form className="personal-search" onSubmit={search}><input aria-label="正文关键词" placeholder="输入正文中的词句（至少 2 字）" value={query} onChange={event => setQuery(event.target.value)} minLength={2} maxLength={200} required /><button className="primary" disabled={busy || query.trim().length < 2}>检索正文</button></form>
    {feedback && <p role="status">{feedback}</p>}{error && <div className="notice error" role="alert">{error}</div>}{busy && <p role="status">正在检索正文…</p>}
    {result && <><p className="muted">“{submitted}” · 第 {result.page} 页{result.hasMore ? '，还有更多匹配' : ''}</p>{result.items.length === 0 && <section className="empty-state"><h2>没有找到匹配正文</h2><p>尝试更短的关键词，或让管理员为现有书籍补建索引。未索引书籍与扫描图片不在检索范围内。</p></section>}<div className="text-search-results">{result.items.map((hit, index) => <article key={`${hit.bookFileId}:${index}`}><header><h2>{hit.bookTitle}</h2><span>{hit.bookFormat.toUpperCase()} · {hit.label}</span></header><blockquote>{hit.excerpt}</blockquote><small>{hit.coverage}</small><button className="secondary" disabled={opening} onClick={() => void open(hit)}>{Object.keys(hit.position).length ? '打开出处' : '打开书籍（页码不可用）'}</button></article>)}</div><nav className="personal-pagination" aria-label="正文检索分页"><button disabled={busy || page <= 1} onClick={() => setPage(current => current - 1)}>上一页</button><span>第 {page} 页</span><button disabled={busy || !result.hasMore} onClick={() => setPage(current => current + 1)}>下一页</button></nav></>}
  </div>
}

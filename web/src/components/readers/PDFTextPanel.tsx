import { useEffect, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

export function PDFTextPanel({ document, pageNumber, onPageChange, onClose }: { document: PDFDocumentProxy; pageNumber: number; onPageChange: (page: number) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [fontSize, setFontSize] = useState(20)
  useEffect(() => {
    let disposed = false
    setLoading(true); setText(''); setError('')
    void document.getPage(pageNumber).then(page => page.getTextContent()).then(content => {
      if (disposed) return
      setText(content.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim())
    }).catch(() => { if (!disposed) setError('本页文字提取失败，请返回原版阅读。') }).finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [document, pageNumber])
  return <aside className="reader-side-panel pdf-text-panel" aria-label="PDF 文字阅读"><header><strong>文字阅读 · 第 {pageNumber} 页</strong><button onClick={onClose} aria-label="关闭侧栏">×</button></header>
    <p className="reader-text-note">按文本层顺序重排本页。图表和多栏顺序可能不完整，批注定位请返回原版；扫描页不会自动启动 OCR。</p>
    <label>文字字号 <input aria-label="PDF 文字字号" type="range" min={16} max={32} value={fontSize} onChange={event => setFontSize(Number(event.target.value))} /></label>
    <div className="pdf-text-content" style={{ fontSize }} key={pageNumber}>{loading ? <p role="status">正在读取本页文字…</p> : error ? <p role="alert">{error}</p> : text ? <p>{text}</p> : <p>本页没有可提取的文字，请使用原版阅读。</p>}</div>
    <footer><button disabled={pageNumber <= 1} onClick={() => onPageChange(pageNumber - 1)}>上一页文字</button><span>{pageNumber} / {document.numPages}</span><button disabled={pageNumber >= document.numPages} onClick={() => onPageChange(pageNumber + 1)}>下一页文字</button></footer>
  </aside>
}

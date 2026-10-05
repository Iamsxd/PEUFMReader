import { chunkSpeechText, extractReadableDocumentText, normalizeSpeechText } from './speech'

const blocksSelector = 'p,li,blockquote,h1,h2,h3,h4,h5,h6,dt,dd,pre'
export function buildEPUBSpeechChunks(document: Document, toCFI: (range: Range) => string, visibleRange?: Range): Array<{ text: string; anchor?: string }> {
  const blocks = Array.from(document.querySelectorAll<HTMLElement>(blocksSelector)).filter(element => !element.querySelector(blocksSelector) && !element.closest('nav,script,style,noscript'))
  const startNode = visibleRange?.startContainer
  const startElement = startNode?.nodeType === 1 ? startNode as Element : startNode?.parentElement
  const paragraph = startElement?.closest(blocksSelector)
  const first = paragraph ? Math.max(0, blocks.findIndex(element => element === paragraph || element.contains(paragraph))) : 0
  const chunks = blocks.slice(first).flatMap(element => {
    const text = normalizeSpeechText(element.textContent ?? '')
    if (!text) return []
    const range = document.createRange()
    range.selectNodeContents(element)
    let anchor: string | undefined
    try { anchor = toCFI(range) } catch { /* Text remains readable without a CFI. */ }
    return chunkSpeechText(text).map(chunk => ({ text: chunk, anchor }))
  })
  return chunks.length ? chunks : chunkSpeechText(extractReadableDocumentText(document)).map(text => ({ text }))
}

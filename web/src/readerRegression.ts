import type { BookFile } from './types'

export type BrowserReaderFormat = 'pdf' | 'epub'

export interface ReaderCorpusSelection {
  explicitIDs: number[]
  maxPerFormat: number
}

const browserReaderFormats: BrowserReaderFormat[] = ['pdf', 'epub']

export function parseReaderCorpusIDs(value: string | undefined): number[] {
  const seen = new Set<number>()
  const ids: number[] = []
  for (const part of (value ?? '').split(',')) {
    const id = Number(part.trim())
    if (!Number.isSafeInteger(id) || id < 1 || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

export function selectReaderCorpus(items: BookFile[], selection: ReaderCorpusSelection): BookFile[] {
  const readable = items.filter((item): item is BookFile & { format: BrowserReaderFormat } =>
    browserReaderFormats.includes(item.format as BrowserReaderFormat),
  )
  if (selection.explicitIDs.length > 0) {
    const byID = new Map(readable.map((item) => [item.id, item]))
    return selection.explicitIDs.flatMap((id) => byID.get(id) ?? [])
  }

  const maxPerFormat = Math.max(1, Math.floor(selection.maxPerFormat))
  return browserReaderFormats.flatMap((format) => readable.filter((item) => item.format === format).slice(0, maxPerFormat))
}

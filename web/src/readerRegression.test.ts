import { describe, expect, it } from 'vitest'
import { parseReaderCorpusIDs, selectReaderCorpus } from './readerRegression'
import type { BookFile } from './types'

function book(id: number, format: BookFile['format']): BookFile {
  return {
    id, workId: id, editionId: id, title: `${format}-${id}`, authors: [], categories: [], reviewRequired: false,
    textAvailable: false, originalFilename: `${format}-${id}.${format}`, format,
    mimeType: 'application/octet-stream', sizeBytes: 100, createdAt: '2026-01-01T00:00:00Z',
  }
}

describe('reader regression corpus selection', () => {
  it('uses only explicit PDF and EPUB IDs when a corpus selection is provided', () => {
    const items = [book(1, 'pdf'), book(2, 'epub'), book(3, 'pdf'), book(4, 'mobi')]
    expect(selectReaderCorpus(items, { explicitIDs: parseReaderCorpusIDs('3, 2, 999'), maxPerFormat: 3 }))
      .toEqual([book(3, 'pdf'), book(2, 'epub')])
  })

  it('selects a bounded representative corpus for each browser-readable format', () => {
    const items = [book(1, 'pdf'), book(2, 'pdf'), book(3, 'pdf'), book(4, 'epub'), book(5, 'epub'), book(6, 'azw3')]
    expect(selectReaderCorpus(items, { explicitIDs: [], maxPerFormat: 2 }).map((item) => item.id))
      .toEqual([1, 2, 4, 5])
  })

  it('ignores invalid corpus IDs instead of selecting an arbitrary book', () => {
    expect(parseReaderCorpusIDs(' 3, no, 0, -4, 3, 6.5 ')).toEqual([3])
  })
})

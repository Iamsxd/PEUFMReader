import { describe, expect, it } from 'vitest'
import { createReaderNavigationHistory, MAX_READER_NAVIGATION_ENTRIES } from './readerNavigation'

describe('reader explicit jump history', () => {
  it('starts empty and cannot navigate without a recorded jump', () => {
    const history = createReaderNavigationHistory<string>()
    expect(history.canBack).toBe(false)
    expect(history.canForward).toBe(false)
    expect(history.peekBack()).toBeUndefined()
    expect(history.peekForward()).toBeUndefined()
    expect(history.goBack('A')).toBeUndefined()
    expect(history.goForward('A')).toBeUndefined()
  })

  it('returns from A → B → C and moves forward through the same origins', () => {
    const history = createReaderNavigationHistory<string>()
    history.record('A', 'B')
    history.record('B', 'C')
    expect(history.goBack('C')).toBe('B')
    expect(history.goBack('B')).toBe('A')
    expect(history.canBack).toBe(false)
    expect(history.canForward).toBe(true)
    expect(history.goForward('A')).toBe('B')
    expect(history.goForward('B')).toBe('C')
    expect(history.canForward).toBe(false)
  })

  it('uses the actual current reading position for forward after ordinary paging', () => {
    const history = createReaderNavigationHistory<string>()
    history.record('chapter-one-start', 'chapter-three-start')
    // Reading within chapter three does not record another explicit jump.
    expect(history.goBack('chapter-three-page-five')).toBe('chapter-one-start')
    expect(history.goForward('chapter-one-page-two')).toBe('chapter-three-page-five')
    expect(history.goBack('chapter-three-page-six')).toBe('chapter-one-page-two')
  })

  it('discards forward history when a new explicit jump follows back', () => {
    const history = createReaderNavigationHistory<string>()
    history.record('A', 'B')
    history.record('B', 'C')
    expect(history.goBack('C')).toBe('B')
    expect(history.record('B', 'D')).toBe(true)
    expect(history.canForward).toBe(false)
    expect(history.goBack('D')).toBe('B')
    expect(history.goBack('B')).toBe('A')
  })

  it('previews targets without changing either stack until display succeeds', () => {
    const history = createReaderNavigationHistory<string>()
    history.record('A', 'B')
    history.record('B', 'C')
    expect(history.peekBack('C')).toBe('B')
    expect(history.peekBack('C')).toBe('B')
    expect(history.canForward).toBe(false)
    // A failed asynchronous display does not call goBack.
    expect(history.goBack('C')).toBe('B')
    expect(history.peekForward('B')).toBe('C')
    expect(history.peekForward('B')).toBe('C')
    expect(history.peekBack('B')).toBe('A')
    expect(history.goForward('B')).toBe('C')
  })

  it('skips targets identical to the current position after ordinary paging', () => {
    const history = createReaderNavigationHistory<string>()
    history.record('A', 'B')
    history.record('B', 'C')
    expect(history.peekBack('B')).toBe('A')
    expect(history.goBack('B')).toBe('A')
    expect(history.canBack).toBe(false)
    expect(history.goForward('A')).toBe('B')
  })

  it('does not duplicate consecutive origins or add no-op jumps', () => {
    const history = createReaderNavigationHistory<string>()
    expect(history.record('A', 'B')).toBe(true)
    expect(history.record('A', 'C')).toBe(false)
    expect(history.record('C', 'C')).toBe(false)
    expect(history.goBack('C')).toBe('A')
    expect(history.goBack('A')).toBeUndefined()
  })

  it('preserves forward history after a no-op or invalid new jump', () => {
    const history = createReaderNavigationHistory<string>()
    history.record('A', 'B')
    expect(history.goBack('B')).toBe('A')
    expect(history.record('A', 'A')).toBe(false)
    expect(history.record('', 'C')).toBe(false)
    expect(history.record('A', '  ')).toBe(false)
    expect(history.peekForward('A')).toBe('B')
  })

  it('rejects empty, null, undefined and non-finite primitive positions', () => {
    const history = createReaderNavigationHistory<string | number | null | undefined>()
    for (const invalid of ['', '   ', null, undefined, NaN, Infinity, -Infinity]) {
      expect(history.record(invalid, 'B')).toBe(false)
    }
    expect(history.canBack).toBe(false)
    history.record('A', 'B')
    expect(history.goBack(null)).toBeUndefined()
    expect(history.peekBack()).toBe('A')
    expect(history.canForward).toBe(false)
  })

  it('validates structured PDF positions and compares their page and offset', () => {
    type PDFPosition = { page: number, yRatio: number }
    const history = createReaderNavigationHistory<PDFPosition>({
      equals: (left, right) => left.page === right.page && left.yRatio === right.yRatio,
      isValid: ({ page, yRatio }) => Number.isInteger(page) && page > 0
        && Number.isFinite(yRatio) && yRatio >= 0 && yRatio <= 1,
    })
    const source = { page: 2, yRatio: 0.4 }
    expect(history.record(source, { page: 2, yRatio: 0.4 })).toBe(false)
    expect(history.record(source, { page: 8, yRatio: 0.75 })).toBe(true)
    expect(history.record({ page: 0, yRatio: 0 }, { page: 1, yRatio: 0 })).toBe(false)
    expect(history.record(source, { page: 8, yRatio: NaN })).toBe(false)
    expect(history.goBack({ page: 8, yRatio: 0.9 })).toEqual(source)
    expect(history.goForward({ page: 2, yRatio: 0.55 })).toEqual({ page: 8, yRatio: 0.9 })
  })

  it('keeps only the latest 50 jump origins and bounds both navigation directions', () => {
    const history = createReaderNavigationHistory<number>()
    const total = MAX_READER_NAVIGATION_ENTRIES + 7
    for (let index = 0; index < total; index += 1) history.record(index, index + 1)
    let current = total
    for (let index = total - 1; index >= 7; index -= 1) {
      expect(history.goBack(current)).toBe(index)
      current = index
    }
    expect(history.canBack).toBe(false)
    expect(history.goBack(current)).toBeUndefined()
    for (let index = 8; index <= total; index += 1) {
      expect(history.goForward(current)).toBe(index)
      current = index
    }
    expect(history.canForward).toBe(false)
  })

  it('supports smaller limits but clamps histories to the fixed maximum', () => {
    const history = createReaderNavigationHistory<number>({ maxEntries: 2 })
    history.record(0, 1)
    history.record(1, 2)
    history.record(2, 3)
    expect(history.goBack(3)).toBe(2)
    expect(history.goBack(2)).toBe(1)
    expect(history.canBack).toBe(false)

    const capped = createReaderNavigationHistory<number>({ maxEntries: 1000 })
    for (let index = 0; index < 51; index += 1) capped.record(index, index + 1)
    let current = 51
    for (let index = 50; index >= 1; index -= 1) current = capped.goBack(current)!
    expect(capped.goBack(current)).toBeUndefined()
  })

  it('clears both directions for a new book and does not share state across readers', () => {
    const history = createReaderNavigationHistory<string>()
    const other = createReaderNavigationHistory<string>()
    history.record('A', 'B')
    history.record('B', 'C')
    history.goBack('C')
    expect(other.canBack).toBe(false)
    expect(other.canForward).toBe(false)
    history.clear()
    expect(history.canBack).toBe(false)
    expect(history.canForward).toBe(false)
    expect(history.peekBack()).toBeUndefined()
    expect(history.peekForward()).toBeUndefined()
    expect(history.record('new-book-A', 'new-book-B')).toBe(true)
    expect(history.goBack('new-book-B')).toBe('new-book-A')
  })
})

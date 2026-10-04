import { describe, expect, it } from 'vitest'
import { meaningfulShelfDrop, type ShelfDrop } from './shelfOrder'

describe('meaningful shelf drops', () => {
  it.each([
    { bookId: 3, targetBookId: 1, placement: 'before' },
    { bookId: 1, targetBookId: 3, placement: 'after' },
    { bookId: 2, targetBookId: 1, placement: 'before' },
    { bookId: 1, targetBookId: 2, placement: 'after' },
    { bookId: 3, targetBookId: 2, placement: 'before' },
    { bookId: 2, targetBookId: 3, placement: 'after' },
  ] satisfies ShelfDrop[])('allows a visible-order change: $bookId $placement $targetBookId', (drop) => {
    const ids = [1, 2, 3]
    const originalDrop = { ...drop }
    expect(meaningfulShelfDrop(ids, drop)).toBe(true)
    expect(ids).toEqual([1, 2, 3])
    expect(drop).toEqual(originalDrop)
  })

  it.each([
    { bookId: 1, targetBookId: 2, placement: 'before' },
    { bookId: 2, targetBookId: 1, placement: 'after' },
    { bookId: 2, targetBookId: 3, placement: 'before' },
    { bookId: 3, targetBookId: 2, placement: 'after' },
    { bookId: 2, targetBookId: 2, placement: 'before' },
    { bookId: 2, targetBookId: 2, placement: 'after' },
  ] satisfies ShelfDrop[])('rejects an unchanged order: $bookId $placement $targetBookId', (drop) => {
    expect(meaningfulShelfDrop([1, 2, 3], drop)).toBe(false)
  })

  it('does not invent destinations outside the current shelf page', () => {
    expect(meaningfulShelfDrop([11, 22], { bookId: 11, targetBookId: 33, placement: 'after' })).toBe(false)
    expect(meaningfulShelfDrop([11, 22], { bookId: 33, targetBookId: 11, placement: 'before' })).toBe(false)
    expect(meaningfulShelfDrop([], { bookId: 11, targetBookId: 22, placement: 'after' })).toBe(false)
    expect(meaningfulShelfDrop([11], { bookId: 11, targetBookId: 11, placement: 'after' })).toBe(false)
  })

  it('uses list order, not numeric IDs or assumptions about contiguous positions', () => {
    const ids = Object.freeze([980007, 31, 710004])
    expect(meaningfulShelfDrop([...ids], { bookId: 31, targetBookId: 980007, placement: 'after' })).toBe(false)
    expect(meaningfulShelfDrop([...ids], { bookId: 710004, targetBookId: 980007, placement: 'before' })).toBe(true)
    expect(ids).toEqual([980007, 31, 710004])
  })
})

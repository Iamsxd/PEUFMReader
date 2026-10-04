export interface ShelfDrop {
  bookId: number
  targetBookId: number
  placement: 'before' | 'after'
}

// Ignore drops that preserve the current visible order, including dropping on oneself.
export function meaningfulShelfDrop(ids: number[], drop: ShelfDrop): boolean {
  const from = ids.indexOf(drop.bookId)
  const target = ids.indexOf(drop.targetBookId)
  if (from < 0 || target < 0 || from === target) return false
  const next = ids.filter((id) => id !== drop.bookId)
  next.splice(next.indexOf(drop.targetBookId) + (drop.placement === 'after' ? 1 : 0), 0, drop.bookId)
  return next.some((id, index) => id !== ids[index])
}

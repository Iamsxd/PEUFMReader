import type { BookFormat } from './types'

export interface ReadingMarkLocation {
  position: Record<string, unknown>
  overallProgress: number
  label: string
}

interface EPUBReadingPosition {
  cfi: string
  href?: string
  chapterIndex?: number
  progression: number
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export function createPDFReadingMarkLocation(pageNumber: number, pageCount: number): ReadingMarkLocation {
  const safePageCount = Math.max(1, Math.round(Number.isFinite(pageCount) ? pageCount : 1))
  const safePage = Math.min(safePageCount, Math.max(1, Math.round(Number.isFinite(pageNumber) ? pageNumber : 1)))
  return {
    position: { pageIndex: safePage - 1, yRatio: 0 },
    overallProgress: safePage / safePageCount,
    label: `第 ${safePage} 页`,
  }
}

export function createEPUBReadingMarkLocation(position: EPUBReadingPosition): ReadingMarkLocation {
  const progression = clampProgress(position.progression)
  return {
    position: {
      cfi: position.cfi,
      href: position.href ?? '',
      chapterIndex: position.chapterIndex,
      progression,
    },
    overallProgress: progression,
    label: `阅读进度 ${Math.round(progression * 100)}%`,
  }
}

export function getReadingMarkNavigationTarget(format: BookFormat, position: Record<string, unknown>): string | number | null {
  if (format === 'pdf') {
    const pageIndex = position.pageIndex
    return typeof pageIndex === 'number' && Number.isInteger(pageIndex) && pageIndex >= 0 ? pageIndex + 1 : null
  }
  if (typeof position.cfi === 'string' && position.cfi.trim()) return position.cfi
  if (typeof position.href === 'string' && position.href.trim()) return position.href
  if (typeof position.chapterIndex === 'number' && Number.isInteger(position.chapterIndex) && position.chapterIndex >= 0) return position.chapterIndex
  return null
}

export function upsertReadingMark<T extends { id: number; overallProgress: number }>(marks: T[], next: T): T[] {
  return [...marks.filter((mark) => mark.id !== next.id), next]
    .sort((left, right) => left.overallProgress - right.overallProgress || left.id - right.id)
}

export function removeReadingMark<T extends { id: number }>(marks: T[], markID: number): T[] {
  return marks.filter((mark) => mark.id !== markID)
}

import { describe, expect, it } from 'vitest'
import {
  createEPUBReadingMarkLocation,
  createPDFHighlightLocation,
  createPDFReadingMarkLocation,
  getReadingMarkNavigationTarget,
  removeReadingMark,
  upsertReadingMark,
} from './readingMarks'

describe('reading mark position model', () => {
  it('stores a PDF page as a stable zero-based position', () => {
    expect(createPDFReadingMarkLocation(5, 100)).toEqual({
      position: { pageIndex: 4, yRatio: 0 },
      overallProgress: 0.05,
      label: '第 5 页',
    })
  })

  it('stores an EPUB location with resilient restore fallbacks', () => {
    expect(createEPUBReadingMarkLocation({
      cfi: 'epubcfi(/6/8!/4/2)',
      href: 'chapter-3.xhtml',
      chapterIndex: 2,
      progression: 0.375,
    })).toEqual({
      position: {
        cfi: 'epubcfi(/6/8!/4/2)',
        href: 'chapter-3.xhtml',
        chapterIndex: 2,
        progression: 0.375,
      },
      overallProgress: 0.375,
      label: '阅读进度 38%',
    })
  })

  it('stores PDF selection rectangles as zoom-independent page ratios', () => {
    expect(createPDFHighlightLocation(5, 100,
      { left: 100, top: 200, width: 500, height: 800 },
      [
        { left: 150, top: 280, width: 200, height: 24 },
        { left: 150, top: 312, width: 300, height: 24 },
      ],
    )).toEqual({
      position: {
        pageIndex: 4,
        rects: [
          { x: 0.1, y: 0.1, width: 0.4, height: 0.03 },
          { x: 0.1, y: 0.14, width: 0.6, height: 0.03 },
        ],
      },
      overallProgress: 0.05,
      label: '第 5 页高亮',
    })
  })

  it('chooses navigation targets by format and rejects malformed positions', () => {
    expect(getReadingMarkNavigationTarget('pdf', { pageIndex: 9 })).toBe(10)
    expect(getReadingMarkNavigationTarget('epub', { cfi: 'epubcfi(/6/4)', href: 'chapter.xhtml' })).toBe('epubcfi(/6/4)')
    expect(getReadingMarkNavigationTarget('epub', { href: 'chapter.xhtml', chapterIndex: 3 })).toBe('chapter.xhtml')
    expect(getReadingMarkNavigationTarget('azw3', { chapterIndex: 3 })).toBe(3)
    expect(getReadingMarkNavigationTarget('pdf', { pageIndex: -1 })).toBeNull()
  })

  it('keeps the local mark list sorted and removes deleted entries', () => {
    const early = { id: 1, overallProgress: 0.1 }
    const late = { id: 2, overallProgress: 0.8 }
    const moved = { id: 1, overallProgress: 0.9 }

    expect(upsertReadingMark([late, early], moved)).toEqual([late, moved])
    expect(removeReadingMark([late, moved], late.id)).toEqual([moved])
  })
})

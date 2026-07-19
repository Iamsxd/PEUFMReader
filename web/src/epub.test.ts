import ePub from 'epubjs'
import { describe, expect, it, vi } from 'vitest'
import {
  clampEPUBFontSize,
  flattenEPUBNavigation,
  getEPUBRestoreTargets,
  normalizeEPUBWheelDelta,
  parseEPUBPreferences,
  resolveEPUBProgress,
} from './epub'

describe('EPUB reading preferences', () => {
  it('opens extensionless content API routes as EPUB archives', async () => {
    const request = vi.fn().mockRejectedValue(new Error('stop after request classification'))
    const book = ePub('/api/v1/book-files/2/content', {
      openAs: 'epub',
      requestCredentials: true,
      requestMethod: request,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(request).toHaveBeenCalledWith('/api/v1/book-files/2/content', 'binary', true, undefined)
    book.destroy()
  })

  it('uses safe defaults for missing or malformed preferences', () => {
    expect(parseEPUBPreferences(null)).toEqual({ flow: 'paged', layout: 'single', fontSize: 100, theme: 'paper' })
    expect(parseEPUBPreferences('{')).toEqual({ flow: 'paged', layout: 'single', fontSize: 100, theme: 'paper' })
  })

  it('restores supported reading options and rejects unknown values', () => {
    expect(parseEPUBPreferences(JSON.stringify({ flow: 'continuous', layout: 'spread', fontSize: 125, theme: 'night' })))
      .toEqual({ flow: 'continuous', layout: 'spread', fontSize: 125, theme: 'night' })
    expect(parseEPUBPreferences(JSON.stringify({ flow: 'unknown', layout: 'grid', fontSize: 999, theme: 'blue' })))
      .toEqual({ flow: 'paged', layout: 'single', fontSize: 180, theme: 'paper' })
  })

  it('clamps font sizes to a readable range', () => {
    expect(clampEPUBFontSize(45)).toBe(70)
    expect(clampEPUBFontSize(121.6)).toBe(122)
    expect(clampEPUBFontSize(240)).toBe(180)
  })

  it('normalizes wheel deltas from pixels, lines, and pages', () => {
    expect(normalizeEPUBWheelDelta(4, 30, 0, 800)).toBe(30)
    expect(normalizeEPUBWheelDelta(-5, -3, 1, 800)).toBe(-80)
    expect(normalizeEPUBWheelDelta(0, 1, 2, 900)).toBe(900)
  })

  it('keeps progress stable while locations are generated in the background', () => {
    expect(resolveEPUBProgress(undefined, undefined, 0.42)).toBe(0.42)
    expect(resolveEPUBProgress(undefined, 0.25, 0.42)).toBe(0.25)
    expect(resolveEPUBProgress(0.7, 0.25, 0.42)).toBe(0.7)
    expect(resolveEPUBProgress(-1, Number.NaN, 0.42)).toBe(0.42)
  })

  it('flattens nested navigation without losing chapter depth', () => {
    expect(flattenEPUBNavigation([{ href: 'one.xhtml', label: ' 第一章 ', subitems: [{ href: 'one-1.xhtml', label: '第一节' }] }]))
      .toEqual([
        { id: '0-0-one.xhtml', href: 'one.xhtml', label: '第一章', depth: 0 },
        { id: '1-0-one-1.xhtml', href: 'one-1.xhtml', label: '第一节', depth: 1 },
      ])
  })

  it('builds EPUB restore targets from the most precise to the broadest anchor', () => {
    expect(getEPUBRestoreTargets({ cfi: 'epubcfi(/6/2)', href: 'chapter.xhtml', chapterIndex: 4 }))
      .toEqual(['epubcfi(/6/2)', 'chapter.xhtml', 4])
    expect(getEPUBRestoreTargets({ cfi: '', href: 'chapter.xhtml', chapterIndex: -1 })).toEqual(['chapter.xhtml'])
  })
})

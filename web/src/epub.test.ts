import ePub from 'epubjs'
import { describe, expect, it, vi } from 'vitest'
import {
  clampEPUBFontSize,
  DEFAULT_EPUB_TYPOGRAPHY,
  EPUB_PREFERENCES_KEY,
  EPUB_TYPOGRAPHY_KEY,
  findCurrentEPUBTOCEntry,
  flattenEPUBNavigation,
  getEPUBTypographyRules,
  getEPUBRestoreTargets,
  normalizeEPUBWheelDelta,
  parseEPUBPreferences,
  parseEPUBTypography,
  resolveEPUBOpenAs,
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

  it('opens a cached EPUB archive as binary instead of a URL', () => {
    expect(resolveEPUBOpenAs()).toBe('epub')
    expect(resolveEPUBOpenAs(new ArrayBuffer(1))).toBe('binary')
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

  it('stores typography separately without changing the original preference shape', () => {
    expect(EPUB_TYPOGRAPHY_KEY).not.toBe(EPUB_PREFERENCES_KEY)
    expect(parseEPUBPreferences(JSON.stringify({ fontFamily: 'sans', lineHeight: 2 })))
      .toEqual({ flow: 'paged', layout: 'single', fontSize: 100, theme: 'paper' })
    expect(parseEPUBTypography(null)).toEqual(DEFAULT_EPUB_TYPOGRAPHY)
    expect(parseEPUBTypography(null)).not.toBe(DEFAULT_EPUB_TYPOGRAPHY)
  })

  it('rejects corrupt, primitive, and obsolete typography data', () => {
    for (const value of ['{', 'null', '[]', 'false', '4', '"sans"']) expect(parseEPUBTypography(value)).toEqual(DEFAULT_EPUB_TYPOGRAPHY)
    expect(parseEPUBTypography(JSON.stringify({ fontFamily: 'remote-font', lineHeight: '1.8', respectBookStyles: 'true' })))
      .toEqual(DEFAULT_EPUB_TYPOGRAPHY)
  })

  it('restores and clamps typography without accepting CSS or remote fonts', () => {
    expect(parseEPUBTypography(JSON.stringify({ fontFamily: 'sans', lineHeight: 1.93, paragraphSpacing: 1.24, sideMargin: 6.2, maxLineWidth: 61, respectBookStyles: true })))
      .toEqual({ fontFamily: 'sans', lineHeight: 1.9, paragraphSpacing: 1.2, sideMargin: 6, maxLineWidth: 62, respectBookStyles: true })
    expect(parseEPUBTypography(JSON.stringify({ fontFamily: 'system', lineHeight: 99, paragraphSpacing: -4, sideMargin: 80, maxLineWidth: 4 })))
      .toEqual({ fontFamily: 'system', lineHeight: 2.4, paragraphSpacing: 0, sideMargin: 12, maxLineWidth: 36, respectBookStyles: false })
  })

  it('leaves author typography intact when requested, keeping only reader safety rules', () => {
    const rules = getEPUBTypographyRules({ ...DEFAULT_EPUB_TYPOGRAPHY, respectBookStyles: true })
    expect(Object.keys(rules)).toEqual(['html, body', 'img'])
    expect(JSON.stringify(rules)).not.toMatch(/font-family|line-height|margin|padding|max-width.*ch/)
  })

  it('limits text blocks without overriding EPUB.js column or body geometry', () => {
    const rules = getEPUBTypographyRules({ ...DEFAULT_EPUB_TYPOGRAPHY, sideMargin: 6, maxLineWidth: 60 })
    expect(rules['p, h1, h2, h3, h4, h5, h6, blockquote, ul, ol']['max-width']).toBe('min(60ch, 88%) !important')
    expect(rules['body, p, li, dt, dd, blockquote']['font-family']).toContain('Songti SC')
    expect(JSON.stringify(rules)).not.toMatch(/https?:|@import|column-width|padding/)
  })

  it('finds the current chapter without misidentifying its nested fragments', () => {
    const entries = flattenEPUBNavigation([
      { id: 'one', href: 'one.xhtml', label: '第一章', subitems: [{ id: 'sub', href: 'one.xhtml#part', label: '第一节' }] },
      { id: 'two', href: 'two.xhtml', label: '第二章' },
    ])
    expect(findCurrentEPUBTOCEntry(entries, 'one.xhtml')?.id).toBe('one')
    expect(findCurrentEPUBTOCEntry(entries, 'one.xhtml#part')?.id).toBe('sub')
    expect(findCurrentEPUBTOCEntry(entries, 'OEBPS/one.xhtml')?.id).toBe('one')
    expect(findCurrentEPUBTOCEntry(entries, './two.xhtml')?.id).toBe('two')
    expect(findCurrentEPUBTOCEntry(entries, 'unknown.xhtml')).toBeUndefined()
    expect(findCurrentEPUBTOCEntry(entries, '')).toBeUndefined()
  })
})

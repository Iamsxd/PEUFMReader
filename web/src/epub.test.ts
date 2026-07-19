import { describe, expect, it } from 'vitest'
import {
  clampEPUBFontSize,
  normalizeEPUBWheelDelta,
  parseEPUBPreferences,
  resolveEPUBProgress,
} from './epub'

describe('EPUB reading preferences', () => {
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
})

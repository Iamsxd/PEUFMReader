import { describe, expect, it } from 'vitest'
import { clampProgress, formatBytes, formatDuration } from './utils'

describe('formatting helpers', () => {
  it('formats file sizes', () => {
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB')
  })

  it('formats active reading time', () => {
    expect(formatDuration(59)).toBe('0 分钟')
    expect(formatDuration(3661)).toBe('1 小时 1 分钟')
  })

  it('clamps progress', () => {
    expect(clampProgress(-1)).toBe(0)
    expect(clampProgress(0.45)).toBe(0.45)
    expect(clampProgress(2)).toBe(1)
    expect(clampProgress(Number.NaN)).toBe(0)
  })
})

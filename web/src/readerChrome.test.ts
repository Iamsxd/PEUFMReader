import { describe, expect, it } from 'vitest'
import { isReaderCenterTap } from './readerChrome'

const centerTap = {
  startX: 200,
  startY: 400,
  endX: 202,
  endY: 402,
  viewportWidth: 400,
  viewportHeight: 800,
}

describe('mobile reader chrome gestures', () => {
  it('recognizes a short tap in the center reading zone', () => {
    expect(isReaderCenterTap(centerTap)).toBe(true)
  })

  it('leaves edge taps available for page navigation', () => {
    expect(isReaderCenterTap({ ...centerTap, startX: 30, endX: 30 })).toBe(false)
    expect(isReaderCenterTap({ ...centerTap, startX: 370, endX: 370 })).toBe(false)
  })

  it('ignores scrolling, selection, and interactive content', () => {
    expect(isReaderCenterTap({ ...centerTap, endY: 450 })).toBe(false)
    expect(isReaderCenterTap({ ...centerTap, hasSelection: true })).toBe(false)
    expect(isReaderCenterTap({ ...centerTap, interactiveTarget: true })).toBe(false)
  })
})

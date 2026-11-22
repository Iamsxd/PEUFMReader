import { describe, expect, it } from 'vitest'
import {
  DEFAULT_READER_COMFORT, getEPUBThemeRules, getReaderComfortOverlay, parseReaderComfort, parseReaderTheme, READER_THEME_IDS, READER_THEMES,
} from './readerAppearance'
import { parseEPUBPreferences } from './epub'

describe('reader appearance', () => {
  it('offers six reading skins and rejects unknown values', () => {
    expect(READER_THEME_IDS).toEqual(['paper', 'sepia', 'green', 'mist', 'night', 'oled'])
    for (const id of READER_THEME_IDS) expect(parseReaderTheme(id)).toBe(id)
    for (const value of [undefined, null, '', 'dark', '__proto__', 3]) expect(parseReaderTheme(value)).toBe('paper')
    expect(parseReaderTheme('bad', 'night')).toBe('night')
  })

  it('keeps the original paper PDF colours and only filters other skins', () => {
    expect(READER_THEMES.paper.pdfFilter).toBe('none')
    for (const id of READER_THEME_IDS.filter(id => id !== 'paper')) expect(READER_THEMES[id].pdfFilter).not.toBe('none')
    expect(READER_THEMES.night.tone).toBe('dark')
    expect(READER_THEMES.oled.page).toBe('#000000')
  })

  it('builds epub.js rules and keeps legacy EPUB theme values', () => {
    expect(getEPUBThemeRules('sepia')['html, body']).toEqual({ color: '#3d3022', background: '#eee2c8' })
    expect(parseEPUBPreferences(JSON.stringify({ theme: 'green' })).theme).toBe('green')
    expect(parseEPUBPreferences(JSON.stringify({ theme: 'sepia' })).theme).toBe('sepia')
    expect(parseEPUBPreferences(JSON.stringify({ theme: 'neon' })).theme).toBe('paper')
  })

  it('clamps stored comfort settings and maps them to overlays', () => {
    expect(parseReaderComfort(null)).toEqual(DEFAULT_READER_COMFORT)
    expect(parseReaderComfort('not json')).toEqual(DEFAULT_READER_COMFORT)
    expect(parseReaderComfort('[1]')).toEqual(DEFAULT_READER_COMFORT)
    expect(parseReaderComfort('{"brightness":5,"warmth":99}')).toEqual({ brightness: 40, warmth: 60 })
    expect(parseReaderComfort('{"brightness":72.4,"warmth":"x"}')).toEqual({ brightness: 72, warmth: 0 })
    expect(getReaderComfortOverlay(DEFAULT_READER_COMFORT)).toEqual({ dim: 0, warmth: 0 })
    expect(getReaderComfortOverlay({ brightness: 40, warmth: 60 })).toEqual({ dim: 0.51, warmth: 0.27 })
  })
})

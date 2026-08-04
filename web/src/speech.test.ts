import { describe, expect, it } from 'vitest'
import {
  chunkSpeechText,
  clampSpeechRate,
  extractReadableDocumentText,
  inferSpeechLanguage,
  normalizeSpeechText,
  parseSpeechPreferences,
} from './speech'

describe('browser speech helpers', () => {
  it('sanitizes persisted speech preferences', () => {
    expect(parseSpeechPreferences('{"voiceURI":"voice-1","rate":9}')).toEqual({ voiceURI: 'voice-1', rate: 2 })
    expect(parseSpeechPreferences('not-json')).toEqual({ voiceURI: '', rate: 1 })
    expect(clampSpeechRate(0.1)).toBe(0.5)
  })

  it('normalizes and chunks long text at readable punctuation', () => {
    expect(normalizeSpeechText('  第一段\n\n 第二段\u200b ')).toBe('第一段 第二段')
    const text = '第一句内容较长，适合在标点处分段。第二句内容同样较长，继续验证分段行为。第三句作为结尾。'
    const chunks = chunkSpeechText(text, 40)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(text)
    expect(chunks.every((chunk) => chunk.length <= 40)).toBe(true)
  })

  it('removes navigation and executable document content', () => {
    const removable = [{ remove() {} }, { remove() {} }]
    const document = {
      body: {
        cloneNode: () => ({
          textContent: '正文 内容',
          querySelectorAll: () => removable,
        }),
      },
    } as unknown as Document
    expect(extractReadableDocumentText(document)).toBe('正文 内容')
  })

  it('uses declared language before lightweight text inference', () => {
    expect(inferSpeechLanguage('中文内容')).toBe('zh-CN')
    expect(inferSpeechLanguage('English text')).toBe('en-US')
    expect(inferSpeechLanguage('中文内容', 'zh-TW')).toBe('zh-TW')
  })
})

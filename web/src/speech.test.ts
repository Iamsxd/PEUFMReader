import { describe, expect, it } from 'vitest'
import {
  chunkSpeechText,
  clampSpeechPitch,
  clampSpeechRate,
  extractReadableDocumentText,
  findSpeechVoice,
  getSpeechPauseDuration,
  inferSpeechLanguage,
  normalizeSpeechText,
  parseSpeechPreferences,
} from './speech'

describe('browser speech helpers', () => {
  it('sanitizes persisted speech preferences', () => {
    expect(parseSpeechPreferences('{"voiceURI":"voice-1","rate":9,"pitch":4,"autoAdvance":false}')).toEqual({ voiceURI: 'voice-1', rate: 2, pitch: 1.2, autoAdvance: false })
    expect(parseSpeechPreferences('not-json')).toEqual({ voiceURI: '', rate: 1, pitch: 1, autoAdvance: true })
    expect(clampSpeechRate(0.1)).toBe(0.5)
    expect(clampSpeechPitch(0.1)).toBe(0.8)
  })

  it('creates sentence-sized chunks and explicit punctuation pauses', () => {
    expect(chunkSpeechText('第一句。第二句！第三句？')).toEqual(['第一句。', '第二句！', '第三句？'])
    expect(getSpeechPauseDuration('第一句。')).toBe(400)
    expect(getSpeechPauseDuration('半句，')).toBe(150)
    expect(getSpeechPauseDuration('无标点')).toBe(100)
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
    expect(inferSpeechLanguage('这是一本内容完整的中文书籍', 'en-US')).toBe('zh-CN')
    expect(inferSpeechLanguage('日本語の内容', 'ja-JP')).toBe('ja-JP')
  })

  it('prefers a compatible device voice over a mismatched saved voice', () => {
    const voices = [
      { voiceURI: 'english', lang: 'en-US', default: true, localService: true },
      { voiceURI: 'chinese', lang: 'zh-CN', default: false, localService: true },
    ]
    expect(findSpeechVoice(voices, 'english', 'zh-CN')?.voiceURI).toBe('chinese')
    expect(findSpeechVoice(voices, '', 'zh-CN')?.voiceURI).toBe('chinese')
    expect(findSpeechVoice(voices, 'english', 'en-US')?.voiceURI).toBe('english')
    expect(findSpeechVoice(voices.filter((voice) => voice.lang === 'en-US'), '', 'zh-CN')).toBeUndefined()
  })
})

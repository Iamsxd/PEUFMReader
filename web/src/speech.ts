export interface SpeechPreferences {
  voiceURI: string
  rate: number
  pitch: number
  autoAdvance: boolean
}

export interface SpeechVoiceCandidate {
  voiceURI: string
  lang: string
  name?: string
  default?: boolean
  localService?: boolean
}

export const SPEECH_PREFERENCES_KEY = 'peufmreader.speech.preferences.v1'
export const DEFAULT_SPEECH_PREFERENCES: SpeechPreferences = { voiceURI: '', rate: 1, pitch: 1, autoAdvance: true }

export function clampSpeechRate(rate: number): number {
  if (!Number.isFinite(rate)) return DEFAULT_SPEECH_PREFERENCES.rate
  return Math.min(2, Math.max(0.5, Math.round(rate * 20) / 20))
}

export function clampSpeechPitch(pitch: number): number {
  if (!Number.isFinite(pitch)) return DEFAULT_SPEECH_PREFERENCES.pitch
  return Math.min(1.2, Math.max(0.8, Math.round(pitch * 10) / 10))
}

export function parseSpeechPreferences(value: string | null): SpeechPreferences {
  if (!value) return { ...DEFAULT_SPEECH_PREFERENCES }
  try {
    const parsed = JSON.parse(value) as Partial<SpeechPreferences>
    return {
      voiceURI: typeof parsed.voiceURI === 'string' ? parsed.voiceURI : '',
      rate: clampSpeechRate(typeof parsed.rate === 'number' ? parsed.rate : DEFAULT_SPEECH_PREFERENCES.rate),
      pitch: clampSpeechPitch(typeof parsed.pitch === 'number' ? parsed.pitch : DEFAULT_SPEECH_PREFERENCES.pitch),
      autoAdvance: typeof parsed.autoAdvance === 'boolean' ? parsed.autoAdvance : DEFAULT_SPEECH_PREFERENCES.autoAdvance,
    }
  } catch {
    return { ...DEFAULT_SPEECH_PREFERENCES }
  }
}

export function normalizeSpeechText(text: string): string {
  return text
    .replace(/[\u00ad\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function chunkSpeechText(text: string, maxLength = 120): string[] {
  const normalized = normalizeSpeechText(text)
  if (!normalized) return []
  const safeLimit = Math.max(40, Math.round(maxLength))
  const chunks: string[] = []
  let start = 0

  while (start < normalized.length) {
    const limit = Math.min(normalized.length, start + safeLimit)
    let breakAt = -1
    for (let index = start; index < limit; index += 1) {
      if (/[。.!！？?；;]/.test(normalized[index])) {
        breakAt = index + 1
        break
      }
    }
    if (breakAt < 0 && limit < normalized.length) {
      const minimumBreak = start + Math.floor(safeLimit * 0.55)
      for (let index = limit - 1; index >= minimumBreak; index -= 1) {
        if (/[，,、：:\s]/.test(normalized[index] ?? '')) {
          breakAt = index + 1
          break
        }
      }
    }
    if (breakAt < 0) breakAt = limit
    const chunk = normalized.slice(start, breakAt).trim()
    if (chunk) chunks.push(chunk)
    start = breakAt
    while (normalized[start] === ' ') start += 1
  }
  return chunks
}

export function getSpeechPauseDuration(text: string): number {
  const ending = text.trim().at(-1) ?? ''
  if (/[。.!！？?]/.test(ending)) return 400
  if (/[；;]/.test(ending)) return 260
  if (/[，,、：:]/.test(ending)) return 150
  return 100
}

export function extractReadableDocumentText(document: Document): string {
  if (!document.body) return ''
  const body = document.body.cloneNode(true) as HTMLElement
  body.querySelectorAll('script, style, noscript, nav, svg, math, iframe, audio, video').forEach((element) => element.remove())
  return normalizeSpeechText(body.textContent ?? '')
}

export function inferSpeechLanguage(text: string, declaredLanguage?: string): string {
  const declared = declaredLanguage?.trim()
  const normalizedDeclared = declared?.toLocaleLowerCase().replaceAll('_', '-')
  if (normalizedDeclared?.startsWith('zh') || normalizedDeclared?.startsWith('cmn') || normalizedDeclared?.startsWith('yue')) return declared!
  if (normalizedDeclared?.startsWith('ja') || normalizedDeclared?.startsWith('ko')) return declared!
  const chineseCharacters = text.match(/[\u3400-\u9fff]/g)?.length ?? 0
  const latinCharacters = text.match(/[A-Za-z]/g)?.length ?? 0
  if (chineseCharacters >= 2 && chineseCharacters >= latinCharacters) return 'zh-CN'
  if (declared) return declared
  return chineseCharacters > 0 ? 'zh-CN' : 'en-US'
}

function normalizeSpeechLanguage(language: string): string {
  return language.trim().toLocaleLowerCase().replaceAll('_', '-')
}

function speechLanguageFamily(language: string): string {
  const primary = normalizeSpeechLanguage(language).split('-')[0]
  return primary === 'cmn' ? 'zh' : primary
}

function voiceLanguageFamily(voice: SpeechVoiceCandidate): string {
  if (/(?:中文|汉语|普通话|chinese|mandarin)/i.test(voice.name ?? '')) return 'zh'
  return speechLanguageFamily(voice.lang)
}

export function findSpeechVoice<TVoice extends SpeechVoiceCandidate>(voices: TVoice[], preferredVoiceURI: string, language: string): TVoice | undefined {
  const normalizedLanguage = normalizeSpeechLanguage(language)
  const languageFamily = speechLanguageFamily(language)
  const compatible = voices.filter((voice) => {
    const family = voiceLanguageFamily(voice)
    if (languageFamily === 'zh') return family === 'zh'
    return family === languageFamily
  })
  const preferred = voices.find((voice) => voice.voiceURI === preferredVoiceURI)
  if (preferred && compatible.includes(preferred)) return preferred
  return compatible.find((voice) => normalizeSpeechLanguage(voice.lang) === normalizedLanguage && voice.default)
    ?? compatible.find((voice) => normalizeSpeechLanguage(voice.lang) === normalizedLanguage && voice.localService)
    ?? compatible.find((voice) => normalizeSpeechLanguage(voice.lang) === normalizedLanguage)
    ?? compatible.find((voice) => voice.default)
    ?? compatible.find((voice) => voice.localService)
    ?? compatible[0]
}

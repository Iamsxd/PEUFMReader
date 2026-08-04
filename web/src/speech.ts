export interface SpeechPreferences {
  voiceURI: string
  rate: number
}

export const SPEECH_PREFERENCES_KEY = 'peufmreader.speech.preferences.v1'
export const DEFAULT_SPEECH_PREFERENCES: SpeechPreferences = { voiceURI: '', rate: 1 }

export function clampSpeechRate(rate: number): number {
  if (!Number.isFinite(rate)) return DEFAULT_SPEECH_PREFERENCES.rate
  return Math.min(2, Math.max(0.5, Math.round(rate * 20) / 20))
}

export function parseSpeechPreferences(value: string | null): SpeechPreferences {
  if (!value) return { ...DEFAULT_SPEECH_PREFERENCES }
  try {
    const parsed = JSON.parse(value) as Partial<SpeechPreferences>
    return {
      voiceURI: typeof parsed.voiceURI === 'string' ? parsed.voiceURI : '',
      rate: clampSpeechRate(typeof parsed.rate === 'number' ? parsed.rate : DEFAULT_SPEECH_PREFERENCES.rate),
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

export function chunkSpeechText(text: string, maxLength = 240): string[] {
  const normalized = normalizeSpeechText(text)
  if (!normalized) return []
  const safeLimit = Math.max(40, Math.round(maxLength))
  const chunks: string[] = []
  let remaining = normalized

  while (remaining.length > safeLimit) {
    const minimumBreak = Math.floor(safeLimit * 0.55)
    let breakAt = -1
    for (let index = safeLimit; index >= minimumBreak; index -= 1) {
      if (/[。！？!?；;，,、：:\s]/.test(remaining[index] ?? '')) {
        breakAt = index + 1
        break
      }
    }
    if (breakAt < 1) breakAt = safeLimit
    chunks.push(remaining.slice(0, breakAt).trim())
    remaining = remaining.slice(breakAt).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

export function extractReadableDocumentText(document: Document): string {
  if (!document.body) return ''
  const body = document.body.cloneNode(true) as HTMLElement
  body.querySelectorAll('script, style, noscript, nav, svg, math, iframe, audio, video').forEach((element) => element.remove())
  return normalizeSpeechText(body.textContent ?? '')
}

export function inferSpeechLanguage(text: string, declaredLanguage?: string): string {
  const declared = declaredLanguage?.trim()
  if (declared) return declared
  return /[\u3400-\u9fff]/.test(text) ? 'zh-CN' : 'en-US'
}

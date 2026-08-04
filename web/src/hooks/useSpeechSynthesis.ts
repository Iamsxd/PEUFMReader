import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  chunkSpeechText,
  clampSpeechRate,
  inferSpeechLanguage,
  parseSpeechPreferences,
  SPEECH_PREFERENCES_KEY,
} from '../speech'

export type SpeechPlaybackStatus = 'idle' | 'loading' | 'speaking' | 'paused'

export interface SpeechSource {
  text: string
  label: string
  language?: string
}

interface UseSpeechSynthesisOptions {
  loadSource: () => Promise<SpeechSource>
  sourceKey: string
}

export interface BrowserSpeechControls {
  supported: boolean
  voices: SpeechSynthesisVoice[]
  selectedVoiceURI: string
  rate: number
  status: SpeechPlaybackStatus
  sourceLabel: string
  progressLabel: string
  error: string
  start: () => Promise<void>
  pauseOrResume: () => void
  stop: () => void
  selectVoice: (voiceURI: string) => void
  selectRate: (rate: number) => void
}

function readPreferences() {
  try {
    return parseSpeechPreferences(window.localStorage.getItem(SPEECH_PREFERENCES_KEY))
  } catch {
    return parseSpeechPreferences(null)
  }
}

export function useSpeechSynthesis({ loadSource, sourceKey }: UseSpeechSynthesisOptions): BrowserSpeechControls {
  const supported = typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && 'SpeechSynthesisUtterance' in window
  const [preferences, setPreferences] = useState(readPreferences)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [status, setStatus] = useState<SpeechPlaybackStatus>('idle')
  const [sourceLabel, setSourceLabel] = useState('')
  const [progress, setProgress] = useState({ current: 0, total: 0 })
  const [error, setError] = useState('')
  const runRef = useRef(0)

  const stop = useCallback(() => {
    runRef.current += 1
    if (supported) window.speechSynthesis.cancel()
    setStatus('idle')
    setProgress({ current: 0, total: 0 })
  }, [supported])

  useEffect(() => {
    if (!supported) return
    const synthesis = window.speechSynthesis
    const refreshVoices = () => setVoices(synthesis.getVoices())
    refreshVoices()
    synthesis.addEventListener('voiceschanged', refreshVoices)
    return () => synthesis.removeEventListener('voiceschanged', refreshVoices)
  }, [supported])

  useEffect(() => {
    try {
      window.localStorage.setItem(SPEECH_PREFERENCES_KEY, JSON.stringify(preferences))
    } catch {
      // Private browsing or a locked-down browser can reject local storage.
    }
  }, [preferences])

  useEffect(() => {
    stop()
    setSourceLabel('')
    setError('')
  }, [sourceKey, stop])
  useEffect(() => () => {
    runRef.current += 1
    if (supported) window.speechSynthesis.cancel()
  }, [supported])

  const selectedVoiceURI = voices.some((voice) => voice.voiceURI === preferences.voiceURI)
    ? preferences.voiceURI
    : ''

  const start = useCallback(async () => {
    if (!supported) {
      setError('当前浏览器不支持即时朗读。请使用最新版 Safari、Chrome 或 Edge。')
      return
    }

    const run = runRef.current + 1
    runRef.current = run
    window.speechSynthesis.cancel()
    setStatus('loading')
    setError('')
    setProgress({ current: 0, total: 0 })

    try {
      const source = await loadSource()
      if (run !== runRef.current) return
      const chunks = chunkSpeechText(source.text)
      if (chunks.length === 0) {
        setStatus('idle')
        setError('当前内容没有可朗读文字；扫描版 PDF 需要先具备文本层。')
        return
      }

      setSourceLabel(source.label)
      setProgress({ current: 1, total: chunks.length })
      const language = inferSpeechLanguage(source.text, source.language)
      const selectedVoice = voices.find((voice) => voice.voiceURI === preferences.voiceURI)

      const speakChunk = (index: number) => {
        if (run !== runRef.current) return
        const utterance = new SpeechSynthesisUtterance(chunks[index])
        utterance.rate = preferences.rate
        utterance.lang = selectedVoice?.lang || language
        if (selectedVoice) utterance.voice = selectedVoice
        utterance.onstart = () => {
          if (run === runRef.current) setStatus('speaking')
        }
        utterance.onend = () => {
          if (run !== runRef.current) return
          const next = index + 1
          if (next >= chunks.length) {
            setStatus('idle')
            setProgress({ current: chunks.length, total: chunks.length })
            return
          }
          setProgress({ current: next + 1, total: chunks.length })
          speakChunk(next)
        }
        utterance.onerror = (event) => {
          if (run !== runRef.current || event.error === 'canceled' || event.error === 'interrupted') return
          setStatus('idle')
          setError(`朗读失败（${event.error || '未知错误'}），可以更换音色后重试。`)
        }
        window.speechSynthesis.speak(utterance)
      }

      speakChunk(0)
    } catch (reason) {
      if (run !== runRef.current) return
      console.error('Browser speech source loading failed.', reason)
      setStatus('idle')
      setError(reason instanceof Error ? reason.message : '朗读文本读取失败，请稍后重试。')
    }
  }, [loadSource, preferences.rate, preferences.voiceURI, supported, voices])

  const pauseOrResume = useCallback(() => {
    if (!supported) return
    if (status === 'speaking') {
      window.speechSynthesis.pause()
      setStatus('paused')
    } else if (status === 'paused') {
      window.speechSynthesis.resume()
      setStatus('speaking')
    }
  }, [status, supported])

  const selectVoice = useCallback((voiceURI: string) => {
    stop()
    setPreferences((current) => ({ ...current, voiceURI }))
  }, [stop])

  const selectRate = useCallback((rate: number) => {
    stop()
    setPreferences((current) => ({ ...current, rate: clampSpeechRate(rate) }))
  }, [stop])

  const progressLabel = useMemo(() => {
    if (status === 'loading') return '正在读取文字…'
    if (progress.total === 0) return ''
    if (status === 'idle' && progress.current === progress.total) return '本段已朗读完成'
    return `第 ${progress.current} / ${progress.total} 段`
  }, [progress, status])

  return {
    supported,
    voices,
    selectedVoiceURI,
    rate: preferences.rate,
    status,
    sourceLabel,
    progressLabel,
    error,
    start,
    pauseOrResume,
    stop,
    selectVoice,
    selectRate,
  }
}

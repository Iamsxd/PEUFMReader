import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  chunkSpeechText,
  clampSpeechPitch,
  clampSpeechRate,
  getSpeechPauseDuration,
  findSpeechVoice,
  inferSpeechLanguage,
  parseSpeechPreferences,
  SPEECH_PREFERENCES_KEY,
} from '../speech'

export type SpeechPlaybackStatus = 'idle' | 'loading' | 'speaking' | 'paused'

export interface SpeechSource {
  text: string
  label: string
  language?: string
  cursor?: number
}

export interface SpeechSourceAdvance {
  source: SpeechSource
  sourceKey: string
  activate: () => void | Promise<void>
}

interface UseSpeechSynthesisOptions {
  loadSource: () => Promise<SpeechSource>
  loadNextSource?: (source: SpeechSource) => Promise<SpeechSourceAdvance | null>
  sourceKey: string
}

export interface BrowserSpeechControls {
  supported: boolean
  voices: SpeechSynthesisVoice[]
  selectedVoiceURI: string
  rate: number
  pitch: number
  autoAdvance: boolean
  status: SpeechPlaybackStatus
  sourceLabel: string
  progressLabel: string
  error: string
  start: () => Promise<void>
  pauseOrResume: () => void
  stop: () => void
  selectVoice: (voiceURI: string) => void
  selectRate: (rate: number) => void
  selectPitch: (pitch: number) => void
  setAutoAdvance: (enabled: boolean) => void
}

function readPreferences() {
  try {
    return parseSpeechPreferences(window.localStorage.getItem(SPEECH_PREFERENCES_KEY))
  } catch {
    return parseSpeechPreferences(null)
  }
}

export function useSpeechSynthesis({ loadSource, loadNextSource, sourceKey }: UseSpeechSynthesisOptions): BrowserSpeechControls {
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
  const pauseTimerRef = useRef<number | null>(null)
  const previousSourceKeyRef = useRef(sourceKey)
  const expectedSourceKeyRef = useRef<string | null>(null)

  const stop = useCallback(() => {
    runRef.current += 1
    if (pauseTimerRef.current !== null) window.clearTimeout(pauseTimerRef.current)
    pauseTimerRef.current = null
    expectedSourceKeyRef.current = null
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
    if (previousSourceKeyRef.current === sourceKey) return
    previousSourceKeyRef.current = sourceKey
    if (expectedSourceKeyRef.current === sourceKey) {
      expectedSourceKeyRef.current = null
      return
    }
    stop()
    setSourceLabel('')
    setError('')
  }, [sourceKey, stop])
  useEffect(() => () => {
    runRef.current += 1
    if (pauseTimerRef.current !== null) window.clearTimeout(pauseTimerRef.current)
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

      const finish = () => {
        setStatus('idle')
        setProgress((current) => ({ current: current.total, total: current.total }))
      }
      const continueToNextSource = async (currentSource: SpeechSource) => {
        if (!preferences.autoAdvance || !loadNextSource) {
          finish()
          return
        }
        setStatus('loading')
        let cursorSource = currentSource
        try {
          while (run === runRef.current) {
            const advance = await loadNextSource(cursorSource)
            if (run !== runRef.current) return
            if (!advance) {
              finish()
              return
            }
            cursorSource = advance.source
            const nextChunks = chunkSpeechText(advance.source.text)
            if (nextChunks.length === 0) continue
            expectedSourceKeyRef.current = advance.sourceKey
            await advance.activate()
            if (run !== runRef.current) return
            speakSource(advance.source, nextChunks)
            return
          }
        } catch (reason) {
          if (run !== runRef.current) return
          expectedSourceKeyRef.current = null
          console.error('Browser speech auto-advance failed.', reason)
          setStatus('idle')
          setError('自动翻页失败，已停止连续朗读。')
        }
      }
      const speakSource = (activeSource: SpeechSource, activeChunks: string[]) => {
        setSourceLabel(activeSource.label)
        setProgress({ current: 1, total: activeChunks.length })
        const language = inferSpeechLanguage(activeSource.text, activeSource.language)
        const selectedVoice = findSpeechVoice(voices, preferences.voiceURI, language)
        if (/^(zh|cmn|yue)(-|$)/i.test(language) && voices.length > 0 && !selectedVoice) {
          setStatus('idle')
          setError('手机没有向浏览器提供中文音色，请在系统“文字转语音输出”中安装中文语言包后重试。')
          return
        }
        const speakChunk = (index: number) => {
          if (run !== runRef.current) return
          const utterance = new SpeechSynthesisUtterance(activeChunks[index])
          utterance.rate = preferences.rate
          utterance.pitch = preferences.pitch
          utterance.lang = selectedVoice?.lang || language
          if (selectedVoice) utterance.voice = selectedVoice
          utterance.onstart = () => {
            if (run === runRef.current) setStatus('speaking')
          }
          utterance.onend = () => {
            if (run !== runRef.current) return
            const next = index + 1
            const resume = () => {
              pauseTimerRef.current = null
              if (run !== runRef.current) return
              if (next >= activeChunks.length) {
                void continueToNextSource(activeSource)
                return
              }
              setProgress({ current: next + 1, total: activeChunks.length })
              speakChunk(next)
            }
            pauseTimerRef.current = window.setTimeout(resume, getSpeechPauseDuration(activeChunks[index]))
          }
          utterance.onerror = (event) => {
            if (run !== runRef.current || event.error === 'canceled' || event.error === 'interrupted') return
            setStatus('idle')
            if (event.error === 'language-unavailable' || event.error === 'voice-unavailable') {
              setError(`手机没有可用的${language.startsWith('zh') ? '中文' : language}语音，请安装对应的系统文字转语音语言包后重试。`)
            } else {
              setError(`朗读失败（${event.error || '未知错误'}），可以更换音色后重试。`)
            }
          }
          window.speechSynthesis.speak(utterance)
        }

        speakChunk(0)
      }

      speakSource(source, chunks)
    } catch (reason) {
      if (run !== runRef.current) return
      console.error('Browser speech source loading failed.', reason)
      setStatus('idle')
      setError(reason instanceof Error ? reason.message : '朗读文本读取失败，请稍后重试。')
    }
  }, [loadNextSource, loadSource, preferences.autoAdvance, preferences.pitch, preferences.rate, preferences.voiceURI, supported, voices])

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

  const selectPitch = useCallback((pitch: number) => {
    stop()
    setPreferences((current) => ({ ...current, pitch: clampSpeechPitch(pitch) }))
  }, [stop])

  const setAutoAdvance = useCallback((autoAdvance: boolean) => {
    stop()
    setPreferences((current) => ({ ...current, autoAdvance }))
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
    pitch: preferences.pitch,
    autoAdvance: preferences.autoAdvance,
    status,
    sourceLabel,
    progressLabel,
    error,
    start,
    pauseOrResume,
    stop,
    selectVoice,
    selectRate,
    selectPitch,
    setAutoAdvance,
  }
}

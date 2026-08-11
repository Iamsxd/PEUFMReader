import { useCallback, useEffect, useRef } from 'react'

export interface ReadingProgressSnapshot {
  position: Record<string, unknown>
  overallProgress: number
}

interface Options {
  onProgress: (position: Record<string, unknown>, overallProgress: number) => Promise<void>
  onError: () => void
}

export function useReadingProgressPersistence({ onProgress, onError }: Options) {
  const onProgressRef = useRef(onProgress)
  const onErrorRef = useRef(onError)
  const latestRef = useRef<(ReadingProgressSnapshot & { version: number }) | null>(null)
  const timerRef = useRef<number | null>(null)
  const nextVersionRef = useRef(0)
  const savingRef = useRef(false)
  const savedVersionRef = useRef(0)
  onProgressRef.current = onProgress
  onErrorRef.current = onError

  const persistLatest = useCallback(async () => {
    if (savingRef.current) return
    const snapshot = latestRef.current
    if (!snapshot || snapshot.version <= savedVersionRef.current) return

    savingRef.current = true
    try {
      await onProgressRef.current(snapshot.position, snapshot.overallProgress)
      savedVersionRef.current = Math.max(savedVersionRef.current, snapshot.version)
    } catch {
      onErrorRef.current()
    } finally {
      savingRef.current = false
      if ((latestRef.current?.version ?? 0) > snapshot.version) void persistLatest()
    }
  }, [])

  const schedule = useCallback((snapshot: ReadingProgressSnapshot, delayMs: number) => {
    latestRef.current = { ...snapshot, version: nextVersionRef.current + 1 }
    nextVersionRef.current += 1
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      void persistLatest()
    }, delayMs)
  }, [persistLatest])

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    void persistLatest()
  }, [persistLatest])

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      flush()
    }
  }, [flush])

  return { schedule, flush }
}

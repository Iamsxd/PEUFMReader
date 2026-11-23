import { useCallback, useEffect, useState } from 'react'
import { loadReaderComfort, parseReaderComfort, READER_COMFORT_KEY, saveReaderComfort, type ReaderComfort } from '../readerAppearance'

/** Brightness and warmth are device settings shared by all formats and tabs. */
export function useReaderComfort() {
  const [comfort, setComfortState] = useState(loadReaderComfort)
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === READER_COMFORT_KEY || event.key === null) setComfortState(parseReaderComfort(event.newValue))
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])
  const setComfort = useCallback((next: ReaderComfort) => {
    saveReaderComfort(next)
    setComfortState(next)
  }, [])
  return [comfort, setComfort] as const
}

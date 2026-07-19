import { useEffect, useRef } from 'react'
import { api } from '../api'

const HEARTBEAT_SECONDS = 15

export function useReadingSession(bookFileID: number) {
  const lastInteraction = useRef(Date.now())

  useEffect(() => {
    let disposed = false
    let sessionID: number | null = null
    const markInteraction = () => { lastInteraction.current = Date.now() }
    const events: (keyof WindowEventMap)[] = ['keydown', 'pointerdown', 'wheel', 'touchstart']
    events.forEach((event) => window.addEventListener(event, markInteraction, { passive: true }))

    void api.startReadingSession(bookFileID).then((session) => {
      if (disposed) {
        void api.advanceReadingSession(session.id, 'finish', 0).catch(() => undefined)
      } else {
        sessionID = session.id
      }
    })

    const interval = window.setInterval(() => {
      const recentlyActive = Date.now() - lastInteraction.current < 60_000
      if (sessionID && document.visibilityState === 'visible' && recentlyActive) {
        void api.advanceReadingSession(sessionID, 'heartbeat', HEARTBEAT_SECONDS).catch(() => undefined)
      }
    }, HEARTBEAT_SECONDS * 1000)

    return () => {
      disposed = true
      window.clearInterval(interval)
      events.forEach((event) => window.removeEventListener(event, markInteraction))
      if (sessionID) {
        void api.advanceReadingSession(sessionID, 'finish', 0).catch(() => undefined)
      }
    }
  }, [bookFileID])
}

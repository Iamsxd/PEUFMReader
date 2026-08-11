import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isScreenWakeLockSupported,
  parseScreenWakeLockPreference,
  SCREEN_WAKE_LOCK_PREFERENCE_KEY,
  type ScreenWakeLock,
  type ScreenWakeLockNavigator,
  type ScreenWakeLockSentinel,
} from '../screenWakeLock'

export type ScreenWakeLockStatus = 'unsupported' | 'off' | 'requesting' | 'active' | 'suspended' | 'blocked'

export interface ScreenWakeLockControls {
  supported: boolean
  enabled: boolean
  status: ScreenWakeLockStatus
  message: string
  toggle: () => void
}

function wakeLockAPI(): ScreenWakeLock | undefined {
  if (typeof navigator === 'undefined') return undefined
  const browserNavigator = navigator as Navigator & ScreenWakeLockNavigator
  return browserNavigator.wakeLock
}

function documentIsVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

function readPreference(): boolean {
  try {
    return parseScreenWakeLockPreference(window.localStorage.getItem(SCREEN_WAKE_LOCK_PREFERENCE_KEY))
  } catch {
    return false
  }
}

function savePreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(SCREEN_WAKE_LOCK_PREFERENCE_KEY, String(enabled))
  } catch {
    // Private browsing or a locked-down browser can reject local storage.
  }
}

function statusMessage(status: ScreenWakeLockStatus): string {
  switch (status) {
    case 'active': return '屏幕常亮已开启。'
    case 'requesting': return '正在开启屏幕常亮…'
    case 'suspended': return '屏幕常亮已暂停，回到阅读器时会自动恢复。'
    case 'blocked': return '系统暂未允许屏幕常亮；请检查低电量或省电模式。'
    case 'unsupported': return '当前浏览器或访问方式不支持屏幕常亮；请使用 HTTPS 下的新版 Safari 或 Chrome。'
    default: return '屏幕会按设备设置自动熄灭。'
  }
}

export function useScreenWakeLock(): ScreenWakeLockControls {
  const supported = isScreenWakeLockSupported(typeof navigator === 'undefined' ? undefined : navigator as Navigator & ScreenWakeLockNavigator)
  const [enabled, setEnabled] = useState(readPreference)
  const [status, setStatus] = useState<ScreenWakeLockStatus>(() => supported ? 'off' : 'unsupported')
  const sentinelRef = useRef<ScreenWakeLockSentinel | null>(null)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  const release = useCallback(async () => {
    const sentinel = sentinelRef.current
    sentinelRef.current = null
    if (!sentinel || sentinel.released) return
    try {
      await sentinel.release()
    } catch {
      // The platform may have already released the lock.
    }
  }, [])

  const request = useCallback(async () => {
    const wakeLock = wakeLockAPI()
    if (!wakeLock) {
      setStatus('unsupported')
      return
    }
    if (!enabledRef.current) {
      setStatus('off')
      return
    }
    if (!documentIsVisible()) {
      setStatus('suspended')
      return
    }
    if (sentinelRef.current && !sentinelRef.current.released) {
      setStatus('active')
      return
    }

    setStatus('requesting')
    try {
      const sentinel = await wakeLock.request('screen')
      if (!enabledRef.current || !documentIsVisible()) {
        try {
          await sentinel.release()
        } catch {
          // The system can release a newly acquired lock before this cleanup.
        }
        return
      }
      sentinelRef.current = sentinel
      sentinel.addEventListener('release', () => {
        if (sentinelRef.current !== sentinel) return
        sentinelRef.current = null
        setStatus(enabledRef.current && documentIsVisible() ? 'blocked' : enabledRef.current ? 'suspended' : 'off')
      })
      setStatus('active')
    } catch {
      setStatus(enabledRef.current ? 'blocked' : 'off')
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      void release()
      setStatus(supported ? 'off' : 'unsupported')
      return
    }
    if (!supported) {
      setStatus('unsupported')
      return
    }
    void request()
  }, [enabled, release, request, supported])

  useEffect(() => {
    const onVisibilityChange = () => {
      if (documentIsVisible()) {
        if (enabledRef.current) void request()
        return
      }
      void release()
      if (enabledRef.current) setStatus('suspended')
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [release, request])

  useEffect(() => () => { void release() }, [release])

  const toggle = useCallback(() => {
    const nextEnabled = !enabledRef.current
    enabledRef.current = nextEnabled
    setEnabled(nextEnabled)
    savePreference(nextEnabled)
  }, [])

  return { supported, enabled, status, message: statusMessage(status), toggle }
}

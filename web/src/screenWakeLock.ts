export const SCREEN_WAKE_LOCK_PREFERENCE_KEY = 'peufmreader.screen-wake-lock.enabled.v1'

export interface ScreenWakeLockSentinel {
  readonly released: boolean
  release: () => Promise<void>
  addEventListener: (type: 'release', listener: () => void) => void
}

export interface ScreenWakeLock {
  request: (type?: 'screen') => Promise<ScreenWakeLockSentinel>
}

export interface ScreenWakeLockNavigator {
  wakeLock?: ScreenWakeLock
}

export function isScreenWakeLockSupported(navigatorLike: ScreenWakeLockNavigator | undefined): boolean {
  return typeof navigatorLike?.wakeLock?.request === 'function'
}

export function parseScreenWakeLockPreference(value: string | null): boolean {
  return value === 'true'
}

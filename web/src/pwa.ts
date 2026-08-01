export const PWA_INSTALL_DISMISS_KEY = 'peufmreader.pwa-install-dismissed.v1'
export const PWA_INSTALL_DISMISS_MS = 14 * 24 * 60 * 60 * 1000

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

export function isStandaloneDisplay(matchMedia: (query: string) => Pick<MediaQueryList, 'matches'> = window.matchMedia.bind(window)): boolean {
  return matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
}

export function isIOSDevice(userAgent = navigator.userAgent, platform = navigator.platform, maxTouchPoints = navigator.maxTouchPoints): boolean {
  return /iPad|iPhone|iPod/i.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1)
}

export function installSuggestionDismissed(storage: Storage = window.localStorage, now = Date.now()): boolean {
  try {
    const dismissedAt = Number(storage.getItem(PWA_INSTALL_DISMISS_KEY))
    return Number.isFinite(dismissedAt) && dismissedAt > 0 && now - dismissedAt < PWA_INSTALL_DISMISS_MS
  } catch {
    return false
  }
}

export function dismissInstallSuggestion(storage: Storage = window.localStorage, now = Date.now()): void {
  try {
    storage.setItem(PWA_INSTALL_DISMISS_KEY, String(now))
  } catch {
    // Private browsing modes may reject persistent site preferences.
  }
}

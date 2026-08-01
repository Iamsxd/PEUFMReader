import { describe, expect, it } from 'vitest'
import { dismissInstallSuggestion, installSuggestionDismissed, isIOSDevice, isStandaloneDisplay, PWA_INSTALL_DISMISS_MS } from './pwa'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

describe('PWA installation helpers', () => {
  it('recognizes browser and iOS standalone modes', () => {
    expect(isStandaloneDisplay(() => ({ matches: true }) as MediaQueryList)).toBe(true)
    expect(isStandaloneDisplay(() => ({ matches: false }) as MediaQueryList)).toBe(false)
    expect(isIOSDevice('Mozilla/5.0 (iPhone)', 'iPhone', 5)).toBe(true)
    expect(isIOSDevice('Mozilla/5.0 (Macintosh)', 'MacIntel', 5)).toBe(true)
    expect(isIOSDevice('Mozilla/5.0 (Linux; Android 15)', 'Linux armv8l', 5)).toBe(false)
  })

  it('expires a dismissed suggestion after fourteen days', () => {
    const storage = new MemoryStorage()
    dismissInstallSuggestion(storage, 1_000)
    expect(installSuggestionDismissed(storage, 1_000 + PWA_INSTALL_DISMISS_MS - 1)).toBe(true)
    expect(installSuggestionDismissed(storage, 1_000 + PWA_INSTALL_DISMISS_MS + 1)).toBe(false)
  })
})

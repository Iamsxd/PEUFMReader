import { describe, expect, it } from 'vitest'
import { isScreenWakeLockSupported, parseScreenWakeLockPreference } from './screenWakeLock'

describe('screen wake lock helpers', () => {
  it('recognizes supported browser APIs', () => {
    expect(isScreenWakeLockSupported({ wakeLock: { request: async () => ({ released: false, release: async () => undefined, addEventListener: () => undefined }) } })).toBe(true)
    expect(isScreenWakeLockSupported({})).toBe(false)
    expect(isScreenWakeLockSupported(undefined)).toBe(false)
  })

  it('only restores an explicitly enabled preference', () => {
    expect(parseScreenWakeLockPreference('true')).toBe(true)
    expect(parseScreenWakeLockPreference('false')).toBe(false)
    expect(parseScreenWakeLockPreference(null)).toBe(false)
  })
})

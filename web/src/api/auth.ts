import type { AuthProviders, DeviceToken, Session } from '../types'
import { transport } from './core'

export const authAPI = {
  setSession(session: Session | null) {
    transport.setSession(session)
  },

  async login(username: string, password: string): Promise<Session> {
    const session = await transport.request<Session>('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username, password }), headers: { 'Content-Type': 'application/json' } }, false)
    transport.setSession(session)
    return session
  },

  authProviders(): Promise<AuthProviders> {
    return transport.request('/api/v1/auth/providers', {}, false)
  },

  async me(): Promise<Session> {
    const session = await transport.request<Session>('/api/v1/auth/me')
    transport.setSession(session)
    return session
  },

  async logout(): Promise<void> {
    await transport.request<void>('/api/v1/auth/logout', { method: 'POST' })
    transport.setSession(null)
  },

  async listDeviceTokens(): Promise<DeviceToken[]> {
    const result = await transport.request<{ items: DeviceToken[] }>('/api/v1/device-tokens')
    return result.items
  },

  createDeviceToken(name: string, expiresDays: number): Promise<DeviceToken> {
    return transport.request('/api/v1/device-tokens', { method: 'POST', body: JSON.stringify({ name, expiresDays }), headers: { 'Content-Type': 'application/json' } })
  },

  revokeDeviceToken(tokenID: number): Promise<void> {
    return transport.request(`/api/v1/device-tokens/${tokenID}`, { method: 'DELETE' })
  },
}

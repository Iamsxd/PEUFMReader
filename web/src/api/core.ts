import type { Session } from '../types'

interface ErrorBody {
  error?: { code?: string; message?: string }
}

export class APIError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message)
  }
}

class APITransport {
  private csrfToken = ''

  setSession(session: Session | null) {
    this.csrfToken = session?.csrfToken ?? ''
  }

  getCSRFToken(): string {
    return this.csrfToken
  }

  async request<T>(path: string, init: RequestInit = {}, includeCSRF = true): Promise<T> {
    const headers = new Headers(init.headers)
    if (includeCSRF && init.method && init.method !== 'GET' && this.csrfToken) headers.set('X-CSRF-Token', this.csrfToken)
    let response: Response
    try {
      response = await fetch(path, { ...init, headers, credentials: 'include' })
    } catch {
      throw new APIError(0, 'network_error', '无法连接服务器。')
    }
    if (!response.ok) {
      let body: ErrorBody = {}
      try {
        body = await response.json() as ErrorBody
      } catch {
        // Preserve a useful fallback when a proxy returns a non-JSON error page.
      }
      throw new APIError(response.status, body.error?.code ?? 'request_failed', body.error?.message ?? `Request failed (${response.status})`)
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }
}

export const transport = new APITransport()

export function querySuffix(query: object): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  return params.size > 0 ? `?${params.toString()}` : ''
}

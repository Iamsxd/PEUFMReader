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

  async download(path: string, mimeType: string, filename: string): Promise<{ blob: Blob; filename: string }> {
    let response: Response
    try {
      response = await fetch(path, { credentials: 'include' })
    } catch {
      throw new APIError(0, 'network_error', '无法连接服务器。')
    }
    if (!response.ok) {
      let body: ErrorBody = {}
      try { body = await response.json() as ErrorBody } catch { /* A proxy may return HTML. */ }
      throw new APIError(response.status, body.error?.code ?? 'request_failed', body.error?.message ?? `Request failed (${response.status})`)
    }
    if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== mimeType) {
      throw new APIError(response.status, 'invalid_download', '服务器未返回有效的导出文件，请重试。')
    }
    const limit = 16 * 1024 * 1024
    if (Number(response.headers.get('Content-Length')) > limit) {
      await response.body?.cancel()
      throw new APIError(413, 'export_too_large', '导出文件过大，请缩小筛选范围。')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new APIError(0, 'invalid_download', '导出文件为空，请重试。')
    const chunks: BlobPart[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limit) {
          await reader.cancel()
          throw new APIError(413, 'export_too_large', '导出文件过大，请缩小筛选范围。')
        }
        chunks.push(value as Uint8Array<ArrayBuffer>)
      }
    } catch (reason) {
      if (reason instanceof APIError) throw reason
      throw new APIError(0, 'network_error', '下载中断，请重试。')
    } finally {
      reader.releaseLock()
    }
    return { blob: new Blob(chunks, { type: mimeType }), filename }
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

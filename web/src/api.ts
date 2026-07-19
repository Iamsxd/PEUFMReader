import type { BookFile, Category, ImportJob, ReadingSession, ReadingState, ReviewInput, ReviewItem, Session, User } from './types'

interface ErrorBody {
  error?: { code?: string; message?: string }
}

export class APIError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

class APIClient {
  private csrfToken = ''

  setSession(session: Session | null) {
    this.csrfToken = session?.csrfToken ?? ''
  }

  async login(username: string, password: string): Promise<Session> {
    const session = await this.request<Session>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
      headers: { 'Content-Type': 'application/json' },
    }, false)
    this.setSession(session)
    return session
  }

  async me(): Promise<Session> {
    const session = await this.request<Session>('/api/v1/auth/me')
    this.setSession(session)
    return session
  }

  async logout(): Promise<void> {
    await this.request<void>('/api/v1/auth/logout', { method: 'POST' })
    this.setSession(null)
  }

  async listBooks(): Promise<BookFile[]> {
    const result = await this.request<{ items: BookFile[] }>('/api/v1/book-files')
    return result.items
  }

  async uploadBook(file: File): Promise<{ bookFile: BookFile; duplicate: boolean }> {
    const form = new FormData()
    form.append('file', file)
    return this.request('/api/v1/book-files', { method: 'POST', body: form })
  }

  async listCategories(): Promise<Category[]> {
    const result = await this.request<{ items: Category[] }>('/api/v1/categories')
    return result.items
  }

  async listReviewQueue(): Promise<ReviewItem[]> {
    const result = await this.request<{ items: ReviewItem[] }>('/api/v1/review-queue')
    return result.items
  }

  getEditionReview(editionID: number): Promise<ReviewItem> {
    return this.request(`/api/v1/editions/${editionID}/review`)
  }

  reviewEdition(editionID: number, input: ReviewInput): Promise<ReviewItem> {
    return this.request(`/api/v1/editions/${editionID}/review`, {
      method: 'PUT',
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  aiClassifyEdition(editionID: number): Promise<ReviewItem> {
    return this.request(`/api/v1/editions/${editionID}/ai-classify`, { method: 'POST' })
  }

  async listImportJobs(): Promise<ImportJob[]> {
    const result = await this.request<{ items: ImportJob[] }>('/api/v1/import-jobs')
    return result.items
  }

  async listUsers(): Promise<User[]> {
    const result = await this.request<{ items: User[] }>('/api/v1/users')
    return result.items
  }

  async createUser(username: string, password: string, role: 'admin' | 'reader'): Promise<User> {
    return this.request('/api/v1/users', {
      method: 'POST',
      body: JSON.stringify({ username, password, role }),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  contentURL(bookFileID: number): string {
    return `/api/v1/book-files/${bookFileID}/content`
  }

  getProgress(bookFileID: number): Promise<ReadingState> {
    return this.request(`/api/v1/book-files/${bookFileID}/progress`)
  }

  saveProgress(bookFileID: number, state: Pick<ReadingState, 'position' | 'overallProgress' | 'status'>): Promise<ReadingState> {
    return this.request(`/api/v1/book-files/${bookFileID}/progress`, {
      method: 'PUT',
      body: JSON.stringify(state),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  startReadingSession(bookFileID: number): Promise<ReadingSession> {
    return this.request(`/api/v1/book-files/${bookFileID}/reading-sessions`, { method: 'POST' })
  }

  advanceReadingSession(sessionID: number, action: 'heartbeat' | 'finish', activeSeconds: number): Promise<ReadingSession> {
    return this.request(`/api/v1/reading-sessions/${sessionID}`, {
      method: 'PATCH',
      body: JSON.stringify({ action, activeSeconds }),
      headers: { 'Content-Type': 'application/json' },
      keepalive: action === 'finish',
    })
  }

  private async request<T>(path: string, init: RequestInit = {}, includeCSRF = true): Promise<T> {
    const headers = new Headers(init.headers)
    if (includeCSRF && init.method && init.method !== 'GET' && this.csrfToken) {
      headers.set('X-CSRF-Token', this.csrfToken)
    }
    const response = await fetch(path, { ...init, headers, credentials: 'include' })
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

export const api = new APIClient()

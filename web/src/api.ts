import type { AuditEvent, BackgroundJob, BatchMetadataPatch, BibliographyProbeResponse, BibliographySearchResult, BibliographySource, BibliographySourceInput, BookDetail, BookFile, CalibreImportResult, CalibrePreview, CatalogPage, CatalogQuery, Category, ClassificationRule, DeviceToken, DuplicateCatalogGroup, FavoritePage, FavoriteState, HomeDashboard, ImportJob, ImportSource, ManagedUser, ReadingMark, ReadingMarkInput, ReadingSession, ReadingState, RecommendationPage, ReviewInput, ReviewItem, Role, Session, StorageAuditReport, User, UserAccessInfo } from './types'

interface ErrorBody {
  error?: { code?: string; message?: string }
}

interface UploadBookResult {
  bookFile: BookFile
  duplicate: boolean
  importJobId: number
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

  async listDeviceTokens(): Promise<DeviceToken[]> {
    const result = await this.request<{ items: DeviceToken[] }>('/api/v1/device-tokens')
    return result.items
  }

  createDeviceToken(name: string, expiresDays: number): Promise<DeviceToken> {
    return this.request('/api/v1/device-tokens', {
      method: 'POST', body: JSON.stringify({ name, expiresDays }), headers: { 'Content-Type': 'application/json' },
    })
  }

  revokeDeviceToken(tokenID: number): Promise<void> {
    return this.request(`/api/v1/device-tokens/${tokenID}`, { method: 'DELETE' })
  }

  getHomeDashboard(): Promise<HomeDashboard> {
    return this.request('/api/v1/home')
  }

  listBooks(query: CatalogQuery = {}): Promise<CatalogPage> {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value))
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : ''
    return this.request(`/api/v1/book-files${suffix}`)
  }

  getBookDetail(bookFileID: number): Promise<BookDetail> {
    return this.request(`/api/v1/book-files/${bookFileID}`)
  }

  listFavorites(page = 1, pageSize = 24): Promise<FavoritePage> {
    return this.request(`/api/v1/favorites?page=${page}&pageSize=${pageSize}`)
  }

  setFavorite(bookFileID: number, favorite: boolean): Promise<FavoriteState> {
    return this.request(`/api/v1/book-files/${bookFileID}/favorite`, { method: favorite ? 'PUT' : 'DELETE' })
  }

  getRecommendations(limit = 12): Promise<RecommendationPage> {
    return this.request(`/api/v1/recommendations?limit=${limit}`)
  }

  uploadBook(file: File, onProgress?: (progress: number) => void): Promise<UploadBookResult> {
    return new Promise((resolve, reject) => {
      const form = new FormData()
      form.append('file', file)
      const request = new XMLHttpRequest()
      request.open('POST', '/api/v1/book-files')
      request.withCredentials = true
      if (this.csrfToken) request.setRequestHeader('X-CSRF-Token', this.csrfToken)
      request.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress?.(Math.min(99, Math.round((event.loaded / event.total) * 100)))
      })
      request.upload.addEventListener('load', () => onProgress?.(100))
      request.addEventListener('load', () => {
        let body: UploadBookResult | ErrorBody | null = null
        try {
          body = JSON.parse(request.responseText) as UploadBookResult | ErrorBody
        } catch {
          // A proxy may return a non-JSON error page.
        }
        if (request.status >= 200 && request.status < 300 && body && 'bookFile' in body) {
          resolve(body)
          return
        }
        const error = body && 'error' in body ? body.error : undefined
        reject(new APIError(request.status, error?.code ?? 'request_failed', error?.message ?? `Request failed (${request.status})`))
      })
      request.addEventListener('error', () => reject(new APIError(0, 'network_error', '上传连接中断。')))
      request.addEventListener('abort', () => reject(new APIError(0, 'upload_aborted', '上传已取消。')))
      request.send(form)
    })
  }

  async listCategories(): Promise<Category[]> {
    const result = await this.request<{ items: Category[] }>('/api/v1/categories')
    return result.items
  }

  async listAdminCategories(): Promise<Category[]> {
    const result = await this.request<{ items: Category[] }>('/api/v1/admin/categories')
    return result.items
  }

  createCategory(input: { slug: string; name: string; parentId?: number }): Promise<Category> {
    return this.request('/api/v1/admin/categories', {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  updateCategory(categoryID: number, input: { name: string; parentId?: number; active: boolean }): Promise<Category> {
    return this.request(`/api/v1/admin/categories/${categoryID}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...input, parentId: input.parentId ?? null }),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  async listClassificationRules(): Promise<ClassificationRule[]> {
    const result = await this.request<{ items: ClassificationRule[] }>('/api/v1/admin/classification-rules')
    return result.items
  }

  updateClassificationRule(ruleID: number, input: Pick<ClassificationRule, 'keywords' | 'enabled' | 'priority'>): Promise<ClassificationRule> {
    return this.request(`/api/v1/admin/classification-rules/${ruleID}`, {
      method: 'PATCH', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' },
    })
  }

  batchUpdateMetadata(input: BatchMetadataPatch): Promise<{ updated: number }> {
    return this.request('/api/v1/admin/metadata/batch', {
      method: 'PATCH', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' },
    })
  }

  async listDuplicateCatalogGroups(): Promise<DuplicateCatalogGroup[]> {
    const result = await this.request<{ items: DuplicateCatalogGroup[] }>('/api/v1/admin/catalog/duplicates')
    return result.items
  }

  mergeWorks(sourceId: number, targetId: number): Promise<void> {
    return this.request('/api/v1/admin/catalog/merge-works', {
      method: 'POST', body: JSON.stringify({ sourceId, targetId }), headers: { 'Content-Type': 'application/json' },
    })
  }

  mergeEditions(sourceId: number, targetId: number): Promise<void> {
    return this.request('/api/v1/admin/catalog/merge-editions', {
      method: 'POST', body: JSON.stringify({ sourceId, targetId }), headers: { 'Content-Type': 'application/json' },
    })
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

  searchBibliography(editionID: number): Promise<BibliographySearchResult> {
    return this.request(`/api/v1/editions/${editionID}/bibliography-search`, { method: 'POST' })
  }

  async listBibliographySources(): Promise<BibliographySource[]> {
    const result = await this.request<{ items: BibliographySource[] }>('/api/v1/admin/bibliography-sources')
    return result.items
  }

  updateBibliographySource(sourceID: number, input: BibliographySourceInput): Promise<BibliographySource> {
    return this.request(`/api/v1/admin/bibliography-sources/${sourceID}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  testBibliographySource(sourceID: number): Promise<BibliographyProbeResponse> {
    return this.request(`/api/v1/admin/bibliography-sources/${sourceID}/test`, { method: 'POST' })
  }

  async listImportJobs(): Promise<ImportJob[]> {
    const result = await this.request<{ items: ImportJob[] }>('/api/v1/import-jobs')
    return result.items
  }

  async listImportSources(): Promise<ImportSource[]> {
    const result = await this.request<{ items: ImportSource[] }>('/api/v1/admin/import-sources')
    return result.items
  }

  async listBackgroundJobs(): Promise<BackgroundJob[]> {
    const result = await this.request<{ items: BackgroundJob[] }>('/api/v1/background-jobs')
    return result.items
  }

  async listAuditEvents(): Promise<AuditEvent[]> {
    const result = await this.request<{ items: AuditEvent[] }>('/api/v1/audit-events')
    return result.items
  }

  auditStorage(deep = false): Promise<StorageAuditReport> {
    return this.request(`/api/v1/system/storage${deep ? '?deep=true' : ''}`)
  }

  retryBackgroundJob(jobID: number): Promise<BackgroundJob> {
    return this.request(`/api/v1/background-jobs/${jobID}/retry`, { method: 'POST' })
  }

  regeneratePDFCover(bookFileID: number, pageNumber: number): Promise<{ job: BackgroundJob; created: boolean }> {
    return this.request(`/api/v1/book-files/${bookFileID}/cover/regenerate`, {
      method: 'POST',
      body: JSON.stringify({ pageNumber }),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  previewCalibre(): Promise<CalibrePreview> {
    return this.request('/api/v1/calibre/preview')
  }

  importCalibre(sourcePaths: string[] = []): Promise<CalibreImportResult> {
    return this.request('/api/v1/calibre/import', {
      method: 'POST',
      body: JSON.stringify({ sourcePaths }),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  async listUsers(): Promise<ManagedUser[]> {
    const result = await this.request<{ items: ManagedUser[] }>('/api/v1/users')
    return result.items
  }

  async createUser(username: string, password: string, role: 'admin' | 'reader'): Promise<User> {
    return this.request('/api/v1/users', {
      method: 'POST',
      body: JSON.stringify({ username, password, role }),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  updateUser(userID: number, input: { username: string; role: Role; disabled: boolean }): Promise<ManagedUser> {
    return this.request(`/api/v1/users/${userID}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  getUserAccess(userID: number): Promise<UserAccessInfo> {
    return this.request(`/api/v1/users/${userID}/access`)
  }

  resetUserPassword(userID: number, password: string): Promise<void> {
    return this.request(`/api/v1/users/${userID}/password`, {
      method: 'POST',
      body: JSON.stringify({ password }),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  revokeUserSessions(userID: number): Promise<void> {
    return this.request(`/api/v1/users/${userID}/sessions`, { method: 'DELETE' })
  }

  revokeUserSession(userID: number, sessionID: number): Promise<void> {
    return this.request(`/api/v1/users/${userID}/sessions/${sessionID}`, { method: 'DELETE' })
  }

  deleteUser(userID: number): Promise<void> {
    return this.request(`/api/v1/users/${userID}`, { method: 'DELETE' })
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

  async listReadingMarks(bookFileID: number): Promise<ReadingMark[]> {
    const result = await this.request<{ items: ReadingMark[] }>(`/api/v1/book-files/${bookFileID}/marks`)
    return result.items
  }

  createReadingMark(bookFileID: number, input: ReadingMarkInput): Promise<ReadingMark> {
    return this.request(`/api/v1/book-files/${bookFileID}/marks`, {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  updateReadingMark(markID: number, input: Pick<ReadingMark, 'label' | 'body'>): Promise<ReadingMark> {
    return this.request(`/api/v1/reading-marks/${markID}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  deleteReadingMark(markID: number): Promise<void> {
    return this.request(`/api/v1/reading-marks/${markID}`, { method: 'DELETE' })
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

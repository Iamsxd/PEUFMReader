import type { BackgroundJob, BookDetail, BookFile, CatalogPage, CatalogQuery, Category, FavoritePage, FavoriteState, HomeDashboard, RecommendationFeedback, RecommendationFeedbackValue, RecommendationPage } from '../types'
import { APIError, querySuffix, transport } from './core'

interface ErrorBody { error?: { code?: string; message?: string } }
export interface UploadBookResult { bookFile: BookFile; duplicate: boolean; importJobId: number }

export const catalogAPI = {
  getHomeDashboard(): Promise<HomeDashboard> {
    return transport.request('/api/v1/home')
  },

  listBooks(query: CatalogQuery = {}): Promise<CatalogPage> {
    return transport.request(`/api/v1/book-files${querySuffix(query)}`)
  },

  getBookDetail(bookFileID: number): Promise<BookDetail> {
    return transport.request(`/api/v1/book-files/${bookFileID}`)
  },

  listFavorites(page = 1, pageSize = 24): Promise<FavoritePage> {
    return transport.request(`/api/v1/favorites?page=${page}&pageSize=${pageSize}`)
  },

  setFavorite(bookFileID: number, favorite: boolean): Promise<FavoriteState> {
    return transport.request(`/api/v1/book-files/${bookFileID}/favorite`, { method: favorite ? 'PUT' : 'DELETE' })
  },

  getRecommendations(limit = 12): Promise<RecommendationPage> {
    return transport.request(`/api/v1/recommendations?limit=${limit}`)
  },

  setRecommendationFeedback(bookFileID: number, feedback: RecommendationFeedbackValue): Promise<RecommendationFeedback> {
    return transport.request(`/api/v1/book-files/${bookFileID}/recommendation-feedback`, { method: 'PUT', body: JSON.stringify({ feedback }), headers: { 'Content-Type': 'application/json' } })
  },

  uploadBook(file: File, onProgress?: (progress: number) => void): Promise<UploadBookResult> {
    return new Promise((resolve, reject) => {
      const form = new FormData()
      form.append('file', file)
      const request = new XMLHttpRequest()
      request.open('POST', '/api/v1/book-files')
      request.withCredentials = true
      if (transport.getCSRFToken()) request.setRequestHeader('X-CSRF-Token', transport.getCSRFToken())
      request.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress?.(Math.min(99, Math.round((event.loaded / event.total) * 100)))
      })
      request.upload.addEventListener('load', () => onProgress?.(100))
      request.addEventListener('load', () => {
        let body: UploadBookResult | ErrorBody | null = null
        try { body = JSON.parse(request.responseText) as UploadBookResult | ErrorBody } catch { /* proxy may return HTML */ }
        if (request.status >= 200 && request.status < 300 && body && 'bookFile' in body) { resolve(body); return }
        const error = body && 'error' in body ? body.error : undefined
        reject(new APIError(request.status, error?.code ?? 'request_failed', error?.message ?? `Request failed (${request.status})`))
      })
      request.addEventListener('error', () => reject(new APIError(0, 'network_error', '上传连接中断。')))
      request.addEventListener('abort', () => reject(new APIError(0, 'upload_aborted', '上传已取消。')))
      request.send(form)
    })
  },

  async listCategories(): Promise<Category[]> {
    const result = await transport.request<{ items: Category[] }>('/api/v1/categories')
    return result.items
  },

  regeneratePDFCover(bookFileID: number, pageNumber: number): Promise<{ job: BackgroundJob; created: boolean }> {
    return transport.request(`/api/v1/book-files/${bookFileID}/cover/regenerate`, { method: 'POST', body: JSON.stringify({ pageNumber }), headers: { 'Content-Type': 'application/json' } })
  },
}

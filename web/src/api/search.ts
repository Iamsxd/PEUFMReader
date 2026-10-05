import type { TextIndexStatus, TextSearchPage } from '../types'
import { querySuffix, transport } from './core'
export const searchAPI = {
  searchText(q: string, page = 1): Promise<TextSearchPage> { return transport.request(`/api/v1/search/text${querySuffix({ q, page })}`) },
  textIndexStatus(): Promise<TextIndexStatus> { return transport.request('/api/v1/search/index') },
  buildTextIndex(): Promise<{ queued: number }> { return transport.request('/api/v1/admin/search/index', { method: 'POST' }) },
}

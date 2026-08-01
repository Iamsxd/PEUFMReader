import type { BookFormat } from './catalog'

export interface ClassificationRule {
  id: number
  categoryId: number
  categorySlug: string
  categoryName: string
  keywords: string[]
  strongKeywords: string[]
  enabled: boolean
  priority: number
  customized: boolean
  defaultVersion: number
  updatedAt: string
}

export interface BatchMetadataPatch {
  editionIds: number[]
  language?: string
  publisher?: string
  publishedYear?: number
  categorySlugs?: string[]
  categoryMode?: 'add' | 'replace'
}

export interface DuplicateCatalogItem { workId: number; editionId: number; bookFileId: number; title: string; isbn?: string; format: BookFormat; originalFilename: string }
export interface DuplicateCatalogGroup { kind: 'title' | 'isbn'; key: string; items: DuplicateCatalogItem[] }

export interface MetadataCandidate {
  id: number
  fieldName: string
  value: unknown
  source: string
  confidence: number
  reason: string
  status: 'suggested' | 'accepted' | 'rejected' | 'superseded'
}

export interface ClassificationDecision {
  id: number
  categoryId: number
  categorySlug: string
  categoryName: string
  source: string
  confidence: number
  reason: string
  status: 'suggested' | 'accepted' | 'rejected'
}

export interface ReviewItem {
  editionId: number
  workId: number
  bookFileId: number
  title: string
  authors: string[]
  publishedYear?: number
  language?: string
  isbn?: string
  publisher?: string
  description?: string
  sourceSubjects: string[]
  candidates: MetadataCandidate[]
  classifications: ClassificationDecision[]
}

export interface ReviewQueueQuery { q?: string; format?: '' | BookFormat; reason?: '' | 'metadata' | 'classification'; sort?: 'oldest' | 'newest' | 'title'; page?: number; pageSize?: number }
export interface ReviewQueueSummary { editionId: number; workId: number; bookFileId: number; title: string; authors: string[]; format: BookFormat; originalFilename: string; metadataPending: boolean; candidateCount: number; suggestedClassificationCount: number; updatedAt: string }
export interface ReviewQueuePage { items: ReviewQueueSummary[]; total: number; page: number; pageSize: number; totalPages: number }
export interface ReviewInput { title: string; authors: string[]; publishedYear?: number; language: string; isbn: string; publisher: string; description: string; categorySlugs: string[] }

export interface ImportJob { id: number; state: 'queued' | 'running' | 'completed' | 'failed'; sourceName: string; errorMessage?: string; bookFileId?: number; warnings: string[]; createdAt: string; updatedAt: string }
export interface ImportSource { id: 'browser-upload' | 'moving-inbox' | 'watched-library' | string; name: string; mode: 'upload' | 'move' | 'copy' | string; enabled: boolean; path?: string; scanIntervalSeconds?: number; stableAgeSeconds?: number; maxFileBytes?: number }

export interface BackgroundJob {
  id: number
  kind: string
  state: 'queued' | 'running' | 'completed' | 'failed'
  dedupeKey: string
  payload: Record<string, unknown>
  result: Record<string, unknown>
  progress: number
  progressMessage?: string
  attempts: number
  maxAttempts: number
  availableAt: string
  leaseExpiresAt?: string
  lastError?: string
  bookFileId?: number
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface AuditEvent { id: number; actorId?: number; actorName: string; action: string; clientIp: string; statusCode: number; details: Record<string, unknown>; createdAt: string }
export interface StorageIssue { bookFileId?: number; path: string; issue: 'missing' | 'size_mismatch' | 'checksum_mismatch' | 'unsafe_path' | 'orphaned' | string }
export interface StorageAuditReport { checkedAt: string; deep: boolean; databaseFileCount: number; diskFileCount: number; expectedBytes: number; actualBytes: number; missingCount: number; mismatchCount: number; orphanCount: number; issues: StorageIssue[] }

export interface CalibreRecord { sourcePath: string; metadataPath: string; coverPath?: string; title: string; authors: string[]; publishedYear?: number; language?: string; isbn?: string; publisher?: string; description?: string; subjects: string[]; format: BookFormat }
export interface CalibrePreview { configured: boolean; rootLabel: string; books: CalibreRecord[]; total: number; pdfCount: number; epubCount: number; mobiCount: number; azw3Count: number; errors: string[] }
export interface CalibreImportResult { queued: number; existing: number; jobIds: number[] }

export interface BibliographyMatch { source: 'openlibrary' | 'google-books' | string; sourceId: string; title: string; authors: string[]; publishedYear?: number; language?: string; isbn?: string; publisher?: string; description?: string; subjects: string[]; coverUrl?: string; confidence: number; reason: string }
export interface BibliographySearchResult { matches: BibliographyMatch[]; warnings: string[]; reviewItem: ReviewItem }
export interface BibliographySource { id: number; provider: 'douban' | 'openlibrary' | 'google-books' | string; enabled: boolean; baseUrl: string; priority: number; timeoutMs: number; maxResults: number; autoSearch: boolean; lastCheckedAt?: string; lastSuccessAt?: string; lastLatencyMs?: number; lastError?: string; updatedAt: string }
export interface BibliographySourceInput { enabled: boolean; baseUrl: string; priority: number; timeoutMs: number; maxResults: number; autoSearch: boolean }
export interface BibliographyProbeResult { success: boolean; latencyMs: number; error?: string }
export interface BibliographyProbeResponse { result: BibliographyProbeResult; source: BibliographySource }

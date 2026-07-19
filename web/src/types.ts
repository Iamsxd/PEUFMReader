export type Role = 'admin' | 'reader'

export interface User {
  id: number
  username: string
  role: Role
}

export interface Session {
  user: User
  csrfToken: string
}

export interface BookFile {
  id: number
  workId: number
  editionId: number
  title: string
  authors: string[]
  publishedYear?: number
  language?: string
  isbn?: string
  publisher?: string
  categories: Category[]
  reviewRequired: boolean
  coverUrl?: string
  originalFilename: string
  format: 'pdf' | 'epub'
  mimeType: string
  sizeBytes: number
  createdAt: string
}

export interface Category {
  id: number
  slug: string
  name: string
}

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

export interface ReviewInput {
  title: string
  authors: string[]
  publishedYear?: number
  language: string
  isbn: string
  publisher: string
  description: string
  categorySlugs: string[]
}

export interface ImportJob {
  id: number
  state: 'queued' | 'running' | 'completed' | 'failed'
  sourceName: string
  errorMessage?: string
  bookFileId?: number
  warnings: string[]
  createdAt: string
  updatedAt: string
}

export interface ReadingState {
  bookFileId: number
  position: Record<string, unknown>
  overallProgress: number
  status: 'unread' | 'reading' | 'finished' | 'paused' | 'abandoned'
  totalActiveSeconds: number
  updatedAt?: string
}

export interface ReadingSession {
  id: number
  bookFileId: number
  startedAt: string
  lastHeartbeatAt: string
  endedAt?: string
  activeSeconds: number
}

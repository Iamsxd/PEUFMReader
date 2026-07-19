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
  textUrl?: string
  textAvailable: boolean
  textExtractionMethod?: 'embedded' | 'ocr'
  pageCount?: number
  originalFilename: string
  format: 'pdf' | 'epub'
  mimeType: string
  sizeBytes: number
  createdAt: string
}

export interface CatalogQuery {
  q?: string
  category?: string
  format?: '' | 'pdf' | 'epub'
  status?: '' | 'unread' | 'reading' | 'paused' | 'finished' | 'abandoned'
  sort?: 'relevance' | 'title' | 'newest' | 'hot'
  page?: number
  pageSize?: number
}

export interface CatalogPage {
  items: BookFile[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export interface HomeBook {
  book: BookFile
  overallProgress?: number
  status?: ReadingState['status']
  totalActiveSeconds?: number
  lastReadAt?: string
  readerCount?: number
  sessionCount?: number
  heatScore?: number
}

export interface CategorySummary extends Category {
  bookCount: number
  coverUrls: string[]
}

export interface PersonalStats {
  totalBooks: number
  readingBooks: number
  finishedBooks: number
  favoriteBooks: number
  totalActiveSeconds: number
  weekActiveSeconds: number
}

export interface HomeDashboard {
  continueReading: HomeBook[]
  hotBooks: HomeBook[]
  recommendations: Recommendation[]
  recentlyAdded: BookFile[]
  categories: CategorySummary[]
  stats: PersonalStats
}

export interface BookDetail {
  book: BookFile
  description: string
  readingState: ReadingState
  favorite: boolean
  favoritedAt?: string
  readerCount: number
  favoriteCount: number
  totalActiveSeconds: number
}

export interface FavoriteState {
  bookFileId: number
  favorite: boolean
  createdAt?: string
}

export interface FavoriteBook {
  book: BookFile
  favoritedAt: string
}

export interface FavoritePage {
  items: FavoriteBook[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export interface Recommendation {
  book: BookFile
  reason: string
  score: number
  personalized: boolean
}

export interface RecommendationPage {
  items: Recommendation[]
  personalized: boolean
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

export interface BackgroundJob {
  id: number
  kind: string
  state: 'queued' | 'running' | 'completed' | 'failed'
  dedupeKey: string
  payload: Record<string, unknown>
  result: Record<string, unknown>
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

export interface CalibreRecord {
  sourcePath: string
  metadataPath: string
  coverPath?: string
  title: string
  authors: string[]
  publishedYear?: number
  language?: string
  isbn?: string
  publisher?: string
  description?: string
  subjects: string[]
  format: 'pdf' | 'epub'
}

export interface CalibrePreview {
  configured: boolean
  rootLabel: string
  books: CalibreRecord[]
  total: number
  pdfCount: number
  epubCount: number
  errors: string[]
}

export interface CalibreImportResult {
  queued: number
  existing: number
  jobIds: number[]
}

export interface BibliographyMatch {
  source: 'openlibrary' | 'google-books' | string
  sourceId: string
  title: string
  authors: string[]
  publishedYear?: number
  language?: string
  isbn?: string
  publisher?: string
  description?: string
  subjects: string[]
  coverUrl?: string
  confidence: number
  reason: string
}

export interface BibliographySearchResult {
  matches: BibliographyMatch[]
  warnings: string[]
  reviewItem: ReviewItem
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

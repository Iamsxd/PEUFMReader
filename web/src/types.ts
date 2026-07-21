export type Role = 'admin' | 'reader'
export type BookFormat = 'pdf' | 'epub' | 'mobi' | 'azw3'

export interface User {
  id: number
  username: string
  role: Role
}

export interface ManagedUser extends User {
  createdAt: string
  disabledAt?: string
  lastLoginAt?: string
  lastLoginIp: string
  lastSeenAt?: string
  activeSessionCount: number
  readingBookCount: number
  totalActiveSeconds: number
}

export interface UserSessionInfo {
  id: number
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  clientIp: string
  userAgent: string
  current: boolean
}

export interface UserLoginEvent {
  createdAt: string
  clientIp: string
  statusCode: number
}

export interface UserAccessInfo {
  sessions: UserSessionInfo[]
  recentLogins: UserLoginEvent[]
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
  format: BookFormat
  mimeType: string
  sizeBytes: number
  createdAt: string
}

export interface CatalogQuery {
  q?: string
  category?: string
  format?: '' | BookFormat
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
  parentId?: number
  parentName?: string
  active?: boolean
  system?: boolean
  bookCount?: number
}

export interface ClassificationRule {
  id: number
  categoryId: number
  categorySlug: string
  categoryName: string
  keywords: string[]
  enabled: boolean
  priority: number
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

export interface DuplicateCatalogItem {
  workId: number
  editionId: number
  bookFileId: number
  title: string
  isbn?: string
  format: BookFormat
  originalFilename: string
}

export interface DuplicateCatalogGroup {
  kind: 'title' | 'isbn'
  key: string
  items: DuplicateCatalogItem[]
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

export interface ImportSource {
  id: 'browser-upload' | 'moving-inbox' | 'watched-library' | string
  name: string
  mode: 'upload' | 'move' | 'copy' | string
  enabled: boolean
  path?: string
  scanIntervalSeconds?: number
  stableAgeSeconds?: number
  maxFileBytes?: number
}

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

export interface AuditEvent {
  id: number
  actorId?: number
  actorName: string
  action: string
  clientIp: string
  statusCode: number
  details: Record<string, unknown>
  createdAt: string
}

export interface StorageIssue {
  bookFileId?: number
  path: string
  issue: 'missing' | 'size_mismatch' | 'checksum_mismatch' | 'unsafe_path' | 'orphaned' | string
}

export interface StorageAuditReport {
  checkedAt: string
  deep: boolean
  databaseFileCount: number
  diskFileCount: number
  expectedBytes: number
  actualBytes: number
  missingCount: number
  mismatchCount: number
  orphanCount: number
  issues: StorageIssue[]
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
  format: BookFormat
}

export interface CalibrePreview {
  configured: boolean
  rootLabel: string
  books: CalibreRecord[]
  total: number
  pdfCount: number
  epubCount: number
  mobiCount: number
  azw3Count: number
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

export interface BibliographySource {
  id: number
  provider: 'douban' | 'openlibrary' | 'google-books' | string
  enabled: boolean
  baseUrl: string
  priority: number
  timeoutMs: number
  maxResults: number
  autoSearch: boolean
  lastCheckedAt?: string
  lastSuccessAt?: string
  lastLatencyMs?: number
  lastError?: string
  updatedAt: string
}

export interface BibliographySourceInput {
  enabled: boolean
  baseUrl: string
  priority: number
  timeoutMs: number
  maxResults: number
  autoSearch: boolean
}

export interface BibliographyProbeResult {
  success: boolean
  latencyMs: number
  error?: string
}

export interface BibliographyProbeResponse {
  result: BibliographyProbeResult
  source: BibliographySource
}

export interface ReadingState {
  bookFileId: number
  position: Record<string, unknown>
  overallProgress: number
  status: 'unread' | 'reading' | 'finished' | 'paused' | 'abandoned'
  totalActiveSeconds: number
  updatedAt?: string
}

export type ReadingMarkKind = 'bookmark' | 'note'

export interface ReadingMark {
  id: number
  bookFileId: number
  kind: ReadingMarkKind
  position: Record<string, unknown>
  overallProgress: number
  label: string
  body: string
  createdAt: string
  updatedAt: string
}

export interface ReadingMarkInput {
  kind: ReadingMarkKind
  position: Record<string, unknown>
  overallProgress: number
  label: string
  body: string
}

export interface ReadingSession {
  id: number
  bookFileId: number
  startedAt: string
  lastHeartbeatAt: string
  endedAt?: string
  activeSeconds: number
}

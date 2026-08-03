import type { ReadingState } from './reading'

export type BookFormat = 'pdf' | 'epub' | 'mobi' | 'azw3'

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
  storageMode: 'managed' | 'calibre-reference'
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

export interface DailyReadingActivity { date: string; activeSeconds: number }
export interface ReadingFormatBreakdown { format: BookFormat; bookCount: number; activeSeconds: number }
export interface ReadingCategoryBreakdown { id: number; slug: string; name: string; bookCount: number; activeSeconds: number }
export interface FinishedReadingBook { book: BookFile; finishedAt: string; totalActiveSeconds: number }
export interface ReadingStatistics {
  generatedAt: string
  windowDays: number
  todayActiveSeconds: number
  weekActiveSeconds: number
  monthActiveSeconds: number
  totalActiveSeconds: number
  trackedBooks: number
  readingBooks: number
  finishedBooks: number
  completedLast30Days: number
  currentStreakDays: number
  longestStreakDays: number
  dailyActivity: DailyReadingActivity[]
  formats: ReadingFormatBreakdown[]
  categories: ReadingCategoryBreakdown[]
  recentlyFinished: FinishedReadingBook[]
}

export interface HomeDashboard {
  continueReading: HomeBook[]
  hotBooks: HomeBook[]
  recommendations: Recommendation[]
  recentlyAdded: BookFile[]
  categories: CategorySummary[]
  stats: PersonalStats
}

export interface HomeSummary {
  continueReading: HomeBook[]
  recentlyAdded: BookFile[]
  stats: PersonalStats
}

export interface HomeBookSection { items: HomeBook[] }
export interface HomeCategorySection { items: CategorySummary[] }

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

export interface FavoriteState { bookFileId: number; favorite: boolean; createdAt?: string }
export interface FavoriteBook { book: BookFile; favoritedAt: string }
export interface FavoritePage { items: FavoriteBook[]; total: number; page: number; pageSize: number; totalPages: number }

export interface Recommendation {
  book: BookFile
  reason: string
  score: number
  personalized: boolean
  feedback?: RecommendationFeedbackValue
  signals: string[]
}

export type RecommendationFeedbackValue = 'interested' | 'not_interested'
export interface RecommendationFeedback { bookFileId: number; feedback: RecommendationFeedbackValue; updatedAt: string }
export interface RecommendationPage { items: Recommendation[]; personalized: boolean }

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

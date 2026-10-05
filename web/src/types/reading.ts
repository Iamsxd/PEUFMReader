export interface ReadingState {
  bookFileId: number
  position: Record<string, unknown>
  overallProgress: number
  status: 'unread' | 'reading' | 'finished' | 'paused' | 'abandoned'
  totalActiveSeconds: number
  updatedAt?: string
}

export type ReadingMarkKind = 'bookmark' | 'note' | 'highlight'
export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple'

export interface ReadingMark {
  id: number
  bookFileId: number
  kind: ReadingMarkKind
  position: Record<string, unknown>
  overallProgress: number
  label: string
  body: string
  quote: string
  color: '' | HighlightColor
  createdAt: string
  updatedAt: string
}

export interface ReadingMarkInput {
  kind: ReadingMarkKind
  position: Record<string, unknown>
  overallProgress: number
  label: string
  body: string
  quote?: string
  color?: HighlightColor
}

export interface ReadingSession {
  id: number
  bookFileId: number
  startedAt: string
  lastHeartbeatAt: string
  endedAt?: string
  activeSeconds: number
}

export interface NotebookEntry extends ReadingMark {
  bookTitle: string
  bookFormat: string
}
export interface NotebookQuery {
  q?: string
  kind?: '' | ReadingMarkKind
  color?: '' | HighlightColor
  bookId?: number
  page?: number
}
export interface NotebookPage {
  items: NotebookEntry[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}
export interface PersonalShelf {
  id: number
  name: string
  description: string
  bookCount: number
  containsBook: boolean
  createdAt: string
  kind?: 'manual' | 'smart'
  rules?: SmartShelfRules
}
export interface SmartShelfRules {
  format: string
  status: string
  favorite: boolean
  categorySlug: string
}

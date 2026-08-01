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

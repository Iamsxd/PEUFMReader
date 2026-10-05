export interface TextSearchHit {
  bookFileId: number
  bookTitle: string
  bookFormat: string
  label: string
  position: Record<string, unknown>
  excerpt: string
  coverage: string
}
export interface TextSearchPage { items: TextSearchHit[]; page: number; hasMore: boolean }
export interface TextIndexStatus { eligibleBooks: number; indexedBooks: number; passageCount: number }

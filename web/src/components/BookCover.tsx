import { useState } from 'react'
import type { BookFile } from '../types'
import { coverThumbnailURL } from '../utils'

/** An intact cover, or a local typographic jacket when a cover is unavailable. */
export function BookCover({ book, featured = false }: { book: BookFile; featured?: boolean }) {
  const [failedURL, setFailedURL] = useState<string>()
  const hasCover = book.coverUrl && failedURL !== book.coverUrl
  return <span className={`book-jacket jacket-tone-${book.id % 4}${featured ? ' featured-jacket' : ''}`} aria-hidden="true">
    {hasCover ? <img className="book-cover" src={coverThumbnailURL(book.coverUrl!, 320)} srcSet={`${coverThumbnailURL(book.coverUrl!, 240)} 240w, ${coverThumbnailURL(book.coverUrl!, 320)} 320w, ${coverThumbnailURL(book.coverUrl!, 480)} 480w`} sizes={featured ? '(max-width: 720px) 150px, 200px' : '(max-width: 720px) 40vw, 200px'} alt="" loading={featured ? 'eager' : 'lazy'} decoding="async" onError={() => setFailedURL(book.coverUrl)} /> : <span className="cover-placeholder"><span className={`jacket-title${book.title.length <= 7 ? ' short-title' : ''}`}>{book.title}</span><span className="jacket-author">{book.authors.join('、') || book.format.toUpperCase()}</span></span>}
  </span>
}

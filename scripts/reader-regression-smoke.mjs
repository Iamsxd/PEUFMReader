const baseURL = (process.env.BASE_URL || process.env.E2E_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '')
const username = process.env.READER_REGRESSION_USERNAME || process.env.E2E_READER_USERNAME
const password = process.env.READER_REGRESSION_PASSWORD || process.env.E2E_READER_PASSWORD
const maxPerFormat = positiveInteger(process.env.E2E_READER_MAX_PER_FORMAT, 2)
const explicitIDs = parseIDs(process.env.E2E_READER_CORPUS_IDS)
const includeKindle = process.env.READER_INCLUDE_KINDLE === 'true'

if (!username || !password) {
  throw new Error('Set READER_REGRESSION_USERNAME and READER_REGRESSION_PASSWORD to a dedicated read-only regression account.')
}

const login = await fetch(`${baseURL}/api/v1/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
})
if (!login.ok) throw new Error(`Login failed with HTTP ${login.status}`)
const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
if (!cookie) throw new Error('Login response did not include a session cookie')

const formats = includeKindle ? ['pdf', 'epub', 'mobi', 'azw3'] : ['pdf', 'epub']
const books = selectCorpus((await Promise.all(formats.map(listFormat))).flat())
if (books.length === 0) {
  throw new Error('No accessible PDF/EPUB books matched the regression corpus. Add books to the dedicated account or set E2E_READER_CORPUS_IDS.')
}

const results = []
for (const book of books) {
  const detail = await request(`/api/v1/book-files/${book.id}`)
  if (!detail.ok) throw new Error(`Book ${book.id} detail returned HTTP ${detail.status}`)

  const content = await request(`/api/v1/book-files/${book.id}/content`)
  if (!content.ok) throw new Error(`Book ${book.id} content returned HTTP ${content.status}`)
  const bytes = new Uint8Array(await content.arrayBuffer())
  verifyContent(book, content.headers.get('content-type') || '', bytes)

  const progress = await request(`/api/v1/book-files/${book.id}/progress`)
  if (!progress.ok) throw new Error(`Book ${book.id} progress returned HTTP ${progress.status}`)
  const state = await progress.json()
  if (state.bookFileId !== book.id || typeof state.overallProgress !== 'number') {
    throw new Error(`Book ${book.id} progress response is malformed`)
  }

  let extractedText = 'not-available'
  if (book.textAvailable) {
    const text = await request(`/api/v1/book-files/${book.id}/text`)
    if (!text.ok) throw new Error(`Book ${book.id} extracted text returned HTTP ${text.status}`)
    const body = await text.text()
    if (!body.trim()) throw new Error(`Book ${book.id} extracted text is empty`)
    extractedText = `${body.length} characters`
  }

  results.push({
    id: book.id, title: book.title, format: book.format, bytes: bytes.length,
    contentType: content.headers.get('content-type'), extractedText,
  })
}

console.log(JSON.stringify({ baseURL, formats, explicitIDs, maxPerFormat, results }, null, 2))

async function listFormat(format) {
  const response = await request(`/api/v1/book-files?format=${format}&page=1&pageSize=100&sort=title`)
  if (!response.ok) throw new Error(`Catalog ${format} returned HTTP ${response.status}`)
  const payload = await response.json()
  return payload.items || []
}

function selectCorpus(items) {
  const browserReadable = items.filter((item) => item.format === 'pdf' || item.format === 'epub')
  const candidates = includeKindle ? items : browserReadable
  if (explicitIDs.length > 0) {
    const byID = new Map(candidates.map((item) => [item.id, item]))
    return explicitIDs.flatMap((id) => byID.get(id) || [])
  }
  return formats.flatMap((format) => candidates.filter((item) => item.format === format).slice(0, maxPerFormat))
}

function verifyContent(book, contentType, bytes) {
  if (bytes.length < 5) throw new Error(`Book ${book.id} content is unexpectedly short`)
  const signature = new TextDecoder().decode(bytes.subarray(0, 5))
  if (book.format === 'pdf') {
    if (!contentType.includes('application/pdf') || signature !== '%PDF-') {
      throw new Error(`Book ${book.id} is not served as a valid PDF (${contentType})`)
    }
    return
  }
  const zipSignature = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
  if (!contentType.includes('application/epub+zip') || !zipSignature) {
    throw new Error(`Book ${book.id} is not served as an EPUB-compatible archive (${contentType})`)
  }
}

function parseIDs(value) {
  const seen = new Set()
  const result = []
  for (const part of (value || '').split(',')) {
    const id = Number(part.trim())
    if (!Number.isSafeInteger(id) || id < 1 || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function request(path) {
  return fetch(`${baseURL}${path}`, { headers: { Cookie: cookie } })
}

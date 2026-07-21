import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { parseReaderCorpusIDs, selectReaderCorpus } from '../src/readerRegression'
import type { BookFile, CatalogPage, ReadingState } from '../src/types'

const readerUsername = process.env.E2E_READER_USERNAME
const readerPassword = process.env.E2E_READER_PASSWORD
const maxPerFormat = positiveInteger(process.env.E2E_READER_MAX_PER_FORMAT, 2)
const explicitIDs = parseReaderCorpusIDs(process.env.E2E_READER_CORPUS_IDS)

test.describe('reader regression corpus', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!readerUsername || !readerPassword, 'Set E2E_READER_USERNAME and E2E_READER_PASSWORD to a dedicated regression account.')
    await page.goto('/')
    const loginButton = page.getByRole('button', { name: '登录' })
    if (!await loginButton.isVisible().catch(() => false)) return
    await page.getByLabel('用户名').fill(readerUsername!)
    await page.getByLabel('密码').fill(readerPassword!)
    await loginButton.click()
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
  })

  test('real PDF corpus renders early, middle and final pages without browser zoom', async ({ page }, testInfo) => {
    const corpus = await loadCorpus(page)
    const books = corpus.filter((book) => book.format === 'pdf')
    test.skip(books.length === 0, 'No accessible PDF in the configured reader corpus.')
    await attachCorpus(testInfo, books)

    for (const book of books) {
      await test.step(`PDF: ${book.title} (#${book.id})`, async () => {
        await openReader(page, book)
        const toolbar = page.getByRole('toolbar', { name: 'PDF 阅读工具' })
        await expect(toolbar).toBeVisible()
        const pageInput = page.getByLabel('当前页码')
        const pageCount = Number(await pageInput.getAttribute('max'))
        expect(pageCount).toBeGreaterThan(0)

        await expectPDFRendered(page, 1)
        await assertNoReaderError(page)

        await showReaderChrome(page, toolbar)
        const zoomValue = toolbar.locator('.reader-zoom-value')
        const initialZoom = await zoomValue.textContent()
        await page.locator('.pdf-reader-viewport').dispatchEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -120 })
        await expect(zoomValue).not.toHaveText(initialZoom ?? '')
        expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1)

        await toolbar.getByRole('button', { name: '连续滚动' }).click()
        await expect(page.locator('.pdf-pages')).toHaveClass(/continuous/)
        for (const target of samplePages(pageCount)) {
          await pageInput.fill(String(target))
          await expectPDFRendered(page, target)
          await assertNoReaderError(page)
        }

        await showReaderChrome(page, toolbar)
        await toolbar.getByRole('button', { name: '分页', exact: true }).click()
        await expect(page.locator('.pdf-pages')).toHaveClass(/paged/)
        if (pageCount > 1) {
          await pageInput.fill(String(pageCount))
          await expectPDFRendered(page, pageCount)
        }
        await expectPDFProgressSaved(page, book.id, pageCount)
        await page.getByRole('button', { name: '← 返回书库' }).click()
        await expect(page.getByRole('heading', { name: book.title, exact: true })).toBeVisible()
        await page.getByRole('button', { name: /开始阅读|继续阅读|重新阅读/ }).click()
        await expect(page.getByLabel('当前页码')).toHaveValue(String(pageCount))
      })
    }
  })

  test('real EPUB corpus keeps navigation, modes and typography interactive', async ({ page }, testInfo) => {
    const corpus = await loadCorpus(page)
    const books = corpus.filter((book) => book.format === 'epub')
    test.skip(books.length === 0, 'No accessible EPUB in the configured reader corpus.')
    await attachCorpus(testInfo, books)

    for (const book of books) {
      await test.step(`EPUB: ${book.title} (#${book.id})`, async () => {
        await openReader(page, book)
        const toolbar = page.getByRole('toolbar', { name: 'EPUB 阅读工具' })
        const host = page.locator('.epub-host')
        await expect(toolbar).toBeVisible()
        await expect(host).toHaveAttribute('aria-busy', 'false')
        await expect(host.locator('iframe')).toHaveCount(1)
        await assertNoReaderError(page)

        await showReaderChrome(page, toolbar)
        await toolbar.getByRole('button', { name: '连续滚动' }).click()
        await expect(toolbar.getByRole('button', { name: '连续滚动' })).toHaveAttribute('aria-pressed', 'true')
        await expect(toolbar.getByRole('button', { name: '双页书籍' })).toBeDisabled()

        await toolbar.getByRole('button', { name: '分页', exact: true }).click()
        await expect(toolbar.getByRole('button', { name: '分页', exact: true })).toHaveAttribute('aria-pressed', 'true')
        if (testInfo.project.name === 'desktop-chromium') {
          await toolbar.getByRole('button', { name: '双页书籍' }).click()
          await expect(toolbar.getByRole('button', { name: '双页书籍' })).toHaveAttribute('aria-pressed', 'true')
        }

        const fontValue = toolbar.locator('.reader-font-value')
        const initialFont = await fontValue.textContent()
        await toolbar.getByRole('button', { name: '放大字号' }).click()
        await expect(fontValue).not.toHaveText(initialFont ?? '')
        await toolbar.getByRole('button', { name: '夜间' }).click()
        await expect(page.locator('.epub-reader')).toHaveClass(/theme-night/)

        const next = page.getByRole('navigation', { name: 'EPUB 翻页' }).getByRole('button', { name: '下一页' })
        if (await next.isEnabled()) await next.click()
        await assertNoReaderError(page)
        await expectReadingStateSaved(page, book.id)
      })
    }
  })
})

async function loadCorpus(page: Page): Promise<BookFile[]> {
  const items = (await Promise.all(['pdf', 'epub'].map(async (format) => {
    const response = await page.request.get(`/api/v1/book-files?format=${format}&page=1&pageSize=100&sort=title`)
    expect(response.ok(), `catalog request for ${format} should succeed`).toBeTruthy()
    const payload = await response.json() as CatalogPage
    return payload.items
  }))).flat()
  return selectReaderCorpus(items, { explicitIDs, maxPerFormat })
}

async function openReader(page: Page, book: BookFile) {
  await page.goto(`/#/book/${book.id}`)
  await expect(page.getByRole('heading', { name: book.title, exact: true })).toBeVisible()
  await page.getByRole('button', { name: /开始阅读|继续阅读|重新阅读/ }).click()
}

async function expectPDFRendered(page: Page, pageNumber: number) {
  const shell = page.locator(`[data-pdf-page="${pageNumber}"]`)
  await expect(shell).toHaveClass(/rendered/)
  await expect(shell.locator('canvas')).toEvaluate((canvas) => canvas.width > 100 && canvas.height > 100)
}

async function expectPDFProgressSaved(page: Page, bookID: number, expectedPage: number) {
  await expect.poll(async () => {
    const response = await page.request.get(`/api/v1/book-files/${bookID}/progress`)
    if (!response.ok()) return false
    const state = await response.json() as ReadingState
    return Number(state.position.pageIndex) + 1 === expectedPage && state.overallProgress >= 0.999
  }).toBe(true)
}

async function expectReadingStateSaved(page: Page, bookID: number) {
  await expect.poll(async () => {
    const response = await page.request.get(`/api/v1/book-files/${bookID}/progress`)
    if (!response.ok()) return false
    const state = await response.json() as ReadingState
    return state.status !== 'unread' && Object.keys(state.position).length > 0
  }).toBe(true)
}

async function showReaderChrome(page: Page, toolbar: ReturnType<Page['getByRole']>) {
  await page.mouse.move(10, 10)
  await expect(toolbar).toBeVisible()
}

async function assertNoReaderError(page: Page) {
  await expect(page.locator('.pdf-error, .epub-error, .reader-shell > .notice.error')).toHaveCount(0)
}

async function attachCorpus(testInfo: TestInfo, books: BookFile[]) {
  await testInfo.attach('reader-corpus.json', {
    body: Buffer.from(JSON.stringify(books.map((book) => ({ id: book.id, title: book.title, format: book.format, sizeBytes: book.sizeBytes })), null, 2)),
    contentType: 'application/json',
  })
}

function samplePages(pageCount: number): number[] {
  return [...new Set([1, Math.ceil(pageCount / 2), pageCount])]
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

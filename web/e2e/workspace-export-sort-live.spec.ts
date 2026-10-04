import { expect, test, type Download, type Page } from '@playwright/test'
import type { BookFile, NotebookEntry, PersonalShelf, ReadingMark, ReadingMarkInput } from '../src/types'
import { minimalPDF } from './support/pdf'

// Opt in only for the disposable localhost instance created for this task.
// Both guards run before login/upload: never write to an existing NAS library.
test.use({ serviceWorkers: 'block' })

async function readDownload(download: Download) {
  const stream = await download.createReadStream()
  if (!stream) throw new Error('Scratch attachment stream unavailable')
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function expectOrder(page: Page, ids: number[]) {
  await expect.poll(() => page.locator('.shelf-book').evaluateAll((cards) => cards.map((element) => Number((element as HTMLElement).dataset.bookId)))).toEqual(ids)
}

async function dragFirstAfterThird(page: Page, firstID: number, thirdID: number, useTouch: boolean) {
  const source = page.locator(`.shelf-book[data-book-id="${firstID}"] .shelf-drag-handle`)
  const target = page.locator(`.shelf-book[data-book-id="${thirdID}"]`)
  await target.scrollIntoViewIfNeeded()
  await source.scrollIntoViewIfNeeded()
  await source.evaluate((element, targetBookID) => {
    const sourceCard = element.closest('.shelf-book')!
    const targetCard = document.querySelector(`.shelf-book[data-book-id="${targetBookID}"]`)!
    const sourceBounds = sourceCard.getBoundingClientRect()
    const targetBounds = targetCard.getBoundingClientRect()
    const navigation = document.querySelector('.library-sidebar')?.getBoundingClientRect()
    const safeTop = 110
    const safeBottom = navigation && navigation.width >= innerWidth * 0.8 && navigation.top > innerHeight / 2
      ? navigation.top - 16 : innerHeight - 16
    const top = Math.min(sourceBounds.top, targetBounds.top)
    const bottom = Math.max(sourceBounds.bottom, targetBounds.bottom)
    const centeredTop = safeTop + (safeBottom - safeTop - (bottom - top)) / 2
    window.scrollBy({ top: top - centeredTop, behavior: 'instant' })
  }, thirdID)
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  const start = { x: sourceBox!.x + sourceBox!.width / 2, y: sourceBox!.y + sourceBox!.height / 2 }
  const end = { x: targetBox!.x + targetBox!.width / 2, y: targetBox!.y + targetBox!.height * 0.75 }
  expect(await source.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), start)).toBe(true)
  expect(await target.evaluate((element, point) => document.elementFromPoint(point.x, point.y)?.closest('.shelf-book') === element, end)).toBe(true)
  const saving = page.waitForResponse((response) => /^\/api\/v1\/shelves\/\d+\/order$/.test(new URL(response.url()).pathname) && response.request().method() === 'PATCH')
  if (useTouch) {
    const touch = await page.context().newCDPSession(page)
    try {
      await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 7 }] })
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...end, id: 7 }] })
      await expect(target).toHaveClass(/drop-after/)
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } finally { await touch.detach() }
  } else {
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 5 })
    await expect(target).toHaveClass(/drop-after/)
    await page.mouse.up()
  }
  const response = await saving
  expect(response.status()).toBe(204)
  expect(response.request().postDataJSON()).toEqual({ bookId: firstID, targetBookId: thirdID, placement: 'after' })
}

async function downloadExport(page: Page, format: 'json' | 'markdown', keyword: string) {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === '/api/v1/notebook/export' && url.searchParams.get('format') === format
  })
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: format === 'json' ? '导出 JSON' : '导出 Markdown', exact: true }).click()
  const [response, download] = await Promise.all([responsePromise, downloadPromise])
  expect(response.status()).toBe(200)
  expect(response.headers()['cache-control']).toContain('private')
  expect(response.headers()['cache-control']).toContain('no-store')
  expect(response.headers()['x-content-type-options']).toBe('nosniff')
  expect(response.headers()['content-type']).toContain(format === 'json' ? 'application/json' : 'text/markdown')
  const query = new URL(response.url()).searchParams
  expect(query.get('q')).toBe(keyword)
  for (const field of ['bookId', 'page', 'pageSize']) expect(query.has(field)).toBe(false)
  expect(download.suggestedFilename()).toBe(format === 'json' ? 'notebook.json' : 'notebook.md')
  return readDownload(download)
}

test('scratch instance persists handle sorting and exports all matching cross-book records through the real UI', async ({ page, baseURL }, info) => {
  test.skip(process.env.E2E_WORKSPACE_SCRATCH !== '1', 'Requires a disposable workspace instance, not production.')
  expect(baseURL).toBe('http://127.0.0.1:5189')
  // Dedicated synthetic credentials must be passed explicitly; do not fall back
  // to the ordinary deployment ADMIN_USERNAME/ADMIN_PASSWORD settings.
  expect(Boolean(process.env.E2E_ADMIN_USERNAME && process.env.E2E_ADMIN_PASSWORD)).toBe(true)
  const useTouch = info.project.name === 'mobile-chromium'
  await page.setViewportSize(useTouch ? { width: 390, height: 1300 } : { width: 1280, height: 1200 })
  const auth = await page.request.post('/api/v1/auth/login', {
    data: { username: process.env.E2E_ADMIN_USERNAME, password: process.env.E2E_ADMIN_PASSWORD },
  })
  expect(auth.ok()).toBe(true)
  const { csrfToken } = await auth.json()
  const headers = { 'X-CSRF-Token': csrfToken }
  const key = `export-sort-${info.project.name}-${Date.now()}`
  const books: BookFile[] = []
  const marks: ReadingMark[] = []

  for (let index = 0; index < 3; index++) {
    const uploaded = await page.request.post('/api/v1/book-files', {
      headers,
      multipart: {
        file: {
          name: `${key}-${index + 1}.pdf`,
          mimeType: 'application/pdf',
          buffer: minimalPDF([
            `Original export sort book ${index + 1} page one ${key}`,
            `Original export sort book ${index + 1} page two ${key}`,
          ]),
        },
      },
    })
    expect(uploaded.ok()).toBe(true)
    const { bookFile: book } = await uploaded.json() as { bookFile: BookFile }
    books.push(book)
    const input: ReadingMarkInput = {
      kind: 'highlight',
      position: {
        pageIndex: index % 2,
        yRatio: (index + 1) / 10,
        rects: [{ x: 12 + index, y: 20, width: 40, height: 8 }],
      },
      overallProgress: (index + 1) / 4,
      label: `Original location ${index + 1}`,
      quote: `Original cross book quotation ${key} ${index + 1}`,
      body: `Original cross book note ${key} ${index + 1}`,
      color: 'green',
    }
    const saved = await page.request.post(`/api/v1/book-files/${book.id}/marks`, { headers, data: input })
    expect(saved.status()).toBe(201)
    const mark = await saved.json() as ReadingMark
    expect(mark).toMatchObject({ bookFileId: book.id, ...input })
    marks.push(mark)
  }
  expect(new Set(books.map((book) => book.id)).size).toBe(3)
  const created = await page.request.post('/api/v1/shelves', { headers, data: { name: key, description: 'Original scratch sorting and export verification' } })
  expect(created.status()).toBe(201)
  const shelf = await created.json() as PersonalShelf
  const bookIDs = books.map((book) => book.id)
  const batch = await page.request.post(`/api/v1/shelves/${shelf.id}/books`, { headers, data: { bookIds: bookIDs } })
  expect(batch.status()).toBe(200)
  expect(await batch.json()).toEqual({ addedBookIds: bookIDs, alreadyPresentBookIds: [] })

  await page.goto(`/#/shelves?shelf=${shelf.id}`)
  await expectOrder(page, bookIDs)
  await dragFirstAfterThird(page, bookIDs[0], bookIDs[2], useTouch)
  const sortedIDs = [bookIDs[1], bookIDs[2], bookIDs[0]]
  await expectOrder(page, sortedIDs)
  await expect(page.locator('.workspace-feedback')).toContainText('阅读顺序已保存。')
  await page.reload()
  await expectOrder(page, sortedIDs)
  const storedShelf = await page.request.get(`/api/v1/shelves/${shelf.id}/books`)
  expect(storedShelf.ok()).toBe(true)
  expect((await storedShelf.json()).items.map((book: BookFile) => book.id)).toEqual(sortedIDs)
  for (let index = 0; index < books.length; index++) {
    expect((await page.request.get(`/api/v1/book-files/${books[index].id}`)).ok()).toBe(true)
    const storedMarks = await page.request.get(`/api/v1/book-files/${books[index].id}/marks`)
    expect(storedMarks.ok()).toBe(true)
    expect((await storedMarks.json()).items).toEqual([marks[index]])
  }

  await page.goto('/#/notebook')
  await page.getByRole('textbox', { name: '搜索笔记', exact: true }).fill(key)
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.locator('.notebook-card')).toHaveCount(3)
  for (const book of books) await expect(page.getByRole('heading', { name: book.title, exact: true })).toBeVisible()

  const payload = JSON.parse(await downloadExport(page, 'json', key)) as {
    version: number
    generatedAt: string
    filters: { q: string; kind: string; color: string; bookId?: number }
    items: NotebookEntry[]
  }
  expect(payload.version).toBe(1)
  expect(Number.isFinite(Date.parse(payload.generatedAt))).toBe(true)
  expect(payload.filters).toEqual({ q: key, kind: '', color: '' })
  expect(payload.items).toHaveLength(3)
  expect(new Set(payload.items.map((item) => item.bookFileId))).toEqual(new Set(bookIDs))
  for (let index = 0; index < books.length; index++) {
    expect(payload.items.find((item) => item.id === marks[index].id)).toEqual({
      ...marks[index], bookTitle: books[index].title, bookFormat: books[index].format,
    })
  }

  const markdown = await downloadExport(page, 'markdown', key)
  expect(markdown).toContain('# PEUFMReader 阅读笔记')
  expect(markdown).toContain('记录数量：3')
  // User punctuation is intentionally escaped in Markdown. Undo literal-text
  // escaping only for validation, never render or execute the downloaded text.
  const literal = markdown.replace(/\\([!-~])/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  expect(literal.match(/^- 记录 ID：/gm)).toHaveLength(3)
  const locations = literal.split('\n').filter((line) => line.startsWith('- 定位数据：')).map((line) => JSON.parse(line.slice('- 定位数据：'.length)))
  expect(locations).toHaveLength(3)
  for (let index = 0; index < books.length; index++) {
    expect(literal).toContain(`## ${books[index].title}\n`)
    expect(literal).toContain(`- 记录 ID：${marks[index].id}\n`)
    expect(literal).toContain(`- 书籍 ID：${books[index].id}\n`)
    expect(literal).toContain(`- 位置：${marks[index].label}\n`)
    expect(literal).toContain(marks[index].quote)
    expect(literal).toContain(marks[index].body)
    expect(locations).toContainEqual(marks[index].position)
  }
  await expect(page.locator('.notebook-card')).toHaveCount(3)
  await expect(page.getByRole('textbox', { name: '搜索笔记', exact: true })).toHaveValue(key)
  await expect(page.locator('.workspace-feedback')).toContainText('笔记导出已开始下载')
  // The disposable instance/container owns these original synthetic records;
  // whole-instance cleanup is performed by the validating caller after the run.
})

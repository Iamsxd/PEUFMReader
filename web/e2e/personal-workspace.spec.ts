import { expect, test, type Page } from '@playwright/test'
import { minimalPDF } from './support/pdf'
import { minimalEPUB } from './support/epub'

test.use({ serviceWorkers: 'block' })

// Original fixtures and stateful API interception: no real books or accounts.
const books = ['阅读的形状', '漫游指南', '文字的温度'].map((title, index) => ({
  id: 920000 + index,
  workId: 920000 + index,
  editionId: 920000 + index,
  title,
  authors: ['测试作者'],
  categories: [],
  format: index === 2 ? 'epub' : 'pdf',
  mimeType: index === 2 ? 'application/epub+zip' : 'application/pdf',
  sizeBytes: 1024,
  originalFilename: 'original-fixture',
  storageMode: 'managed',
  reviewRequired: false,
  textAvailable: true,
  createdAt: '2026-10-03T00:00:00Z',
}))

async function mockWorkspace(page: Page, options: {
  fail?: boolean
  long?: boolean
  many?: boolean
  manyBooks?: boolean
  initialBookCount?: number
  failBatchOnce?: boolean
} = {}) {
  const catalog = options.manyBooks
    ? [...books, ...Array.from({ length: 39 }, (_, index) => ({
        ...books[0],
        id: 920003 + index,
        workId: 920003 + index,
        editionId: 920003 + index,
        title: `原创书架条目 ${String(index + 4).padStart(2, '0')}`,
        originalFilename: 'original-shelf-fixture.pdf',
      }))]
    : books
  let shelves = [
    {
      id: 50,
      name: options.long ? '专题阅读清单'.repeat(15) : '慢读清单',
      description: '给自己留一些阅读的时间',
      createdAt: '2026-10-03T00:00:00Z',
    },
  ]
  const memberships = new Map<number, number[]>([[50, catalog.slice(0, options.initialBookCount ?? 2).map((book) => book.id)]])
  let batchFailures = options.failBatchOnce ? 1 : 0
  const batchRequests: { shelfID: number; bookIds: number[] }[] = []
  const membershipRequests: { shelfID: number; bookIds: number[] }[] = []
  const catalogRequests: { page: number; pageSize: number; q: string }[] = []
  let marks = books.map((book, index) => ({
    id: 60 + index,
    bookFileId: book.id,
    bookTitle: book.title,
    bookFormat: book.format,
    kind: index === 1 ? 'note' : 'highlight',
    label: index === 2 ? 'Chapter Two' : '第 2 页',
    position: index === 2 ? { href: 'two.xhtml', chapterIndex: 1 } : { pageIndex: 1, yRatio: 0 },
    overallProgress: 0.5,
    body: index === 1 ? '我想记住这个观点' : '留一点空白',
    quote: index === 1 ? '' : options.long ? '很长的摘录'.repeat(200) : '阅读让我们看见不同的生活。',
    color: index === 1 ? '' : 'green',
    createdAt: '2026-10-03T00:00:00Z',
    updatedAt: '2026-10-03T00:00:00Z',
  }))
  if (options.many) marks = Array.from({ length: 26 }, (_, index) => ({ ...marks[index % 3], id: 60 + index }))
  const writes: string[] = []
  const respond = (items: unknown[], pageNumber = 1, pageSize = 24) => ({
    items: items.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
    total: items.length,
    page: pageNumber,
    pageSize,
    totalPages: Math.ceil(items.length / pageSize),
  })
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname,
      method = route.request().method()
    if (method !== 'GET') writes.push(`${method} ${path}`)
    const input = () => route.request().postDataJSON()
    let data: unknown = { items: [] }
    if (path === '/api/v1/auth/me')
      data = {
        user: { id: 920000, username: '阅读测试', role: 'admin' },
        csrfToken: 'synthetic-csrf',
      }
    else if (path === '/api/v1/notebook') {
      if (options.fail)
        return route.fulfill({
          status: 503,
          json: {
            error: { code: 'unavailable', message: '测试：笔记暂不可用' },
          },
        })
      const q = url.searchParams.get('q') ?? ''
      const filtered = marks.filter(
        (mark) =>
          (!url.searchParams.get('bookId') || mark.bookFileId === Number(url.searchParams.get('bookId'))) &&
          (!url.searchParams.get('kind') || mark.kind === url.searchParams.get('kind')) &&
          (!url.searchParams.get('color') || mark.color === url.searchParams.get('color')) &&
          `${mark.bookTitle}${mark.body}${mark.quote}`.includes(q),
      )
      data = respond(filtered, Number(url.searchParams.get('page') ?? 1))
    } else if (/\/reading-marks\/\d+$/.test(path)) {
      const id = Number(path.split('/').pop())
      if (method === 'DELETE') {
        marks = marks.filter((mark) => mark.id !== id)
        return route.fulfill({ status: 204 })
      }
      marks = marks.map((mark) => (mark.id === id ? { ...mark, ...input() } : mark))
      data = marks.find((mark) => mark.id === id)
    } else if (path === '/api/v1/shelves') {
      if (method === 'POST') {
        const shelf = {
          id: 51 + shelves.length,
          ...input(),
          createdAt: '2026-10-03T00:00:00Z',
        }
        shelves.push(shelf)
        memberships.set(shelf.id, [])
        return route.fulfill({ status: 201, json: shelf })
      }
      data = {
        items: shelves.map((shelf) => ({
          ...shelf,
          bookCount: memberships.get(shelf.id)?.length ?? 0,
          containsBook: memberships.get(shelf.id)?.includes(Number(url.searchParams.get('bookId'))) ?? false,
        })),
      }
    } else if (/\/shelves\/\d+\/memberships$/.test(path)) {
      const shelfID = Number(path.split('/')[4])
      if (!memberships.has(shelfID))
        return route.fulfill({ status: 404, json: { error: { code: 'shelf_not_found', message: '测试：书架不存在' } } })
      const requested = (url.searchParams.get('ids') ?? '').split(',').map(Number)
      if (requested.length > 100 || requested.some((id) => !Number.isInteger(id) || id <= 0))
        return route.fulfill({ status: 400, json: { error: { code: 'invalid_shelf_book_ids', message: '测试：请选择 1–100 本书' } } })
      const ids = [...new Set(requested)]
      membershipRequests.push({ shelfID, bookIds: ids })
      data = { bookIds: ids.filter((id) => memberships.get(shelfID)!.includes(id)) }
    } else if (/\/shelves\/\d+\/books\/\d+$/.test(path)) {
      const parts = path.split('/'),
        shelfID = Number(parts[4]),
        bookID = Number(parts[6])
      const ids = memberships.get(shelfID) ?? []
      if (method === 'PUT' && !ids.includes(bookID)) ids.push(bookID)
      if (method === 'DELETE')
        memberships.set(
          shelfID,
          ids.filter((id) => id !== bookID),
        )
      if (method === 'PATCH') {
        const current = ids.indexOf(bookID),
          next = current + (input().direction === 'earlier' ? -1 : 1)
        if (next >= 0 && next < ids.length) [ids[current], ids[next]] = [ids[next], ids[current]]
      }
      return route.fulfill({ status: 204 })
    } else if (/\/shelves\/\d+\/books$/.test(path)) {
      const id = Number(path.split('/')[4])
      if (method === 'POST') {
        const requested = input().bookIds as number[]
        if (!Array.isArray(requested) || requested.length === 0 || requested.length > 100 || requested.some((bookID) => !Number.isInteger(bookID) || bookID <= 0))
          return route.fulfill({ status: 400, json: { error: { code: 'invalid_shelf_book_ids', message: '测试：请选择 1–100 本书' } } })
        batchRequests.push({ shelfID: id, bookIds: [...requested] })
        if (batchFailures > 0) {
          batchFailures -= 1
          return route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: '测试：批量添加失败，请重试' } } })
        }
        if (!memberships.has(id) || requested.some((bookID) => !catalog.some((book) => book.id === bookID)))
          return route.fulfill({ status: 404, json: { error: { code: 'shelf_book_not_found', message: '测试：书架或书籍不存在' } } })
        const ids = memberships.get(id)!
        const unique = [...new Set(requested)]
        const addedBookIds = unique.filter((bookID) => !ids.includes(bookID))
        const alreadyPresentBookIds = unique.filter((bookID) => ids.includes(bookID))
        ids.push(...addedBookIds)
        return route.fulfill({ status: 200, json: { addedBookIds, alreadyPresentBookIds } })
      }
      data = respond(
        (memberships.get(id) ?? []).map((bookID) => catalog.find((book) => book.id === bookID)),
        Number(url.searchParams.get('page') ?? 1),
        Number(url.searchParams.get('pageSize') ?? 24),
      )
    } else if (/\/shelves\/\d+$/.test(path)) {
      const id = Number(path.split('/').pop())
      if (method === 'DELETE') {
        shelves = shelves.filter((shelf) => shelf.id !== id)
        memberships.delete(id)
        return route.fulfill({ status: 204 })
      }
      shelves = shelves.map((shelf) => (shelf.id === id ? { ...shelf, ...input() } : shelf))
      data = shelves.find((shelf) => shelf.id === id)
    } else if (path === '/api/v1/book-files') {
      const q = url.searchParams.get('q') ?? ''
      const pageNumber = Number(url.searchParams.get('page') ?? 1)
      const pageSize = Number(url.searchParams.get('pageSize') ?? 24)
      catalogRequests.push({ page: pageNumber, pageSize, q })
      data = respond(catalog.filter((book) => `${book.title}${book.authors.join(' ')}`.includes(q)), pageNumber, pageSize)
    } else if (/book-files\/\d+$/.test(path)) {
      const book = catalog.find((book) => book.id === Number(path.split('/').pop()))!
      data = {
        book,
        description: '原创测试书籍简介',
        readingState: {
          bookFileId: book.id,
          position: {},
          overallProgress: 0,
          status: 'unread',
          totalActiveSeconds: 0,
        },
        favorite: false,
        readerCount: 1,
        favoriteCount: 0,
        totalActiveSeconds: 0,
      }
    } else if (path.endsWith('/content')) {
      const epub = path.includes(String(books[2].id))
      return route.fulfill({
        status: 200,
        contentType: epub ? 'application/epub+zip' : 'application/pdf',
        body: epub ? minimalEPUB() : minimalPDF(['Original first page.', 'Original second page.']),
      })
    } else if (path.endsWith('/progress'))
      data = {
        bookFileId: Number(path.split('/')[4]),
        position: { pageIndex: 0 },
        overallProgress: 0,
        status: 'reading',
        totalActiveSeconds: 60,
      }
    else if (path.endsWith('/marks'))
      data = {
        items: marks.filter((mark) => mark.bookFileId === Number(path.split('/')[4])),
      }
    else if (path.includes('reading-sessions')) data = { id: 920100, bookFileId: books[0].id, activeSeconds: 0 }
    await route.fulfill({ status: 200, json: data })
  })
  return {
    writes,
    batchRequests,
    membershipRequests,
    catalogRequests,
    books: catalog,
    membershipBookIds: (id = 50) => [...(memberships.get(id) ?? [])],
  }
}

async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
}

async function openShelfSearch(page: Page, query = '') {
  await page.locator('.shelf-add-books summary').click()
  await page.getByRole('textbox', { name: '搜索要添加的书籍' }).fill(query)
  await page.getByRole('button', { name: '查找书籍', exact: true }).click()
  await expect(page.locator('.shelf-search-summary')).toBeVisible()
}

test('shelf candidates paginate, preserve cross-page selections and append one ordered batch', async ({ page }) => {
  const fixture = await mockWorkspace(page, { manyBooks: true })
  await page.goto('/#/shelves?shelf=50')
  await expect(page.locator('.shelf-book')).toHaveCount(2)
  await openShelfSearch(page)
  await expect(page.locator('.shelf-candidates > div')).toHaveCount(12)
  const choice = (index: number) => page.getByRole('checkbox', { name: `勾选《${fixture.books[index].title}》`, exact: true })
  const pagination = page.getByRole('navigation', { name: '添加书籍搜索分页', exact: true })
  await expect(choice(0)).toBeDisabled()
  await choice(3).check()
  await pagination.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(pagination).toContainText('2 / 4')
  await choice(13).check()
  await expect(page.locator('.shelf-selection-bar')).toContainText('已勾选 2 本（含其他页）')
  await pagination.getByRole('button', { name: '上一页', exact: true }).click()
  await expect(choice(3)).toBeChecked()
  await page.locator('.shelf-selected-books summary').click()
  await expect(page.locator('.shelf-selected-books li')).toHaveCount(2)
  await page.getByRole('button', { name: `取消勾选《${fixture.books[13].title}》`, exact: true }).click()
  await expect(page.locator('.shelf-selection-bar')).toContainText('已勾选 1 本')
  await expect(choice(3)).toBeChecked()
  await page.getByRole('button', { name: '清空勾选', exact: true }).click()
  await expect(choice(3)).not.toBeChecked()
  await page.getByRole('button', { name: '勾选本页', exact: true }).click()
  await expect(page.locator('.shelf-selection-bar')).toContainText('已勾选 10 本')
  await page.getByRole('button', { name: '清空勾选', exact: true }).click()
  await choice(3).check()
  await pagination.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(pagination).toContainText('2 / 4')
  await choice(13).check()
  await page.getByRole('button', { name: '添加已选（2）', exact: true }).click()
  await expect(page.locator('.shelf-book')).toHaveCount(4)
  await expect(page.locator('.shelf-selection-bar')).toContainText('已勾选 0 本')
  await expect(choice(13)).toBeDisabled()
  await expect(choice(13)).not.toBeChecked()
  expect(fixture.batchRequests).toEqual([{ shelfID: 50, bookIds: [fixture.books[3].id, fixture.books[13].id] }])
  expect(fixture.membershipBookIds()).toEqual([fixture.books[0].id, fixture.books[1].id, fixture.books[3].id, fixture.books[13].id])
  expect(fixture.writes.filter((write) => write.startsWith('PUT /api/v1/shelves/'))).toEqual([])
  expect(fixture.catalogRequests.every((request) => request.pageSize === 12)).toBe(true)
  expect(fixture.catalogRequests.some((request) => request.page === 2)).toBe(true)
  expect(fixture.membershipRequests.every((request) => request.bookIds.length <= 12)).toBe(true)
  await noOverflow(page)
})

test('shelf candidates recognize existing membership outside the visible shelf page', async ({ page }) => {
  const fixture = await mockWorkspace(page, { manyBooks: true, initialBookCount: 25 })
  const book = fixture.books[24]
  await page.goto('/#/shelves?shelf=50')
  await expect(page.locator('.shelf-book')).toHaveCount(24)
  await expect(page.locator('.shelf-book h3').filter({ hasText: book.title })).toHaveCount(0)
  await openShelfSearch(page, book.title)
  await expect(page.locator('.shelf-candidates > div')).toHaveCount(1)
  await expect(page.getByRole('checkbox', { name: `勾选《${book.title}》`, exact: true })).toBeDisabled()
  await expect(page.locator('.shelf-candidates').getByRole('button', { name: '已在书架', exact: true })).toBeDisabled()
  expect(fixture.membershipRequests.at(-1)).toEqual({ shelfID: 50, bookIds: [book.id] })
  expect(fixture.batchRequests).toEqual([])
  await page.getByRole('navigation', { name: '书架分页', exact: true }).getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page.locator('.shelf-book')).toHaveCount(1)
  await expect(page.locator('.shelf-book h3')).toHaveText(book.title)
  await expect(page.getByRole('navigation', { name: '书架分页', exact: true })).toContainText('2 / 2')
})

test('failed shelf batch keeps all selections and requires an explicit atomic retry', async ({ page }) => {
  const fixture = await mockWorkspace(page, { manyBooks: true, failBatchOnce: true })
  await page.goto('/#/shelves?shelf=50')
  await expect(page.locator('.shelf-book')).toHaveCount(2)
  await openShelfSearch(page)
  for (const index of [3, 4])
    await page.getByRole('checkbox', { name: `勾选《${fixture.books[index].title}》`, exact: true }).check()
  await page.getByRole('button', { name: '添加已选（2）', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('测试：批量添加失败，请重试')
  await expect(page.locator('.shelf-book')).toHaveCount(2)
  await expect(page.locator('.shelf-selection-bar')).toContainText('已勾选 2 本')
  for (const index of [3, 4])
    await expect(page.getByRole('checkbox', { name: `勾选《${fixture.books[index].title}》`, exact: true })).toBeChecked()
  expect(fixture.batchRequests).toHaveLength(1)
  expect(fixture.membershipBookIds()).toEqual([fixture.books[0].id, fixture.books[1].id])
  await page.getByRole('button', { name: '添加已选（2）', exact: true }).click()
  await expect(page.locator('.shelf-book')).toHaveCount(4)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.workspace-feedback')).toContainText('已添加 2 本书')
  await expect(page.locator('.shelf-selection-bar')).toContainText('已勾选 0 本')
  expect(fixture.batchRequests).toEqual(Array.from({ length: 2 }, () => ({ shelfID: 50, bookIds: [fixture.books[3].id, fixture.books[4].id] })))
  expect(fixture.membershipBookIds()).toEqual([fixture.books[0].id, fixture.books[1].id, fixture.books[3].id, fixture.books[4].id])
})

test('undoing shelf removal appends the association without deleting the original book', async ({ page }) => {
  const fixture = await mockWorkspace(page)
  await page.goto('/#/shelves?shelf=50')
  await expect(page.locator('.shelf-book')).toHaveCount(2)
  page.once('dialog', (dialog) => dialog.accept())
  await page.locator('.shelf-book').first().getByRole('button', { name: '移除', exact: true }).click()
  await expect(page.locator('.shelf-book')).toHaveCount(1)
  await expect(page.locator('.workspace-feedback')).toContainText('书籍、进度和笔记未删除')
  await page.getByRole('button', { name: '撤销移除（加入末尾）', exact: true }).click()
  await expect(page.locator('.shelf-book h3')).toHaveText([books[1].title, books[0].title])
  await expect(page.locator('.workspace-feedback')).toContainText('重新加入书架末尾')
  expect(fixture.membershipBookIds()).toEqual([books[1].id, books[0].id])
  expect(fixture.writes).toEqual([
    `DELETE /api/v1/shelves/50/books/${books[0].id}`,
    `PUT /api/v1/shelves/50/books/${books[0].id}`,
  ])
  await page.goto(`/#/book/${books[0].id}`)
  await expect(page.getByRole('heading', { name: books[0].title, exact: true })).toBeVisible()
  await expect(page.locator('.detail-description')).toHaveText('原创测试书籍简介')
})

test('shelf batch controls and candidate pagination fit 320px in both themes', async ({ page }, info) => {
  await mockWorkspace(page, { manyBooks: true, long: true })
  await page.setViewportSize({ width: 320, height: 850 })
  await page.goto('/#/shelves?shelf=50')
  await expect(page.locator('.shelf-book')).toHaveCount(2)
  await openShelfSearch(page)
  const pagination = page.getByRole('navigation', { name: '添加书籍搜索分页', exact: true })
  await expect.poll(() => page.locator('.shelf-navigation button').first().evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(110)
  await expect.poll(() => page.locator('.shelf-heading h2').evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(130)
  for (const theme of ['edition', 'night']) {
    await page.getByRole('combobox', { name: '界面主题' }).selectOption(theme)
    await page.getByRole('button', { name: '勾选本页', exact: true }).click()
    await expect(page.locator('.shelf-selection-bar')).toContainText('已勾选 10 本')
    await noOverflow(page)
    await pagination.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(pagination).toContainText('2 / 4')
    await page.getByRole('button', { name: '勾选本页', exact: true }).click()
    await expect(page.locator('.shelf-selection-bar')).toContainText('已勾选 22 本')
    await page.locator('.shelf-selected-books summary').click()
    await expect(page.locator('.shelf-selected-books li')).toHaveCount(22)
    await noOverflow(page)
    await page.screenshot({ path: info.outputPath(`${theme}-shelf-batch-320.png`), fullPage: true })
    await page.getByRole('button', { name: '清空勾选', exact: true }).click()
    await expect(page.locator('.shelf-selection-bar')).toContainText('已勾选 0 本')
    await pagination.getByRole('button', { name: '上一页', exact: true }).click()
    await expect(pagination).toContainText('1 / 4')
  }
})

test('candidate membership failures block adding until a successful explicit retry', async ({ page }) => {
  const fixture = await mockWorkspace(page, { manyBooks: true })
  let fail = true
  await page.route('**/api/v1/shelves/50/memberships?*', async (route) => {
    if (fail) {
      fail = false
      return route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: '测试：归属核对失败' } } })
    }
    return route.fallback()
  })
  await page.goto('/#/shelves?shelf=50')
  await expect(page.locator('.shelf-book')).toHaveCount(2)
  await page.locator('.shelf-add-books > summary').click()
  await page.getByRole('button', { name: '查找书籍', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('测试：归属核对失败')
  await expect(page.locator('.shelf-candidates > div')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '勾选本页', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '重试搜索', exact: true }).click()
  await expect(page.locator('.shelf-candidates > div')).toHaveCount(12)
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(fixture.batchRequests).toEqual([])
})

test('a late candidate search cannot overwrite a newer search', async ({ page }) => {
  const fixture = await mockWorkspace(page, { manyBooks: true })
  const oldBook = fixture.books[3], newBook = fixture.books[4]
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let started = false
  await page.route('**/api/v1/book-files?*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('q') !== oldBook.title) return route.fallback()
    started = true
    await gate
    return route.fulfill({ status: 200, json: { items: [oldBook], total: 1, page: 1, pageSize: 12, totalPages: 1 } })
  })
  try {
    await page.goto('/#/shelves?shelf=50')
    await expect(page.locator('.shelf-book')).toHaveCount(2)
    await page.locator('.shelf-add-books > summary').click()
    const search = page.getByRole('textbox', { name: '搜索要添加的书籍' })
    await search.fill(oldBook.title)
    await page.getByRole('button', { name: '查找书籍', exact: true }).click()
    await expect.poll(() => started).toBe(true)
    await search.fill(newBook.title)
    await page.getByRole('button', { name: '查找书籍', exact: true }).click()
    await expect(page.locator('.shelf-candidates > div')).toHaveCount(1)
    await expect(page.locator('.shelf-candidates')).toContainText(newBook.title)
    const oldResponse = page.waitForResponse((response) => new URL(response.url()).searchParams.get('q') === oldBook.title)
    release()
    await oldResponse
    await page.evaluate(() => new Promise(requestAnimationFrame))
    await expect(page.locator('.shelf-candidates')).toContainText(newBook.title)
    await expect(page.locator('.shelf-candidates')).not.toContainText(oldBook.title)
    expect(fixture.membershipRequests.every((request) => !request.bookIds.includes(oldBook.id))).toBe(true)
    expect(fixture.batchRequests).toEqual([])
  } finally {
    release()
  }
})

test('personal tools remain reachable in desktop navigation and mobile more menu', async ({ page }, info) => {
  await mockWorkspace(page)
  await page.goto('/#/shelves')
  const nav = page.getByRole('navigation', { name: '主导航', exact: true })
  for (const [name, route] of [['我的笔记', 'notebook'], ['我的书架', 'shelves']]) {
    if (info.project.name === 'mobile-chromium') await nav.locator('summary').click()
    await nav.getByRole('button', { name: new RegExp(`^${name}`) }).click()
    await expect(page).toHaveURL(new RegExp(`#/${route}$`))
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
    await noOverflow(page)
  }
})

test('notebook paginates rather than downloading every book', async ({ page }) => {
  const { writes } = await mockWorkspace(page, { many: true })
  await page.goto('/#/notebook')
  await expect(page.locator('.notebook-card')).toHaveCount(24)
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page.locator('.notebook-card')).toHaveCount(2)
  await expect(page.getByRole('navigation', { name: '笔记分页' })).toContainText('2 / 2')
  await page.getByRole('button', { name: '上一页', exact: true }).click()
  await expect(page.locator('.notebook-card')).toHaveCount(24)
  expect(writes).toEqual([])
})

test('notebook searches, filters, edits and deletes private annotations in both themes', async ({ page }, info) => {
  await mockWorkspace(page)
  await page.goto('/#/notebook')
  await expect(page.locator('.notebook-card')).toHaveCount(3)
  for (const theme of ['edition', 'night']) {
    await page.getByRole('combobox', { name: '界面主题' }).selectOption(theme)
    await noOverflow(page)
    await page.screenshot({
      path: info.outputPath(`${theme}-notebook.png`),
      fullPage: true,
    })
  }
  await page.getByRole('combobox', { name: '记录类型', exact: true }).selectOption('note')
  await expect(page.locator('.notebook-card')).toHaveCount(1)
  await page.getByRole('button', { name: '编辑批注' }).click()
  await page.getByRole('textbox', { name: '编辑笔记内容' }).fill('一个新的阅读想法')
  await page.getByRole('button', { name: '保存笔记' }).click()
  await expect(page.locator('.notebook-body')).toHaveText('一个新的阅读想法')
  await page.getByRole('combobox', { name: '记录类型', exact: true }).selectOption('')
  await page.getByRole('textbox', { name: '搜索笔记', exact: true }).fill('新的阅读想法')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.locator('.notebook-card')).toHaveCount(1)
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByRole('heading', { name: '还没有符合条件的记录' })).toBeVisible()
})

test('personal shelves create, add, order, rename and remove without deleting books', async ({ page }, info) => {
  const { writes } = await mockWorkspace(page)
  await page.goto('/#/shelves?shelf=50')
  await expect(page.locator('.shelf-book')).toHaveCount(2)
  for (const theme of ['edition', 'night']) {
    await page.getByRole('combobox', { name: '界面主题' }).selectOption(theme)
    await noOverflow(page)
    await page.screenshot({
      path: info.outputPath(`${theme}-shelves.png`),
      fullPage: true,
    })
  }
  await page.getByRole('button', { name: '将《漫游指南》提前' }).click()
  await expect(page.locator('.shelf-book h3').first()).toHaveText('漫游指南')
  await page.getByRole('button', { name: '＋ 新建书架', exact: true }).click()
  await page.getByRole('textbox', { name: '书架名称', exact: true }).fill('周末阅读')
  await page.getByRole('textbox', { name: '书架说明', exact: true }).fill('读一点不一样的书')
  await page.getByRole('button', { name: '保存书架', exact: true }).click()
  await expect(page.locator('.shelf-heading h2')).toHaveText('周末阅读')
  await page.locator('.shelf-add-books summary').click()
  await page.getByRole('textbox', { name: '搜索要添加的书籍' }).fill('阅读的形状')
  await page.getByRole('button', { name: '查找书籍' }).click()
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.locator('.shelf-book h3')).toHaveText('阅读的形状')
  await page.getByRole('button', { name: '编辑书架', exact: true }).click()
  await page.getByRole('textbox', { name: '书架名称', exact: true }).fill('周末慢读')
  await page.getByRole('button', { name: '保存书架', exact: true }).click()
  await expect(page.locator('.shelf-heading h2')).toHaveText('周末慢读')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '移除', exact: true }).click()
  await expect(page.locator('.shelf-book')).toHaveCount(0)
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '删除书架', exact: true }).click()
  await expect(page.getByRole('navigation', { name: '个人书架' })).not.toContainText('周末慢读')
  expect(writes.some((path) => /^DELETE \/api\/v1\/book-files\//.test(path))).toBe(false)
})

test('details add to shelves and open scoped notes; device instructions state integration limits', async ({ page }) => {
  await mockWorkspace(page)
  await page.goto(`/#/book/${books[0].id}`)
  await page.locator('.shelf-membership summary').click()
  await expect(page.getByRole('checkbox', { name: /慢读清单/ })).toBeChecked()
  await page.getByRole('checkbox', { name: /慢读清单/ }).uncheck()
  await expect(page.getByRole('checkbox', { name: /慢读清单/ })).not.toBeChecked()
  await page.getByRole('textbox', { name: '新书架名称' }).fill('新专题')
  await page.getByRole('button', { name: '创建并加入' }).click()
  await expect(page.getByRole('checkbox', { name: /新专题/ })).toBeChecked()
  await page.getByRole('button', { name: '查看本书笔记' }).click()
  await expect(page).toHaveURL(/notebook\?bookId=920000/)
  await expect(page.locator('.notebook-card')).toHaveCount(1)
  await page.getByRole('button', { name: '查看全部笔记' }).click()
  await expect(page.locator('.notebook-card')).toHaveCount(3)
  await page.goto('/#/devices')
  await expect(page.locator('.device-onboarding')).toContainText('不会自动同步阅读进度')
  await page.getByRole('button', { name: 'KOReader', exact: true }).click()
  await expect(page.locator('.device-copy-endpoint')).toContainText('/api/koreader')
  await page.getByRole('button', { name: 'Kobo 适配器', exact: true }).click()
  await expect(page.locator('.device-onboarding')).toContainText('不能直接替换 Kobo 官方商店')
  await noOverflow(page)
})

test('notebook handles errors and long excerpts at 320px without losing navigation', async ({ page }) => {
  await mockWorkspace(page, { fail: true })
  await page.goto('/#/notebook')
  await expect(page.getByRole('alert')).toContainText('测试：笔记暂不可用')
  await noOverflow(page)
  await page.unroute('**/api/v1/**')
  await mockWorkspace(page, { long: true })
  await page.setViewportSize({ width: 320, height: 850 })
  await page.reload()
  for (const theme of ['edition', 'night']) {
    await page.getByRole('combobox', { name: '界面主题' }).selectOption(theme)
    await expect(page.locator('.notebook-card')).toHaveCount(3)
    await noOverflow(page)
    await page.goto('/#/shelves?shelf=50')
    await expect(page.locator('.shelf-book')).toHaveCount(2)
    await noOverflow(page)
    await page.goto('/#/notebook')
  }
})

test('notebook returns to the marked PDF page and reader filters existing annotations', async ({ page }, info) => {
  await mockWorkspace(page)
  await page.goto(`/#/notebook?bookId=${books[0].id}`)
  await page.getByRole('button', { name: '回到原文' }).click()
  await expect(page.locator('.pdf-page-shell.rendered').first()).toBeVisible()
  const toolbar = page.locator('.pdf-toolbar')
  if ((await toolbar.getAttribute('aria-hidden')) === 'true') {
    if (info.project.name === 'mobile-chromium') await page.locator('.pdf-reader-viewport').tap()
    else await page.getByRole('button', { name: '显示 PDF 阅读工具', exact: true }).click()
  }
  await expect(toolbar).not.toHaveAttribute('aria-hidden', 'true')
  await expect(page.getByRole('spinbutton', { name: '当前页码', exact: true })).toHaveValue('2')
  await toolbar.getByRole('button', { name: '书签/高亮', exact: true }).click()
  await expect(page.locator('.reading-mark-item')).toHaveCount(1)
  await page.getByRole('textbox', { name: '搜索本书批注' }).fill('不存在的摘录')
  await expect(page.locator('.reading-mark-item')).toHaveCount(0)
  await expect(page.locator('.reading-marks-panel')).toContainText('没有符合筛选条件的批注')
  await page.getByRole('button', { name: '关闭侧栏', exact: true }).click()
  const pageNumber = page.getByRole('spinbutton', { name: '当前页码', exact: true })
  await pageNumber.fill('1')
  await pageNumber.press('Enter')
  await expect(page.locator('.reader-title span')).toContainText('0%')
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await expect(page.locator('.reader-shell > .notice')).toContainText('当前处于离线阅读')
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.locator('.reader-shell > .notice')).toHaveCount(0)
  // Reconnecting must restore normal progress, not re-apply the opening mark.
  await expect(page.locator('.reader-title span')).toContainText('0%')
})

test('notebook returns to the marked EPUB chapter', async ({ page }) => {
  await mockWorkspace(page)
  await page.goto(`/#/notebook?bookId=${books[2].id}`)
  await page.getByRole('button', { name: '回到原文' }).click()
  await expect
    .poll(async () => {
      for (const frame of page.frames())
        if (
          await frame
            .getByRole('heading', { name: 'Chapter Two', exact: true })
            .isVisible()
            .catch(() => false)
        )
          return true
      return false
    })
    .toBe(true)
})

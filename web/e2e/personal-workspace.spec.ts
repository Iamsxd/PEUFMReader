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

async function mockWorkspace(page: Page, options: { fail?: boolean; long?: boolean; many?: boolean } = {}) {
  let shelves = [
    {
      id: 50,
      name: options.long ? '专题阅读清单'.repeat(15) : '慢读清单',
      description: '给自己留一些阅读的时间',
      createdAt: '2026-10-03T00:00:00Z',
    },
  ]
  const memberships = new Map<number, number[]>([[50, [books[0].id, books[1].id]]])
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
      data = respond(
        (memberships.get(id) ?? []).map((bookID) => books.find((book) => book.id === bookID)),
        Number(url.searchParams.get('page') ?? 1),
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
    } else if (path === '/api/v1/book-files')
      data = respond(books.filter((book) => book.title.includes(url.searchParams.get('q') ?? '')))
    else if (/book-files\/\d+$/.test(path)) {
      const book = books.find((book) => book.id === Number(path.split('/').pop()))!
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
  return { writes }
}

async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
}

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

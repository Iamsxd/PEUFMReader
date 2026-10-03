import { expect, test, type Page } from '@playwright/test'
import { minimalPDF } from './support/pdf'
import { minimalEPUB } from './support/epub'

test.use({ serviceWorkers: 'block' })

// Synthetic books and intercepted APIs: this suite never writes to a real library.
const titles = ['瓦尔登湖', '小王子', '海底两万里', '山海经']
const books = titles.map((title, index) => ({
  id: 910000 + index, workId: 910000 + index, editionId: 910000 + index,
  title, authors: [['亨利·戴维·梭罗', '圣埃克苏佩里', '儒勒·凡尔纳', '佚名'][index]],
  format: 'pdf', mimeType: 'application/pdf', sizeBytes: 1024,
  originalFilename: `theme-test-${index}.pdf`, storageMode: 'managed',
  categories: [], reviewRequired: false, textAvailable: true,
  createdAt: '2026-09-19T00:00:00Z',
}))
const summary = {
  continueReading: books.slice(0, 2).map((book, i) => ({ book, overallProgress: i ? .68 : .42, totalActiveSeconds: 240 })),
  recentlyAdded: books,
  stats: { totalBooks: 4, readingBooks: 2, finishedBooks: 12, favoriteBooks: 8, weekActiveSeconds: 2520, totalActiveSeconds: 66240 },
}

async function mockLibrary(page: Page, options: { empty?: boolean; error?: boolean; signedOut?: boolean; long?: boolean; epub?: boolean } = {}) {
  const requests: string[] = []
  const fixtureBooks = options.epub ? books.map(book => ({ ...book, format: 'epub', mimeType: 'application/epub+zip' })) : options.long ? books.map(book => ({ ...book, title: '这是一部具有非常长的书名和副标题的测试书籍'.repeat(4), authors: ['很长的作者名称'.repeat(8)], coverUrl: '/test-missing-cover.png' })) : books
  const fixtureSummary = { ...summary, recentlyAdded: fixtureBooks, continueReading: summary.continueReading.map((item, i) => ({ ...item, book: fixtureBooks[i] })) }
  await page.route('**/test-missing-cover.png*', route => route.fulfill({ status: 404, body: '' }))
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
    requests.push(path)
    let data: unknown = { items: [] }
    if (path === '/api/v1/auth/me') {
      if (options.signedOut) return route.fulfill({ status: 401, json: { error: { code: 'unauthorized', message: '请登录' } } })
      data = { user: { id: 910000, username: '界面测试', role: 'admin' }, csrfToken: 'theme-test' }
    } else if (path === '/api/v1/home/summary') {
      if (options.error) return route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: '阅读概况暂不可用' } } })
      data = options.empty ? { ...summary, continueReading: [], recentlyAdded: [], stats: { ...summary.stats, totalBooks: 0 } } : fixtureSummary
    } else if (path === '/api/v1/book-files') data = { items: fixtureBooks, total: 4, page: 1, pageSize: 24, totalPages: 1 }
    else if (path === '/api/v1/home/categories') data = { items: [{ id: 1, slug: 'literature', name: '文学', bookCount: 4, coverUrls: [] }, { id: 2, slug: 'science', name: '科学', bookCount: 2, coverUrls: [] }] }
    else if (path === '/api/v1/home/hot') data = { items: fixtureSummary.continueReading }
    else if (path === '/api/v1/recommendations') data = { items: fixtureBooks.map(book => ({ book, reason: '从熟悉的题材，发现新的故事', score: .8, signals: [], personalized: true })), personalized: true }
    else if (path === '/api/v1/categories') data = { items: [] }
    else if (path === '/api/v1/auth/providers') data = { oidc: false, ldap: false }
    else if (path === '/api/v1/import-batches') data = { items: [], page: 1, totalPages: 1, total: 0 }
    else if (path === '/api/v1/review-queue/count') data = { total: 0 }
    else if (path === '/api/v1/reading-statistics') data = {
      generatedAt: '2026-09-19T00:00:00Z', windowDays: 84, todayActiveSeconds: 600,
      weekActiveSeconds: 2520, monthActiveSeconds: 6200, totalActiveSeconds: 66240,
      trackedBooks: 4, readingBooks: 2, finishedBooks: 2, completedLast30Days: 1,
      currentStreakDays: 2, longestStreakDays: 4, formats: [], categories: [], recentlyFinished: [],
      dailyActivity: Array.from({ length: 84 }, (_, i) => ({ date: new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10), activeSeconds: (i % 5) * 300 })),
    }
    else if (path.endsWith('/content')) return route.fulfill({ status: 200, contentType: options.epub ? 'application/epub+zip' : 'application/pdf', body: options.epub ? minimalEPUB() : minimalPDF(['Theme isolation regression page.']) })
    else if (/book-files\/\d+$/.test(path)) data = { book: fixtureBooks[0], description: '主题测试', readingState: { bookFileId: books[0].id, position: { pageIndex: 0 }, overallProgress: .42, status: 'reading', totalActiveSeconds: 240 }, favorite: false, readerCount: 1, favoriteCount: 0, totalActiveSeconds: 240 }
    else if (path.endsWith('/progress')) data = { bookFileId: books[0].id, position: { pageIndex: 0 }, overallProgress: .42, status: 'reading', totalActiveSeconds: 240 }
    else if (path.includes('reading-sessions')) data = { id: 910004, bookFileId: books[0].id, activeSeconds: 0 }
    await route.fulfill({ status: 200, json: data })
  })
  return requests
}

test('EPUB reader keeps independent themes, typography and chapter navigation', async ({ page }, info) => {
  await mockLibrary(page, { epub: true })
  await page.goto('/#/book/910000')
  await page.getByRole('combobox', { name: '界面主题' }).selectOption('night')
  await page.locator('.detail-actions .primary').click()
  const toolbar = page.locator('.epub-toolbar[role="toolbar"]')
  await expect(page.locator('.epub-host iframe').first()).toBeVisible()
  // Loading may exceed the normal chrome auto-hide timer on a busy runner.
  if (await toolbar.getAttribute('aria-hidden') === 'true') {
    if (info.project.name === 'mobile-chromium') await page.locator('.epub-host').click()
    else await page.getByRole('button', { name: '显示 EPUB 阅读工具', exact: true }).click()
  }
  await expect(toolbar).not.toHaveAttribute('aria-hidden', 'true')
  await toolbar.getByRole('button', { name: '放大字号', exact: true }).click()
  await expect(toolbar.getByRole('button', { name: '110%', exact: true })).toBeVisible()
  await toolbar.getByRole('button', { name: '夜间', exact: true }).click()
  await expect(page.locator('.epub-reader')).toHaveClass(/theme-night/)
  await toolbar.getByRole('button', { name: '日间', exact: true }).click()
  await expect(page.locator('.epub-reader')).toHaveClass(/theme-paper/)
  await toolbar.getByRole('button', { name: '目录', exact: true }).click()
  const toc = page.getByRole('complementary', { name: 'EPUB 目录' })
  await toc.getByRole('button', { name: 'Chapter Two', exact: true }).click()
  // The continuous manager retains adjacent, off-screen frames; target the
  // selected chapter instead of assuming the first iframe is the active one.
  await expect.poll(async () => {
    for (const frame of page.frames()) {
      if (await frame.getByRole('heading', { name: 'Chapter Two', exact: true }).isVisible().catch(() => false)) return true
    }
    return false
  }).toBe(true)
  await expect(toc).toHaveCount(0)
  await noOverflow(page)
  await page.screenshot({ path: info.outputPath('workspace-epub-reader.png') })
})

test('workspace navigation adapts without losing any destination', async ({ page }, info) => {
  await mockLibrary(page)
  await page.goto('/#/home')
  const navigation = page.getByRole('navigation', { name: '主导航', exact: true })
  const mobile = info.project.name === 'mobile-chromium'
  for (const name of ['首页', '全部书籍', '推荐', '收藏']) await expect(navigation.getByRole('button', { name, exact: true })).toBeVisible()
  if (mobile) {
    await expect(navigation.locator('.desktop-navigation-item').filter({ visible: true })).toHaveCount(0)
    const bounds = await navigation.boundingBox()
    expect(bounds!.y).toBeGreaterThan(600)
    await navigation.locator('summary').click()
    await navigation.locator('.mobile-navigation-items').getByRole('button', { name: /^阅读统计/ }).click()
  } else {
    await expect(page.locator('.library-sidebar')).toHaveCSS('position', 'fixed')
    await navigation.getByRole('button', { name: '阅读统计', exact: true }).click()
  }
  await expect(page).toHaveURL(/#\/statistics$/)
  await expect(page.getByRole('heading', { name: '阅读统计', exact: true })).toBeVisible()
  await navigation.locator('summary').click()
  await navigation.getByRole('button', { name: /^管理后台/ }).click()
  await expect(page.locator('.upload-drop-zone')).toBeVisible()
  await expect(navigation.locator('details')).not.toHaveAttribute('open', '')
  await page.getByRole('button', { name: '返回首页', exact: true }).click()
  await expect(page).toHaveURL(/#\/home$/)
  await noOverflow(page)
})

test('workspace works at tablet and phone breakpoints in both themes', async ({ page }) => {
  await mockLibrary(page)
  await page.goto('/')
  for (const width of [320, 390, 720, 721, 820, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    for (const theme of ['edition', 'night']) {
      await page.getByRole('combobox', { name: '界面主题' }).selectOption(theme)
      await expect(page.locator('.continue-description h3')).toBeVisible()
      await noOverflow(page)
      const navigation = page.getByRole('navigation', { name: '主导航', exact: true })
      const primary = navigation.getByRole('button', { name: '全部书籍', exact: true })
      await expect(primary).toBeVisible()
    }
  }
})

test('keyboard skip link focuses content without changing the route', async ({ page }) => {
  await mockLibrary(page)
  await page.goto('/#/books?format=pdf')
  await expect(page.getByRole('heading', { name: '全部书籍' })).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(page.locator('.workspace-skip-link')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#workspace-content')).toBeFocused()
  await expect(page).toHaveURL(/#\/books\?format=pdf$/)
})

test('themes cover statistics and admin without changing workspace', async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await mockLibrary(page)
  await page.goto('/#/statistics')
  for (const theme of ['edition', 'night']) {
    await page.getByRole('combobox', { name: '界面主题' }).selectOption(theme)
    await expect(page.getByRole('heading', { name: '阅读统计', exact: true })).toBeVisible()
    await expect(page.locator('.reading-heatmap span')).toHaveCount(84)
    const levels = await page.locator('.reading-heatmap span').evaluateAll(elements => [...new Set(elements.map(el => getComputedStyle(el).backgroundColor))])
    expect(levels).toHaveLength(5)
    await noOverflow(page)
    await page.screenshot({ path: info.outputPath(`${theme}-statistics.png`), fullPage: true })
  }
  await page.goto('/#/admin')
  await expect(page.locator('.upload-drop-zone')).toBeVisible()
  for (const theme of ['edition', 'night']) {
    await page.getByRole('combobox', { name: '界面主题' }).selectOption(theme)
    await expect(page.getByRole('heading', { name: '书籍导入', exact: true })).toBeVisible()
    await noOverflow(page)
    await page.screenshot({ path: info.outputPath(`${theme}-imports.png`), fullPage: true })
  }
  expect(errors).toEqual([])
})

test('a selection synchronizes to other open tabs', async ({ page, context }) => {
  await mockLibrary(page)
  await page.goto('/')
  const second = await context.newPage()
  await mockLibrary(second)
  await second.goto('/')
  await page.getByRole('combobox', { name: '界面主题' }).selectOption('night')
  await expect(second.getByRole('combobox', { name: '界面主题' })).toHaveValue('night')
  await second.close()
})

async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
}

for (const theme of ['edition', 'night']) {
  test(`${theme}: persists selection, preserves search, navigation and reader`, async ({ page }, info) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const requests = await mockLibrary(page)
    await page.goto('/')
    await expect(page.locator('.continue-description h3')).toHaveText('瓦尔登湖')
    await page.getByRole('combobox', { name: '界面主题' }).selectOption(theme)
    await expect(page.locator('html')).toHaveAttribute('data-app-theme', theme)
    await expect(page.locator('.continue-progress strong')).toHaveText('42%')
    await noOverflow(page)
    await page.screenshot({ path: info.outputPath(`${theme}-workspace-preview.png`), fullPage: false })
    await page.screenshot({ path: info.outputPath(`${theme}-home.png`), fullPage: true })
    const before = requests.filter(path => path === '/api/v1/home/summary').length
    await page.getByRole('textbox', { name: '搜索书库' }).fill('瓦尔登湖')
    await page.getByRole('combobox', { name: '界面主题' }).selectOption(theme === 'night' ? 'edition' : 'night')
    await expect(page.getByRole('textbox', { name: '搜索书库' })).toHaveValue('瓦尔登湖')
    expect(requests.filter(path => path === '/api/v1/home/summary')).toHaveLength(before)
    await page.getByRole('combobox', { name: '界面主题' }).selectOption(theme)
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await expect(page).toHaveURL(/q=/)
    await expect(page.getByRole('heading', { name: '全部书籍' })).toBeVisible()
    await noOverflow(page)
    await page.screenshot({ path: info.outputPath(`${theme}-catalog.png`), fullPage: true })
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-app-theme', theme)
    await expect(page.getByRole('combobox', { name: '界面主题' })).toHaveValue(theme)
    await page.goto('/#/book/910000')
    await expect(page.locator('.book-detail-page h1')).toHaveText('瓦尔登湖')
    await noOverflow(page)
    await page.screenshot({ path: info.outputPath(`${theme}-detail.png`), fullPage: true })
    await page.locator('.detail-actions .primary').click()
    await expect(page.locator('.pdf-page-shell.rendered').first()).toBeVisible({ timeout: 20_000 })
    expect(await page.locator('.reader-shell').evaluate(el => getComputedStyle(el).getPropertyValue('--ui-accent'))).toBe('')
    expect(await page.locator('.pdf-page-shell').first().evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)')
    expect(errors).toEqual([])
  })
}

test('switch works when preference storage is blocked', async ({ page }) => {
  await mockLibrary(page, { signedOut: true })
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Denied', 'SecurityError') }
    Storage.prototype.getItem = () => { throw new DOMException('Denied', 'SecurityError') }
  })
  await page.goto('/')
  await page.getByRole('combobox', { name: '界面主题' }).selectOption('night')
  await expect(page.locator('html')).toHaveAttribute('data-app-theme', 'night')
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible()
  await noOverflow(page)
})

for (const state of ['empty', 'error', 'long'] as const) {
  test(`both themes handle ${state} content at narrow widths`, async ({ page }) => {
    await mockLibrary(page, { [state]: true })
    await page.setViewportSize({ width: 320, height: 850 })
    await page.goto('/')
    for (const theme of ['night', 'edition']) {
      await page.getByRole('combobox', { name: '界面主题' }).selectOption(theme)
      if (state === 'empty') await expect(page.getByRole('heading', { name: '书库还是空的' })).toBeVisible()
      if (state === 'error') await expect(page.getByRole('alert')).toContainText('阅读概况暂不可用')
      if (state === 'long') await expect(page.locator('.continue-stage > .book-jacket .cover-placeholder')).toBeVisible()
      await noOverflow(page)
    }
  })
}

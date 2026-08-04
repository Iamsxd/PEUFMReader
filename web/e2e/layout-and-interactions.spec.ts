import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { login } from './support/auth'
import { minimalPDF } from './support/pdf'

async function expectNoPageOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))
  expect(overflow.body).toBeLessThanOrEqual(1)
  expect(overflow.root).toBeLessThanOrEqual(1)
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
}

test.beforeEach(async ({ page }) => login(page))

test('primary navigation stays usable and ordered', async ({ page }, testInfo) => {
  const navigation = page.getByRole('navigation', { name: '主导航' })
  const names = ['首页', '推荐', '收藏', '全部书籍', '分类', '阅读统计']
  for (const name of names) await expect(navigation.getByRole('button', { name, exact: true })).toBeVisible()
  const visibleOrder = await navigation.locator('.app-navigation-primary > button').allTextContents()
  expect(visibleOrder).toEqual(names)

  await navigation.getByRole('button', { name: '推荐', exact: true }).click()
  await expect(page.getByRole('heading', { name: '为你推荐' })).toBeVisible()
  await navigation.getByRole('button', { name: '收藏', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我的收藏' })).toBeVisible()
  await navigation.getByRole('button', { name: '全部书籍', exact: true }).click()
  await expect(page.getByRole('heading', { name: '全部书籍' })).toBeVisible()
  await navigation.getByRole('button', { name: '分类', exact: true }).click()
  await expect(page.getByRole('heading', { name: '书籍分类' })).toBeVisible()
  await navigation.getByRole('button', { name: '阅读统计', exact: true }).click()
  await expect(page.getByRole('heading', { name: '阅读统计', exact: true })).toBeVisible()
  const more = navigation.locator('details.navigation-menu > summary')
  await expect(more).toHaveText('更多')
  await expect(more.locator('[aria-hidden="true"]')).toHaveCount(0)
  await expectNoPageOverflow(page)
  await capture(page, testInfo, 'primary-navigation')
})

test('home shell renders before summary and defers expensive sections', async ({ page }) => {
  const liveSummary = await page.request.get('/api/v1/home/summary')
  expect(liveSummary.ok()).toBeTruthy()
  expect(liveSummary.headers()['server-timing']).toMatch(/home_summary;dur=/)
  const fixtureResponse = await page.request.get('/api/v1/home')
  expect(fixtureResponse.ok()).toBeTruthy()
  const fixture = await fixtureResponse.json() as {
    continueReading: unknown[]
    recentlyAdded: unknown[]
    stats: Record<string, number>
    categories: unknown[]
    hotBooks: unknown[]
    recommendations: unknown[]
  }
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '全部书籍', exact: true }).click()

  let releaseSummary = () => {}
  const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve })
  let secondaryRequests = 0
  await page.route('**/api/v1/home/summary', async (route) => {
    await summaryGate
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      continueReading: fixture.continueReading,
      recentlyAdded: fixture.recentlyAdded,
      stats: fixture.stats,
    }) })
  })
  await page.route('**/api/v1/home/categories', async (route) => {
    secondaryRequests++
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: fixture.categories }) })
  })
  await page.route('**/api/v1/home/hot', async (route) => {
    secondaryRequests++
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: fixture.hotBooks }) })
  })
  await page.route('**/api/v1/recommendations**', async (route) => {
    secondaryRequests++
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: fixture.recommendations, personalized: false }) })
  })

  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '首页', exact: true }).click()
  try {
    await expect(page.getByRole('heading', { name: '今天想读点什么？' })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: '正在汇总阅读数据' })).toBeVisible()
    expect(secondaryRequests).toBe(0)
  } finally {
    releaseSummary()
  }

  await expect(page.getByRole('status').filter({ hasText: '正在汇总阅读数据' })).toHaveCount(0)
  await expect.poll(() => secondaryRequests).toBe(3)
})

test('recommendation feedback is interactive and responsive', async ({ page }, testInfo) => {
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '推荐', exact: true }).click()
  await expect(page.getByRole('heading', { name: '为你推荐' })).toBeVisible()
  const interested = page.getByRole('button', { name: '✓ 感兴趣' }).first()
  test.skip(await interested.count() === 0, 'The current library has no recommendation candidate.')
  await interested.click()
  await expect(page.getByRole('button', { name: '✓ 感兴趣' }).first()).toHaveClass(/active/)
  await expectNoPageOverflow(page)
  await capture(page, testInfo, 'recommendation-feedback')
})

test('admin workspaces do not collapse into one oversized page', async ({ page }, testInfo) => {
  const more = page.locator('details.navigation-menu')
  await more.locator('summary').click()
  const admin = more.getByRole('button', { name: /管理后台/ })
  test.skip(await admin.count() === 0, 'The configured E2E account is not an administrator.')
  await admin.click()
  await expect(page.getByRole('heading', { name: '管理后台' })).toBeVisible()
  const workspaces = page.getByRole('navigation', { name: '管理后台工作区' })
  for (const name of ['书籍导入', '书目与分类', '用户与权限', '任务与运维']) {
    await workspaces.getByRole('button', { name: new RegExp(name) }).click()
    await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible()
    if (name === '用户与权限') {
      await expect(page.getByTestId('group-permission-manager')).toBeVisible()
      await expect(page.getByRole('heading', { name: '书库组与用户组' })).toBeVisible()
    }
  }
  await expectNoPageOverflow(page)
  await capture(page, testInfo, 'admin-workspaces')
})

test('a 3336-book review queue stays paginated and loads one editor on demand', async ({ page }) => {
  let pageRequests = 0
  await page.route('**/api/v1/review-queue**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/count')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total: 3336 }) })
      return
    }
    pageRequests++
    const items = Array.from({ length: 20 }, (_, index) => ({
      editionId: 9001 + index,
      workId: 8001 + index,
      bookFileId: 7001 + index,
      title: `待整理测试书 ${index + 1}`,
      authors: ['测试作者'],
      format: index % 2 ? 'epub' : 'pdf',
      originalFilename: `review-${index + 1}.${index % 2 ? 'epub' : 'pdf'}`,
      metadataPending: true,
      candidateCount: 5,
      suggestedClassificationCount: 1,
      updatedAt: '2026-08-01T00:00:00Z',
    }))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items, total: 3336, page: 1, pageSize: 20, totalPages: 167 }) })
  })
  await page.route('**/api/v1/editions/9001/review', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        editionId: 9001, workId: 8001, bookFileId: 7001, title: '待整理测试书 1', authors: ['测试作者'],
        language: 'zh-CN', description: '', sourceSubjects: [],
        candidates: Array.from({ length: 5 }, (_, index) => ({ id: index + 1, fieldName: 'title', value: '测试', source: 'regression', confidence: 0.5, reason: 'test', status: 'suggested' })),
        classifications: [],
      }),
    })
  })

  const more = page.locator('details.navigation-menu')
  await more.locator('summary').click()
  const admin = more.getByRole('button', { name: /管理后台/ })
  test.skip(await admin.count() === 0, 'The configured E2E account is not an administrator.')
  await admin.click()
  const workspaces = page.getByRole('navigation', { name: '管理后台工作区' })
  await workspaces.getByRole('button', { name: /书目与分类/ }).click()

  await expect(page.getByRole('heading', { name: '3336 本需要确认' })).toBeVisible()
  await expect(page.locator('.review-summary-row')).toHaveCount(20)
  await expect(page.locator('.review-card')).toHaveCount(0)
  expect(pageRequests).toBe(1)

  await page.locator('.review-summary-row').first().click()
  await expect(page.locator('.review-card')).toHaveCount(1)
  await expect(page.locator('.review-card details.evidence summary')).toContainText('5 条当前元数据证据')
  expect(pageRequests).toBe(1)
})

test('book detail and reader controls remain reachable', async ({ page }, testInfo) => {
  const readerPDF = minimalPDF(['Reader controls test first page.', 'Automatic reading second page.'])
  const book = {
    id: 909001,
    workId: 909002,
    editionId: 909003,
    title: '阅读器界面回归样本',
    authors: ['自动化测试'],
    categories: [],
    reviewRequired: false,
    textAvailable: true,
    textExtractionMethod: 'embedded',
    pageCount: 2,
    originalFilename: 'reader-controls.pdf',
    storageMode: 'managed',
    format: 'pdf',
    mimeType: 'application/pdf',
    sizeBytes: readerPDF.byteLength,
    createdAt: '2026-08-04T00:00:00Z',
  } as const
  const readingState = {
    bookFileId: book.id,
    position: { pageIndex: 0 },
    overallProgress: 0,
    status: 'unread',
    totalActiveSeconds: 0,
    updatedAt: '2026-08-04T00:00:00Z',
  } as const

  await page.route(`**/api/v1/book-files/${book.id}`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ book, description: '用于验证阅读工具显隐的合成 PDF。', readingState, favorite: false, readerCount: 1, favoriteCount: 0, totalActiveSeconds: 0 }),
  }))
  await page.route('**/api/v1/recommendations?limit=8', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], personalized: false }) }))
  await page.route(`**/api/v1/book-files/${book.id}/content`, (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: readerPDF }))
  await page.route(`**/api/v1/book-files/${book.id}/marks`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }))
  await page.route(`**/api/v1/book-files/${book.id}/progress`, async (route) => {
    const input = route.request().method() === 'PUT' ? await route.request().postDataJSON() as Record<string, unknown> : {}
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...readingState, ...input }) })
  })
  await page.route(`**/api/v1/book-files/${book.id}/reading-sessions`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 909004, bookFileId: book.id, startedAt: '2026-08-04T00:00:00Z', lastHeartbeatAt: '2026-08-04T00:00:00Z', activeSeconds: 0 }) }))
  await page.route('**/api/v1/reading-sessions/909004', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 909004, bookFileId: book.id, startedAt: '2026-08-04T00:00:00Z', lastHeartbeatAt: '2026-08-04T00:00:00Z', activeSeconds: 0 }) }))

  await page.goto(`/#/book/${book.id}`)
  await expect(page.locator('.book-detail-page h1')).toBeVisible()
  await page.getByRole('button', { name: /开始阅读|继续阅读|重新阅读/ }).click()
  const readerToolbar = page.locator('[role="toolbar"][aria-label$="阅读工具"]')
  if (!await readerToolbar.isVisible()) await page.getByRole('button', { name: /显示 (PDF|EPUB) 阅读工具/ }).click()
  await expect(readerToolbar).toBeVisible()
  await expect(readerToolbar.getByRole('button', { name: /书签\/高亮/ })).toBeVisible()
  await readerToolbar.getByRole('button', { name: '朗读', exact: true }).click()
  const speechPanel = page.getByRole('complementary', { name: '浏览器即时朗读' })
  await expect(speechPanel).toBeVisible()
  await expect.poll(() => speechPanel.getByLabel('音色').locator('option').count()).toBeGreaterThan(1)
  await speechPanel.getByLabel('音色').selectOption({ index: 1 })
  await speechPanel.getByLabel('语速').selectOption('1.25')
  await speechPanel.getByLabel('语调').selectOption('0.9')
  await page.evaluate(() => {
    const synthesis = window.speechSynthesis as SpeechSynthesis & { spokenText?: string; spokenPitch?: number; pausedForTest?: boolean }
    Object.defineProperties(synthesis, {
      speak: {
        configurable: true,
        value: (utterance: SpeechSynthesisUtterance) => {
          synthesis.spokenText = `${synthesis.spokenText ?? ''}${utterance.text}`
          synthesis.spokenPitch = utterance.pitch
          window.setTimeout(() => utterance.onstart?.({ utterance } as SpeechSynthesisEvent), 0)
        },
      },
      cancel: { configurable: true, value: () => { synthesis.spokenText = ''; synthesis.pausedForTest = false } },
      pause: { configurable: true, value: () => { synthesis.pausedForTest = true } },
      resume: { configurable: true, value: () => { synthesis.pausedForTest = false } },
    })
  })
  await speechPanel.getByRole('button', { name: '开始朗读' }).click()
  await expect(speechPanel.getByRole('status')).toContainText('第 1 / 1 段')
  await expect.poll(() => page.evaluate(() => (window.speechSynthesis as SpeechSynthesis & { spokenText?: string }).spokenText)).toContain('Reader controls test')
  await expect.poll(() => page.evaluate(() => (window.speechSynthesis as SpeechSynthesis & { spokenPitch?: number }).spokenPitch)).toBeCloseTo(0.9, 2)
  await speechPanel.getByRole('button', { name: '暂停' }).click()
  await expect(speechPanel.getByRole('button', { name: '继续' })).toBeVisible()
  await speechPanel.getByRole('button', { name: '继续' }).click()
  await speechPanel.getByRole('button', { name: '停止' }).click()
  await expect(speechPanel.getByRole('button', { name: '停止' })).toBeDisabled()
  await speechPanel.getByRole('button', { name: '关闭侧栏' }).click()
  expect(await readerToolbar.evaluate((element) => getComputedStyle(element).scrollbarColor)).not.toBe('auto')
  const readerNavigation = page.locator('.pdf-navigation, .epub-navigation')
  await expect(readerNavigation).toBeVisible()
  await readerToolbar.getByRole('button', { name: '收起阅读工具' }).click()
  await expect(readerToolbar).toHaveAttribute('aria-hidden', 'true')
  await expect(readerNavigation).toHaveClass(/is-hidden/)
  await page.getByRole('button', { name: /显示 (PDF|EPUB) 阅读工具/ }).click()
  await expect(readerNavigation).not.toHaveClass(/is-hidden/)

  await readerToolbar.getByRole('button', { name: '朗读', exact: true }).click()
  await expect(speechPanel.getByText('朗读完成后自动翻页并继续')).toBeVisible()
  await expect(speechPanel.getByRole('checkbox')).toBeChecked()
  await page.evaluate(() => {
    const synthesis = window.speechSynthesis as SpeechSynthesis & { spokenText?: string }
    Object.defineProperties(synthesis, {
      speak: {
        configurable: true,
        value: (utterance: SpeechSynthesisUtterance) => {
          synthesis.spokenText = `${synthesis.spokenText ?? ''}${utterance.text}`
          window.setTimeout(() => utterance.onstart?.({ utterance } as SpeechSynthesisEvent), 0)
          window.setTimeout(() => utterance.onend?.({ utterance } as SpeechSynthesisEvent), 5)
        },
      },
      cancel: { configurable: true, value: () => { synthesis.spokenText = '' } },
    })
  })
  await speechPanel.getByRole('button', { name: '开始朗读' }).click()
  await expect(page.getByRole('spinbutton', { name: '当前页码' })).toHaveValue('2')
  await expect.poll(() => page.evaluate(() => (window.speechSynthesis as SpeechSynthesis & { spokenText?: string }).spokenText)).toContain('Automatic reading second')
  await capture(page, testInfo, 'reader-controls')
})

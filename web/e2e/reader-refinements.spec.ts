import { expect, test, type Locator, type Page } from '@playwright/test'
import { EPUB_PREFERENCES_KEY } from '../src/epub'
import { PDF_PREFERENCES_KEY } from '../src/pdf'
import { refinementEPUB, refinementPDF, refinementSpeechPDF } from './support/reader-refinements'

test.use({ serviceWorkers: 'block' })

// Every API is intercepted, including progress mutations. These original,
// generated books never use a real account, book file, or running database.
const bookID = 920401
const typographyKey = 'peufmreader.epub.typography.v1'
type Position = Record<string, unknown>
type Snapshot = { position: Position; overallProgress: number; status?: string }
type SyntheticMark = {
  id: number; bookFileId: number; kind: 'bookmark' | 'highlight'; label: string
  position: Position; overallProgress: number; body: string; quote: string; color?: string
}

async function mockReader(page: Page, format: 'pdf' | 'epub', options: { position?: Position; marks?: SyntheticMark[]; pageHeights?: number[]; speech?: boolean } = {}) {
  const content = format === 'pdf' ? options.speech ? refinementSpeechPDF() : refinementPDF(options.pageHeights) : refinementEPUB({ speech: options.speech })
  const book = {
    id: bookID, workId: bookID, editionId: bookID, title: '阅读器增强原创回归样本', authors: ['合成测试'],
    format, mimeType: format === 'pdf' ? 'application/pdf' : 'application/epub+zip',
    sizeBytes: content.byteLength, originalFilename: `reader-refinements.${format}`, storageMode: 'managed',
    categories: [], reviewRequired: false, textAvailable: true, pageCount: format === 'pdf' ? options.pageHeights?.length ?? 3 : undefined,
    createdAt: '2026-10-04T00:00:00Z',
  }
  let readingState = {
    bookFileId: bookID, position: options.position ?? (format === 'pdf' ? { pageIndex: 0 } : {}),
    overallProgress: 0.2, status: 'reading', totalActiveSeconds: 0, updatedAt: '2026-10-04T00:00:00Z',
  }
  const writes: Snapshot[] = []
  let contentRequests = 0
  await page.route('**/api/v1/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let data: unknown = { items: [] }
    if (path === '/api/v1/auth/me') data = { user: { id: 920400, username: '阅读器合成测试', role: 'user' }, csrfToken: 'reader-refinements-test' }
    else if (path === `/api/v1/book-files/${bookID}`) data = { book, description: '全部内容为原创合成测试样本。', readingState, favorite: false, readerCount: 1, favoriteCount: 0, totalActiveSeconds: 0 }
    else if (path === `/api/v1/book-files/${bookID}/content`) {
      contentRequests += 1
      return route.fulfill({ status: 200, contentType: book.mimeType, body: content })
    } else if (path === `/api/v1/book-files/${bookID}/progress`) {
      if (request.method() === 'PUT') {
        const input = request.postDataJSON() as Snapshot
        writes.push(input)
        readingState = { ...readingState, ...input, status: input.status ?? readingState.status }
      }
      data = readingState
    } else if (path === `/api/v1/book-files/${bookID}/marks`) data = { items: options.marks ?? [] }
    else if (path.includes('/reading-sessions')) data = { id: 920402, bookFileId: bookID, startedAt: '2026-10-04T00:00:00Z', lastHeartbeatAt: '2026-10-04T00:00:00Z', activeSeconds: 0 }
    else if (path === '/api/v1/recommendations') data = { items: [], personalized: false }
    else if (path === '/api/v1/auth/providers') data = { oidc: false, ldap: false }
    await route.fulfill({ status: 200, json: data })
  })
  return { writes, contentRequests: () => contentRequests }
}

async function seedStorage(page: Page, values: Record<string, unknown>) {
  await page.addInitScript(values => {
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, JSON.stringify(value))
  }, values)
}

async function openReader(page: Page, format: 'pdf' | 'epub') {
  await page.goto(`/#/book/${bookID}`)
  await page.locator('.detail-actions .primary').click()
  if (format === 'pdf') await expect(page.locator('.pdf-page-shell.rendered').first()).toBeVisible()
  else {
    await expect(page.locator('.epub-host')).toHaveAttribute('aria-busy', 'false')
    await expect(page.locator('.epub-host iframe').first()).toBeAttached()
  }
  await revealTools(page, format)
}

async function revealTools(page: Page, format: 'pdf' | 'epub') {
  const toolbar = page.locator(`.${format}-toolbar[role="toolbar"]`)
  if (await toolbar.getAttribute('aria-hidden') === 'true') await page.keyboard.press('Tab')
  await expect(toolbar).not.toHaveAttribute('aria-hidden', 'true')
  return toolbar
}

async function pdfAnchor(page: Page, pageNumber: number) {
  return page.locator('.pdf-reader-viewport').evaluate((viewport, pageNumber) => {
    const shell = viewport.querySelector<HTMLElement>(`[data-pdf-page="${pageNumber}"]`)
    if (!shell) throw new Error(`Missing PDF page ${pageNumber}`)
    const bounds = shell.getBoundingClientRect()
    return (viewport.getBoundingClientRect().top + 24 - bounds.top) / bounds.height
  }, pageNumber)
}

async function expectPDFAnchor(page: Page, pageNumber: number, yRatio: number) {
  await expect(page.locator(`.pdf-page-shell[data-pdf-page="${pageNumber}"].rendered`)).toBeVisible()
  await expect.poll(async () => Math.abs(await pdfAnchor(page, pageNumber) - yRatio)).toBeLessThan(0.04)
}

async function scrollPDFTo(page: Page, pageNumber: number, yRatio: number) {
  await page.locator('.pdf-reader-viewport').evaluate((viewport, target) => {
    const shell = viewport.querySelector<HTMLElement>(`[data-pdf-page="${target.pageNumber}"]`)
    if (!shell) throw new Error(`Missing PDF page ${target.pageNumber}`)
    const bounds = shell.getBoundingClientRect()
    viewport.scrollTop += bounds.top - viewport.getBoundingClientRect().top - 24 + bounds.height * target.yRatio
  }, { pageNumber, yRatio })
  await expectPDFAnchor(page, pageNumber, yRatio)
}

async function pdfHistory(page: Page, direction: 'back' | 'forward') {
  const toolbar = await revealTools(page, 'pdf')
  await toolbar.getByRole('button', { name: direction === 'back' ? '返回刚才位置' : '前进到跳转位置', exact: true }).click()
}

async function selectEPUBChapter(page: Page, name: string) {
  const toolbar = await revealTools(page, 'epub')
  await toolbar.getByRole('button', { name: '目录', exact: true }).click()
  await page.getByRole('complementary', { name: 'EPUB 目录' }).getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'EPUB 目录' })).toHaveCount(0)
  await expectEPUBChapter(page, name)
}

async function expectEPUBChapter(page: Page, name: string) {
  await expect(page.locator('.epub-reader')).toHaveAttribute('aria-busy', 'false')
  const toolbar = await revealTools(page, 'epub')
  await toolbar.getByRole('button', { name: '目录', exact: true }).click()
  const toc = page.getByRole('complementary', { name: 'EPUB 目录' })
  await expect(toc.locator('[aria-current="location"]')).toHaveCount(1)
  await expect(toc.getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'location')
  await toc.getByRole('button', { name: '关闭侧栏', exact: true }).click()
}

async function epubHistory(page: Page, direction: 'back' | 'forward') {
  await revealTools(page, 'epub')
  await page.locator('.epub-navigation').getByRole('button', { name: direction === 'back' ? '返回刚才位置' : '前进到跳转位置', exact: true }).click()
  await expect(page.locator('.epub-reader')).toHaveAttribute('aria-busy', 'false')
}

async function setRange(range: Locator, value: string) {
  await range.evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('Native range setter is unavailable')
    setter.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
  await expect(range).toHaveValue(value)
}

async function mockSpeech(page: Page) {
  await page.addInitScript(() => {
    type TestSpeech = SpeechSynthesis & { syntheticSpoken: string[]; syntheticCancelCount: number }
    const synthesis = window.speechSynthesis as TestSpeech
    synthesis.syntheticSpoken = []
    synthesis.syntheticCancelCount = 0
    Object.defineProperties(synthesis, {
      // English sources may use the browser's automatic voice. Do not return
      // plain objects as SpeechSynthesisVoice: native utterance.voice setters
      // require a browser-branded instance even though speak() is intercepted.
      getVoices: { configurable: true, value: () => [] },
      speak: {
        configurable: true,
        value: (utterance: SpeechSynthesisUtterance) => {
          synthesis.syntheticSpoken.push(utterance.text)
          const run = synthesis.syntheticCancelCount
          window.setTimeout(() => {
            if (run === synthesis.syntheticCancelCount) utterance.onstart?.({ utterance } as SpeechSynthesisEvent)
          }, 0)
          window.setTimeout(() => {
            if (run === synthesis.syntheticCancelCount) utterance.onend?.({ utterance } as SpeechSynthesisEvent)
          }, 5)
        },
      },
      cancel: { configurable: true, value: () => { synthesis.syntheticCancelCount += 1 } },
      pause: { configurable: true, value: () => {} },
      resume: { configurable: true, value: () => {} },
    })
  })
}

async function speechTranscript(page: Page) {
  return page.evaluate(() => (window.speechSynthesis as SpeechSynthesis & { syntheticSpoken: string[] }).syntheticSpoken.join(' '))
}

async function speechCancelCount(page: Page) {
  return page.evaluate(() => (window.speechSynthesis as SpeechSynthesis & { syntheticCancelCount: number }).syntheticCancelCount)
}

async function expectPDFHorizontallyVisible(page: Page, pageNumber: number) {
  await expect.poll(() => page.locator('.pdf-reader-viewport').evaluate((viewport, pageNumber) => {
    const shell = viewport.querySelector<HTMLElement>(`[data-pdf-page="${pageNumber}"]`)
    if (!shell) return false
    const bounds = viewport.getBoundingClientRect()
    const pageBounds = shell.getBoundingClientRect()
    const center = bounds.left + bounds.width / 2
    return pageBounds.left < center && pageBounds.right > center
  }, pageNumber)).toBe(true)
}

for (const flow of ['paged', 'continuous'] as const) {
  test(`PDF restores and persists an in-page anchor in ${flow} flow`, async ({ page }) => {
    await seedStorage(page, { [PDF_PREFERENCES_KEY]: { flow, layout: 'single', zoomMode: 'fit-width', zoomPercent: 100 } })
    const harness = await mockReader(page, 'pdf', { position: { pageIndex: 1, yRatio: 0.43 } })
    await openReader(page, 'pdf')
    await expectPDFAnchor(page, 2, 0.43)
    // Restoring an existing anchor is not new reading activity. Observe past
    // the 600ms persistence debounce before making the first deliberate scroll.
    await page.waitForTimeout(750)
    expect(harness.writes).toHaveLength(0)
    await scrollPDFTo(page, 2, 0.61)
    await expect.poll(() => harness.writes.at(-1)?.position.pageIndex).toBe(1)
    await expect.poll(() => Math.abs(Number(harness.writes.at(-1)?.position.yRatio) - 0.61)).toBeLessThan(0.04)
    // Reopening consumes the captured API state, not just the browser's current
    // scroll position, and must not revert to the beginning of the page.
    await page.reload()
    await page.locator('.detail-actions .primary').click()
    await expectPDFAnchor(page, 2, 0.61)
  })
}

test('PDF zoom, viewport rotation and flow changes preserve the same page anchor', async ({ page }) => {
  await seedStorage(page, { [PDF_PREFERENCES_KEY]: { flow: 'continuous', layout: 'single', zoomMode: 'fit-width', zoomPercent: 100 } })
  const harness = await mockReader(page, 'pdf', { position: { pageIndex: 1, yRatio: 0.42 } })
  await openReader(page, 'pdf')
  await expectPDFAnchor(page, 2, 0.42)
  await page.waitForTimeout(750)
  const writeCount = harness.writes.length
  const widthBefore = await page.locator('[data-pdf-page="2"]').evaluate(element => element.getBoundingClientRect().width)
  let toolbar = await revealTools(page, 'pdf')
  await toolbar.getByRole('button', { name: '放大', exact: true }).click()
  await expect.poll(async () => Math.abs(await page.locator('[data-pdf-page="2"]').evaluate(element => element.getBoundingClientRect().width) - widthBefore)).toBeGreaterThan(20)
  await expectPDFAnchor(page, 2, 0.42)
  const originalViewport = page.viewportSize()!
  await page.setViewportSize({ width: originalViewport.height, height: originalViewport.width })
  await expectPDFAnchor(page, 2, 0.42)
  await page.setViewportSize(originalViewport)
  await expectPDFAnchor(page, 2, 0.42)
  await page.waitForTimeout(750)
  expect(harness.writes).toHaveLength(writeCount)
  await expectPDFAnchor(page, 2, 0.42)
  toolbar = await revealTools(page, 'pdf')
  await toolbar.getByRole('button', { name: '分页', exact: true }).click()
  await expect(page.locator('.pdf-pages')).toHaveClass(/paged/)
  await expectPDFAnchor(page, 2, 0.42)
})

test('PDF highlight rects locate the passage and A/B/C history preserves every anchor', async ({ page }, info) => {
  await seedStorage(page, { [PDF_PREFERENCES_KEY]: { flow: 'continuous', layout: 'single', zoomMode: 'fit-width', zoomPercent: 100 } })
  const marks: SyntheticMark[] = [
    { id: 920410, bookFileId: bookID, kind: 'highlight', label: '第二页中段摘录', position: { pageIndex: 1, rects: [{ x: 0.1, y: 0.7, width: 0.6, height: 0.02 }] }, overallProgress: 0.6, color: 'yellow', body: '', quote: 'Original page 2 mid-page passage.' },
    { id: 920411, bookFileId: bookID, kind: 'bookmark', label: '第三页页内书签', position: { pageIndex: 2, yRatio: 0.45 }, overallProgress: 0.8, body: '', quote: '' },
  ]
  await mockReader(page, 'pdf', { position: { pageIndex: 0, yRatio: 0.24 }, marks })
  await openReader(page, 'pdf')
  await expectPDFAnchor(page, 1, 0.24)
  const navigateMark = async (label: string) => {
    const toolbar = await revealTools(page, 'pdf')
    await toolbar.getByRole('button', { name: '书签/高亮', exact: true }).click()
    await page.getByRole('complementary', { name: '书签、高亮和笔记' }).locator('.reading-mark-location').filter({ hasText: label }).click()
  }
  await navigateMark('第二页中段摘录')
  await expectPDFAnchor(page, 2, 0.7)
  const highlight = page.locator('[data-pdf-page="2"] .pdf-highlight')
  await expect(highlight).toHaveCount(1)
  const toolbar = await revealTools(page, 'pdf')
  await toolbar.getByRole('button', { name: '收起阅读工具', exact: true }).click()
  await expect(toolbar).toHaveAttribute('aria-hidden', 'true')
  await expect(toolbar).toHaveCSS('opacity', '0')
  expect(await highlight.evaluate(element => {
    const viewport = document.querySelector('.pdf-reader-viewport')!.getBoundingClientRect()
    const bounds = element.getBoundingClientRect()
    return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom && bounds.right > viewport.left && bounds.left < viewport.right
  })).toBe(true)
  await page.screenshot({ path: info.outputPath('pdf-highlight-anchor.png') })
  await navigateMark('第三页页内书签')
  await expectPDFAnchor(page, 3, 0.45)
  await pdfHistory(page, 'back')
  await expectPDFAnchor(page, 2, 0.7)
  await pdfHistory(page, 'back')
  await expectPDFAnchor(page, 1, 0.24)
  await pdfHistory(page, 'forward')
  await expectPDFAnchor(page, 2, 0.7)
  await pdfHistory(page, 'forward')
  await expectPDFAnchor(page, 3, 0.45)
})

test('PDF legacy page-only progress opens at the page start and ordinary page turns do not create history', async ({ page }) => {
  await mockReader(page, 'pdf', { position: { pageIndex: 1 } })
  await openReader(page, 'pdf')
  await expectPDFAnchor(page, 2, 0)
  let toolbar = await revealTools(page, 'pdf')
  await expect(toolbar.getByRole('button', { name: '返回刚才位置', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page.locator('input[aria-label="当前页码"]')).toHaveValue('3')
  toolbar = await revealTools(page, 'pdf')
  await expect(toolbar.getByRole('button', { name: '返回刚才位置', exact: true })).toBeDisabled()
  const pageInput = page.locator('input[aria-label="当前页码"]')
  await pageInput.fill('1')
  await pageInput.press('Enter')
  await expectPDFAnchor(page, 1, 0)
  await pdfHistory(page, 'back')
  await expectPDFAnchor(page, 3, 0)
})

test('PDF paged history restores the anchor after remounting pages with different dimensions', async ({ page }) => {
  await mockReader(page, 'pdf', { position: { pageIndex: 1, yRatio: 0.43 }, pageHeights: [2000, 4000, 3000] })
  await openReader(page, 'pdf')
  await expectPDFAnchor(page, 2, 0.43)
  const pageInput = page.locator('input[aria-label="当前页码"]')
  await pageInput.fill('3')
  await pageInput.press('Enter')
  await expectPDFAnchor(page, 3, 0)
  await pdfHistory(page, 'back')
  await expectPDFAnchor(page, 2, 0.43)
  await pdfHistory(page, 'forward')
  await expectPDFAnchor(page, 3, 0)
})

test('PDF clicking active fit-width and single-page options does not undo the next deliberate scroll', async ({ page }) => {
  await mockReader(page, 'pdf', { position: { pageIndex: 1, yRatio: 0.28 } })
  await openReader(page, 'pdf')
  await expectPDFAnchor(page, 2, 0.28)
  const toolbar = await revealTools(page, 'pdf')
  await expect(toolbar.getByRole('button', { name: '适宽', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await toolbar.getByRole('button', { name: '适宽', exact: true }).click()
  await toolbar.getByRole('button', { name: '单页', exact: true }).click()
  await scrollPDFTo(page, 2, 0.52)
  await page.waitForTimeout(750)
  await expectPDFAnchor(page, 2, 0.52)
})

test('PDF wide spreads restore and navigate to the horizontally visible right-hand page', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 })
  await seedStorage(page, { [PDF_PREFERENCES_KEY]: { flow: 'paged', layout: 'spread', zoomMode: 'custom', zoomPercent: 200 } })
  await mockReader(page, 'pdf', { position: { pageIndex: 2, yRatio: 0.36 }, pageHeights: [2000, 4000, 3000] })
  await openReader(page, 'pdf')
  await expect(page.locator('input[aria-label="当前页码"]')).toHaveValue('3')
  await expectPDFAnchor(page, 3, 0.36)
  await expectPDFHorizontallyVisible(page, 3)
  const pageInput = page.locator('input[aria-label="当前页码"]')
  await pageInput.fill('2')
  await pageInput.press('Enter')
  await expectPDFAnchor(page, 2, 0)
  await expectPDFHorizontallyVisible(page, 2)
  await scrollPDFTo(page, 2, 0.22)
  await revealTools(page, 'pdf')
  await pageInput.fill('3')
  await pageInput.press('Enter')
  await expectPDFAnchor(page, 3, 0)
  await expectPDFHorizontallyVisible(page, 3)
  await pdfHistory(page, 'back')
  await expectPDFAnchor(page, 2, 0.22)
  await expectPDFHorizontallyVisible(page, 2)
  await pdfHistory(page, 'forward')
  await expectPDFAnchor(page, 3, 0)
  await expectPDFHorizontallyVisible(page, 3)
})

test('EPUB typography preserves legacy preferences, chapter and CFI without redownloading the book', async ({ page }, info) => {
  const legacy = { flow: 'paged', layout: 'single', fontSize: 120, theme: 'sepia' }
  const pdfPreferences = { flow: 'continuous', layout: 'single', zoomMode: 'custom', zoomPercent: 130 }
  await seedStorage(page, { [EPUB_PREFERENCES_KEY]: legacy, [PDF_PREFERENCES_KEY]: pdfPreferences })
  const harness = await mockReader(page, 'epub', { position: { href: 'two.xhtml', chapterIndex: 1 } })
  await openReader(page, 'epub')
  await expectEPUBChapter(page, 'Chapter Two')
  await expect(page.locator('.epub-reader')).toHaveClass(/theme-sepia/)
  await expect.poll(() => harness.writes.at(-1)?.position.cfi).toMatch(/^epubcfi\(/)
  const initialCFI = harness.writes.at(-1)?.position.cfi
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect.poll(() => harness.writes.at(-1)?.position.cfi).not.toBe(initialCFI)
  const before = harness.writes.at(-1)!
  const downloads = harness.contentRequests()
  const toolbar = await revealTools(page, 'epub')
  await toolbar.getByRole('button', { name: '排版', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'EPUB 排版设置' })
  await panel.getByRole('combobox', { name: '正文字体', exact: true }).selectOption('sans')
  await setRange(panel.getByRole('slider', { name: '行距', exact: true }), '1.9')
  await setRange(panel.getByRole('slider', { name: '段距', exact: true }), '1.2')
  await setRange(panel.getByRole('slider', { name: '左右留白', exact: true }), '6')
  await setRange(panel.getByRole('slider', { name: '最大行宽', exact: true }), '60')
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}'), typographyKey)).toEqual({ fontFamily: 'sans', lineHeight: 1.9, paragraphSpacing: 1.2, sideMargin: 6, maxLineWidth: 60, respectBookStyles: false })
  const paragraph = page.locator('.epub-host iframe').first().contentFrame().locator('p').first()
  await expect.poll(() => paragraph.evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/sans-serif/)
  await expect(page.locator('.epub-reader-feedback')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('epub-typography-panel.png') })
  await panel.getByRole('button', { name: '关闭侧栏', exact: true }).click()
  await expectEPUBChapter(page, 'Chapter Two')
  await expect.poll(() => harness.writes.at(-1)?.position.cfi).toMatch(/^epubcfi\(/)
  await expect.poll(() => Math.abs((harness.writes.at(-1)?.overallProgress ?? 0) - before.overallProgress)).toBeLessThan(0.06)
  expect(harness.contentRequests()).toBe(downloads)
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), EPUB_PREFERENCES_KEY)).toEqual(legacy)
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), PDF_PREFERENCES_KEY)).toEqual(pdfPreferences)
  await (await revealTools(page, 'epub')).getByRole('button', { name: '排版', exact: true }).click()
  await panel.getByRole('checkbox', { name: '尊重原书排版', exact: true }).check()
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').respectBookStyles, typographyKey)).toBe(true)
  await expect(page.locator('.epub-reader-feedback')).toHaveCount(0)
  await expect.poll(() => paragraph.evaluate(element => getComputedStyle(element).fontFamily)).not.toMatch(/sans-serif/)
  await expect.poll(() => paragraph.evaluate(element => {
    const style = getComputedStyle(element)
    return Number.parseFloat(style.lineHeight) / Number.parseFloat(style.fontSize)
  })).toBeCloseTo(1.4, 1)
  await panel.getByRole('button', { name: '重置排版', exact: true }).click()
  await expect(panel.getByRole('combobox', { name: '正文字体', exact: true })).toHaveValue('serif')
  await expect(panel.getByRole('slider', { name: '行距', exact: true })).toHaveValue('1.7')
  await expect(panel.getByRole('checkbox', { name: '尊重原书排版', exact: true })).not.toBeChecked()
  expect(harness.contentRequests()).toBe(downloads)
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect((await revealTools(page, 'epub')).getByRole('button', { name: '排版', exact: true })).toBeFocused()
})

test('EPUB typography remains usable when reader preference storage is rejected', async ({ page }) => {
  await page.addInitScript(blockedKeys => {
    const originalGetItem = Storage.prototype.getItem
    const originalSetItem = Storage.prototype.setItem
    Storage.prototype.getItem = function (key) {
      if (blockedKeys.includes(key)) throw new DOMException('Synthetic reader preference restriction', 'SecurityError')
      return originalGetItem.call(this, key)
    }
    Storage.prototype.setItem = function (key, value) {
      if (blockedKeys.includes(key)) throw new DOMException('Synthetic reader preference restriction', 'SecurityError')
      originalSetItem.call(this, key, value)
    }
  }, [EPUB_PREFERENCES_KEY, typographyKey])
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await mockReader(page, 'epub')
  await openReader(page, 'epub')
  await (await revealTools(page, 'epub')).getByRole('button', { name: '排版', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'EPUB 排版设置' })
  await panel.getByRole('combobox', { name: '正文字体', exact: true }).selectOption('sans')
  await setRange(panel.getByRole('slider', { name: '行距', exact: true }), '2')
  await panel.getByRole('button', { name: '关闭侧栏', exact: true }).click()
  await expectEPUBChapter(page, 'Chapter One')
  expect(errors).toEqual([])
})

test('EPUB current chapter and A/B/C return-forward history follow explicit jumps, not ordinary page turns', async ({ page }) => {
  const harness = await mockReader(page, 'epub')
  await openReader(page, 'epub')
  await expectEPUBChapter(page, 'Chapter One')
  await expect.poll(() => harness.writes.at(-1)?.position.cfi).toMatch(/^epubcfi\(/)
  const initialCFI = harness.writes.at(-1)?.position.cfi
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect.poll(() => harness.writes.at(-1)?.position.cfi).not.toBe(initialCFI)
  await expectEPUBChapter(page, 'Chapter One')
  await revealTools(page, 'epub')
  await expect(page.locator('.epub-navigation').getByRole('button', { name: '返回刚才位置', exact: true })).toBeDisabled()
  await selectEPUBChapter(page, 'Chapter Two')
  await selectEPUBChapter(page, 'Chapter Three')
  await epubHistory(page, 'back')
  await expectEPUBChapter(page, 'Chapter Two')
  await epubHistory(page, 'back')
  await expectEPUBChapter(page, 'Chapter One')
  await epubHistory(page, 'forward')
  await expectEPUBChapter(page, 'Chapter Two')
  await epubHistory(page, 'forward')
  await expectEPUBChapter(page, 'Chapter Three')
  await epubHistory(page, 'back')
  await selectEPUBChapter(page, 'Chapter One')
  await revealTools(page, 'epub')
  await expect(page.locator('.epub-navigation').getByRole('button', { name: '前进到跳转位置', exact: true })).toBeDisabled()
})

test('EPUB search, saved marks and percentage jumps can return to the original reading location', async ({ page }) => {
  const marks: SyntheticMark[] = [{ id: 920420, bookFileId: bookID, kind: 'bookmark', label: '第二章合成书签', position: { href: 'two.xhtml', chapterIndex: 1 }, overallProgress: 0.34, body: '', quote: '' }]
  const harness = await mockReader(page, 'epub', { marks })
  await openReader(page, 'epub')
  let toolbar = await revealTools(page, 'epub')
  await toolbar.getByRole('button', { name: '书内搜索', exact: true }).click()
  const search = page.getByRole('complementary', { name: 'EPUB 书内搜索' })
  await search.getByRole('textbox', { name: '搜索 EPUB 正文', exact: true }).fill('NeedleInThirdChapter')
  await search.getByRole('button', { name: '搜索', exact: true }).click()
  await search.locator('.reader-search-results button').first().click()
  await expect(search).toHaveCount(0)
  await expectEPUBChapter(page, 'Chapter Three')
  await epubHistory(page, 'back')
  await expectEPUBChapter(page, 'Chapter One')
  toolbar = await revealTools(page, 'epub')
  await toolbar.getByRole('button', { name: '书签/高亮', exact: true }).click()
  const marksPanel = page.getByRole('complementary', { name: '书签、高亮和笔记' })
  await marksPanel.locator('.reading-mark-location').filter({ hasText: '第二章合成书签' }).click()
  await expect(marksPanel).toHaveCount(0)
  await expectEPUBChapter(page, 'Chapter Two')
  await epubHistory(page, 'back')
  await expectEPUBChapter(page, 'Chapter One')
  await revealTools(page, 'epub')
  await page.locator('.epub-navigation').getByRole('button', { name: '跳转阅读进度', exact: true }).click()
  const progress = page.getByRole('complementary', { name: 'EPUB 进度跳转' })
  await setRange(progress.getByRole('slider', { name: '目标阅读进度', exact: true }), '80')
  await progress.getByRole('button', { name: '确认跳转', exact: true }).click()
  await expect(progress).toHaveCount(0)
  await expectEPUBChapter(page, 'Chapter Three')
  await expect.poll(() => harness.writes.at(-1)?.overallProgress ?? 0).toBeGreaterThan(0.7)
  await epubHistory(page, 'back')
  await expectEPUBChapter(page, 'Chapter One')
})

test('EPUB rapid typography changes back to the original value do not lock page turns', async ({ page }) => {
  const harness = await mockReader(page, 'epub')
  await openReader(page, 'epub')
  await expect.poll(() => harness.writes.at(-1)?.position.cfi).toMatch(/^epubcfi\(/)
  const before = harness.writes.at(-1)?.position.cfi
  await (await revealTools(page, 'epub')).getByRole('button', { name: '排版', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'EPUB 排版设置' })
  const range = panel.getByRole('slider', { name: '行距', exact: true })
  await range.evaluate(async element => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('Native range setter is unavailable')
    for (const value of ['1.8', '1.7']) {
      setter.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      if (value === '1.8') await new Promise(resolve => window.setTimeout(resolve, 40))
    }
  })
  await expect(range).toHaveValue('1.7')
  await expect(page.locator('.epub-reader-feedback')).toHaveCount(0)
  await panel.getByRole('button', { name: '关闭侧栏', exact: true }).click()
  await revealTools(page, 'epub')
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect.poll(() => harness.writes.at(-1)?.position.cfi).not.toBe(before)
  await expectEPUBChapter(page, 'Chapter One')
})

test('EPUB continuous scroll immediately followed by typography changes keeps the visible paragraph', async ({ page }) => {
  await seedStorage(page, { [EPUB_PREFERENCES_KEY]: { flow: 'continuous', layout: 'single', fontSize: 100, theme: 'paper' } })
  await mockReader(page, 'epub', { position: { href: 'one.xhtml', chapterIndex: 0 } })
  await openReader(page, 'epub')
  await expectEPUBChapter(page, 'Chapter One')
  await (await revealTools(page, 'epub')).getByRole('button', { name: '排版', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'EPUB 排版设置' })
  const immediateAnchor = await page.evaluate(() => {
    const container = document.querySelector<HTMLElement>('.epub-host .epub-container')
    const frame = Array.from(document.querySelectorAll<HTMLIFrameElement>('.epub-host iframe')).find(frame => frame.contentDocument?.querySelector('h1')?.textContent === 'Chapter One')
    const paragraph = frame?.contentDocument?.getElementById('paragraph-12')
    const range = document.querySelector<HTMLInputElement>('.epub-typography-panel input[aria-label="行距"]')
    if (!container || !frame || !paragraph || !range) throw new Error('Missing continuous EPUB scroll fixture or typography control')
    const offset = frame.getBoundingClientRect().top + paragraph.getBoundingClientRect().top - container.getBoundingClientRect().top
    container.scrollTop += offset
    container.dispatchEvent(new Event('scroll'))
    const visibleTop = frame.getBoundingClientRect().top + paragraph.getBoundingClientRect().top - container.getBoundingClientRect().top
    // Both actions happen in one task, before relocated/persistence debounce.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(range, '1.9')
    range.dispatchEvent(new Event('input', { bubbles: true }))
    range.dispatchEvent(new Event('change', { bubbles: true }))
    return visibleTop
  })
  expect(Math.abs(immediateAnchor)).toBeLessThan(4)
  await expect(panel.getByRole('slider', { name: '行距', exact: true })).toHaveValue('1.9')
  // Observe the new stylesheet, not just the slider value or a pre-effect
  // idle state: otherwise this could pass before the reflow actually starts.
  await expect.poll(() => page.evaluate(() => {
    const frame = Array.from(document.querySelectorAll<HTMLIFrameElement>('.epub-host iframe')).find(frame => frame.contentDocument?.querySelector('h1')?.textContent === 'Chapter One')
    const paragraph = frame?.contentDocument?.getElementById('paragraph-12')
    if (!paragraph) return 0
    const style = getComputedStyle(paragraph)
    return Number.parseFloat(style.lineHeight) / Number.parseFloat(style.fontSize)
  })).toBeCloseTo(1.9, 1)
  await expect(page.locator('.epub-reader')).toHaveAttribute('aria-busy', 'false')
  await expect.poll(() => page.evaluate(() => {
    const container = document.querySelector<HTMLElement>('.epub-host .epub-container')
    const frame = Array.from(document.querySelectorAll<HTMLIFrameElement>('.epub-host iframe')).find(frame => frame.contentDocument?.querySelector('h1')?.textContent === 'Chapter One')
    const paragraph = frame?.contentDocument?.getElementById('paragraph-12')
    if (!container || !frame || !paragraph) return false
    const bounds = paragraph.getBoundingClientRect()
    const top = frame.getBoundingClientRect().top + bounds.top - container.getBoundingClientRect().top
    const lineHeight = Number.parseFloat(getComputedStyle(paragraph).lineHeight)
    return top > -lineHeight * 2 && top < lineHeight * 2 && top + bounds.height > 0
  })).toBe(true)
  await panel.getByRole('button', { name: '关闭侧栏', exact: true }).click()
  await expectEPUBChapter(page, 'Chapter One')
})

test('EPUB landscape progress panel keeps the confirmation reachable and jumps successfully', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 390 })
  await mockReader(page, 'epub')
  await openReader(page, 'epub')
  await page.locator('.epub-navigation').getByRole('button', { name: '跳转阅读进度', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'EPUB 进度跳转' })
  await setRange(panel.getByRole('slider', { name: '目标阅读进度', exact: true }), '80')
  const confirm = panel.getByRole('button', { name: '确认跳转', exact: true })
  await confirm.scrollIntoViewIfNeeded()
  const bounds = await confirm.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(391)
  await confirm.click()
  await expect(panel).toHaveCount(0)
  await expectEPUBChapter(page, 'Chapter Three')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
})

test('PDF continuous speech automatically crosses pages without adding jump history', async ({ page }) => {
  await mockSpeech(page)
  const harness = await mockReader(page, 'pdf', { speech: true, position: { pageIndex: 0 } })
  await openReader(page, 'pdf')
  const toolbar = await revealTools(page, 'pdf')
  await toolbar.getByRole('button', { name: '朗读', exact: true }).click()
  const speech = page.getByRole('complementary', { name: '浏览器即时朗读' })
  await expect(speech.getByRole('checkbox')).toBeChecked()
  const cancellations = await speechCancelCount(page)
  await speech.getByRole('button', { name: '开始朗读', exact: true }).click()
  await expect.poll(() => speechTranscript(page)).toContain('Original speech page Three')
  const transcript = await speechTranscript(page)
  expect(transcript).toContain('Original speech page One')
  expect(transcript).toContain('Original speech page Two')
  await expect(page.locator('input[aria-label="当前页码"]')).toHaveValue('3')
  await expect(speech.getByRole('button', { name: '停止', exact: true })).toBeDisabled()
  expect(await speechCancelCount(page)).toBe(cancellations + 1)
  await expect.poll(() => harness.writes.at(-1)?.position.pageIndex).toBe(2)
  await speech.getByRole('button', { name: '关闭侧栏', exact: true }).click()
  await expect((await revealTools(page, 'pdf')).getByRole('button', { name: '返回刚才位置', exact: true })).toBeDisabled()
  await expect((await revealTools(page, 'pdf')).getByRole('button', { name: '前进到跳转位置', exact: true })).toBeDisabled()
})

test('EPUB serializes page turns and continuous speech crosses chapters without adding jump history', async ({ page }) => {
  await mockSpeech(page)
  await mockReader(page, 'epub', { speech: true, position: { href: 'one.xhtml', chapterIndex: 0 } })
  await openReader(page, 'epub')
  await expectEPUBChapter(page, 'Chapter One')
  await page.locator('.epub-navigation button[aria-label="下一页"]').evaluate(button => {
    const reader = document.querySelector('.epub-reader')!
    const states: string[] = []
    ;(window as Window & { syntheticReaderBusy?: string[] }).syntheticReaderBusy = states
    const observer = new MutationObserver(() => states.push(reader.getAttribute('aria-busy') ?? ''))
    observer.observe(reader, { attributes: true, attributeFilter: ['aria-busy'] })
    // Repeated input in one task must never skip directly from One to Three.
    for (let index = 0; index < 3; index++) (button as HTMLButtonElement).click()
  })
  await expectEPUBChapter(page, 'Chapter Two')
  await expect.poll(() => page.evaluate(() => (window as Window & { syntheticReaderBusy?: string[] }).syntheticReaderBusy?.includes('true') ?? false)).toBe(true)
  await revealTools(page, 'epub')
  await page.getByRole('button', { name: '上一页', exact: true }).click()
  await expectEPUBChapter(page, 'Chapter One')
  await expect(page.locator('.epub-navigation').getByRole('button', { name: '返回刚才位置', exact: true })).toBeDisabled()
  const toolbar = await revealTools(page, 'epub')
  await toolbar.getByRole('button', { name: '朗读', exact: true }).click()
  const speech = page.getByRole('complementary', { name: '浏览器即时朗读' })
  await expect(speech.getByRole('checkbox')).toBeChecked()
  const cancellations = await speechCancelCount(page)
  await speech.getByRole('button', { name: '开始朗读', exact: true }).click()
  await expect.poll(() => speechTranscript(page)).toContain('Original speech chapter Three')
  const transcript = await speechTranscript(page)
  expect(transcript).toContain('Original speech chapter One')
  expect(transcript).toContain('Original speech chapter Two')
  await expect(speech.getByRole('button', { name: '停止', exact: true })).toBeDisabled()
  expect(await speechCancelCount(page)).toBe(cancellations + 1)
  await speech.getByRole('button', { name: '关闭侧栏', exact: true }).click()
  await expectEPUBChapter(page, 'Chapter Three')
  await expect(page.locator('.epub-navigation').getByRole('button', { name: '返回刚才位置', exact: true })).toBeDisabled()
  await expect(page.locator('.epub-navigation').getByRole('button', { name: '前进到跳转位置', exact: true })).toBeDisabled()
})

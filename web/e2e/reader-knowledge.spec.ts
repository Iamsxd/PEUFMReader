import { expect, test, type Page } from '@playwright/test'
import { refinementEPUB, refinementPDF, refinementSpeechPDF } from './support/reader-refinements'
import type { ReadingMark } from '../src/types'

test.use({ serviceWorkers: 'block' })
const bookID = 951001
async function harness(page: Page, format: 'pdf' | 'epub', options: { large?: boolean; marks?: ReadingMark[]; continuous?: boolean } = {}) {
  const content = format === 'epub' ? refinementEPUB() : options.large ? refinementPDF(Array(400).fill(1200)) : refinementSpeechPDF()
  const book = { id: bookID, editionId: bookID, workId: bookID, title: 'Original knowledge fixture', authors: ['Synthetic'], categories: [], format, mimeType: format === 'pdf' ? 'application/pdf' : 'application/epub+zip', sizeBytes: content.length, originalFilename: `original.${format}`, storageMode: 'managed', createdAt: '2026-10-05T00:00:00Z' }
  const marks = [...(options.marks ?? [])]
  const receipts = new Map<string, ReadingMark | undefined>()
  const mutations: Record<string, unknown>[] = []
  const ranges: string[] = []
  let version = 0
  await page.addInitScript(({ format, continuous }) => {
    localStorage.setItem(`peufmreader.${format}.preferences.v1`, JSON.stringify(format === 'pdf' ? { flow: continuous ? 'continuous' : 'paged', layout: 'single', zoomMode: 'fit-width', zoomPercent: 100 } : { flow: 'continuous', layout: 'single', fontSize: 100, theme: 'paper' }))
  }, { format, continuous: options.continuous })
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname
    let value: unknown = { items: [] }
    if (path === '/api/v1/auth/me') value = { user: { id: 951000, username: 'synthetic', role: 'reader' }, csrfToken: 'original-test' }
    else if (path === `/api/v1/book-files/${bookID}`) value = { book, description: '', readingState: {}, favorite: false }
    else if (path === `/api/v1/book-files/${bookID}/content`) {
      const range = route.request().headers()['range']
      if (range) {
        ranges.push(range)
        const match = /bytes=(\d+)-(\d+)/.exec(range)!
        const start = Number(match[1]), end = Math.min(content.length - 1, Number(match[2]))
        return route.fulfill({ status: 206, headers: { 'Content-Type': book.mimeType, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${content.length}`, 'Content-Length': String(end - start + 1) }, body: content.subarray(start, end + 1) })
      }
      return route.fulfill({ status: 200, headers: { 'Content-Type': book.mimeType, 'Accept-Ranges': 'bytes', 'Content-Length': String(content.length) }, body: content })
    } else if (path.endsWith('/progress')) value = { bookFileId: bookID, position: {}, overallProgress: 0, status: 'reading', totalActiveSeconds: 0 }
    else if (path.endsWith('/marks')) value = { items: marks }
    else if (path === '/api/v1/reading-marks/sync') {
      const input = route.request().postDataJSON()
      mutations.push(input)
      let result = receipts.get(input.operationId)
      if (!receipts.has(input.operationId)) {
        const index = marks.findIndex(mark => mark.id === input.markId)
        result = { ...input.mark, id: index >= 0 ? input.markId : 951020 + marks.length, bookFileId: bookID, updatedAt: `2026-10-05T01:00:${String(++version).padStart(2, '0')}Z` }
        if (input.action === 'delete') { marks.splice(index, 1); result = undefined }
        else if (index >= 0) marks[index] = result!
        else marks.push(result!)
        receipts.set(input.operationId, result)
      }
      value = { mark: result, deleted: input.action === 'delete' }
    } else if (path.includes('reading-sessions')) value = { id: 951010, bookFileId: bookID, activeSeconds: 0 }
    await route.fulfill({ status: 200, json: value })
  })
  return { marks, mutations, ranges }
}
async function open(page: Page, format: 'pdf' | 'epub') {
  await page.goto(`/#/book/${bookID}`)
  await page.locator('.detail-actions .primary').click()
  if (format === 'pdf') await expect(page.locator('.pdf-page-shell.rendered').first()).toBeVisible()
  else await expect(page.locator('.epub-host')).toHaveAttribute('aria-busy', 'false')
  await page.keyboard.press('Tab')
}
async function speechStub(page: Page) {
  await page.addInitScript(() => {
    const speech = window.speechSynthesis as SpeechSynthesis & { testText: string[]; testCancelled: number }
    speech.testText = []; speech.testCancelled = 0
    Object.defineProperties(speech, {
      getVoices: { value: () => [], configurable: true },
      speak: { value: (utterance: SpeechSynthesisUtterance) => { speech.testText.push(utterance.text); utterance.onstart?.({} as SpeechSynthesisEvent) }, configurable: true },
      cancel: { value: () => { speech.testCancelled += 1 }, configurable: true },
      pause: { value: () => {}, configurable: true }, resume: { value: () => {}, configurable: true },
    })
  })
}

test('offline notes stay local until reconnect, then replay once', async ({ page }) => {
  const fixture = await harness(page, 'pdf')
  await open(page, 'pdf')
  await page.locator('.pdf-toolbar').getByRole('button', { name: '书签/高亮', exact: true }).click()
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  const panel = page.getByRole('complementary', { name: '书签、高亮和笔记' })
  await panel.getByRole('textbox', { name: '新笔记内容' }).fill('Original offline thought')
  await panel.getByRole('button', { name: '保存笔记', exact: true }).click()
  await expect(panel.locator('.reading-mark-body')).toContainText('Original offline thought')
  expect(fixture.mutations).toHaveLength(0)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect.poll(() => fixture.mutations.length).toBe(1)
  await expect(panel.getByText('批注已同步', { exact: true })).toBeVisible()
  expect(fixture.marks).toHaveLength(1)
})

test('PDF range loading opens a large original fixture and text view wraps per page', async ({ page }) => {
  const fixture = await harness(page, 'pdf', { large: true })
  await open(page, 'pdf')
  expect(fixture.ranges.length).toBeGreaterThan(0)
  await page.locator('.pdf-toolbar').getByRole('button', { name: '文字阅读', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'PDF 文字阅读' })
  await expect(panel.locator('.pdf-text-content')).toContainText('Original page 1')
  await panel.getByRole('button', { name: '下一页文字', exact: true }).click()
  await expect(panel.locator('.pdf-text-content')).toContainText('Original page 2')
})

test('PDF continuous selection spans two pages and saves one linked highlight', async ({ page }) => {
  const fixture = await harness(page, 'pdf', { continuous: true })
  await open(page, 'pdf')
  await expect(page.locator('[data-pdf-page="2"] .pdf-text-layer span').first()).toBeAttached()
  await page.evaluate(() => {
    const first = document.querySelector('[data-pdf-page="1"] .pdf-text-layer span')!.firstChild!
    const second = document.querySelector('[data-pdf-page="2"] .pdf-text-layer span')!.firstChild!
    const range = document.createRange(); range.setStart(first, 0); range.setEnd(second, second.textContent!.length)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  const composer = page.getByRole('dialog', { name: '创建文本高亮' })
  await expect(composer).toBeVisible()
  await expect(composer.getByRole('button', { name: '朗读选区', exact: true })).toBeVisible()
  await composer.getByRole('button', { name: '保存高亮', exact: true }).click()
  await expect.poll(() => fixture.marks.length).toBe(1)
  expect(fixture.marks[0].position.segments).toHaveLength(2)
  await expect(page.locator('[data-pdf-page="1"] .pdf-highlight')).toHaveCount(1)
  await expect(page.locator('[data-pdf-page="2"] .pdf-highlight')).toHaveCount(1)
})

test('speech sleep timer stops paused playback on an elapsed wall-clock deadline', async ({ page }) => {
  await speechStub(page)
  await harness(page, 'pdf')
  await open(page, 'pdf')
  await page.locator('.pdf-toolbar').getByRole('button', { name: '朗读', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '浏览器即时朗读' })
  await page.clock.install()
  await panel.getByRole('combobox', { name: '朗读睡眠定时' }).selectOption('5')
  await panel.getByRole('button', { name: '开始朗读', exact: true }).click()
  await panel.getByRole('button', { name: '暂停', exact: true }).click()
  await page.clock.fastForward(301_000)
  await expect(panel.getByRole('button', { name: '停止', exact: true })).toBeDisabled()
  await expect(panel.getByRole('combobox', { name: '朗读睡眠定时' })).toHaveValue('0')
})

test('EPUB speech begins at the visible paragraph and follows it without saved marks', async ({ page }) => {
  await speechStub(page)
  const fixture = await harness(page, 'epub')
  await open(page, 'epub')
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.epub-host iframe')!
    const container = document.querySelector<HTMLElement>('.epub-host .epub-container')!
    const paragraph = frame.contentDocument!.getElementById('paragraph-12')!
    container.scrollTop += frame.getBoundingClientRect().top + paragraph.getBoundingClientRect().top - container.getBoundingClientRect().top
    container.dispatchEvent(new Event('scroll'))
  })
  await page.keyboard.press('Tab')
  await page.locator('.epub-toolbar').getByRole('button', { name: '朗读', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '浏览器即时朗读' })
  await panel.getByRole('button', { name: '开始朗读', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window.speechSynthesis as SpeechSynthesis & { testText: string[] }).testText[0])).toContain('original paragraph 13')
  await expect(page.locator('.epub-host .peufm-speech-follow')).toBeAttached()
  expect(fixture.mutations).toHaveLength(0)
  await panel.getByRole('button', { name: '停止', exact: true }).click()
  await expect(page.locator('.epub-host .peufm-speech-follow')).toHaveCount(0)
})

test('clicking a saved PDF highlight opens that specific editor', async ({ page }) => {
  const mark: ReadingMark = { id: 951030, bookFileId: bookID, kind: 'highlight', position: { pageIndex: 0, rects: [{ x: 0.1, y: 0.2, width: 0.6, height: 0.05 }] }, overallProgress: 0.1, label: 'Original highlight', body: 'Original saved annotation', quote: 'Original words', color: 'blue', createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z' }
  await harness(page, 'pdf', { marks: [mark] })
  await open(page, 'pdf')
  const highlight = page.locator('.pdf-highlight').first()
  await expect(highlight).toBeAttached()
  await expect(page.locator('[data-pdf-page="1"].rendered')).toBeVisible()
  const rect = await highlight.boundingBox()
  if (!rect) throw new Error('Missing highlight geometry')
  const shell = page.locator('[data-pdf-page="1"]')
  const bounds = await shell.boundingBox()
  if (!bounds) throw new Error('Missing rendered page')
  await shell.click({ position: { x: bounds.width * .4, y: bounds.height * .225 } })
  await expect(page.getByRole('textbox', { name: '编辑批注内容', exact: true })).toHaveValue('Original saved annotation')
})

test('notebook JSON import previews book identity and retries without duplicate notes', async ({ page }) => {
  const fixture = await harness(page, 'pdf')
  const note = { bookFileId: bookID, bookTitle: 'Original knowledge fixture', bookFormat: 'pdf', kind: 'note', position: { pageIndex: 0 }, overallProgress: 0.1, label: 'Original imported note', body: 'Original imported thought' }
  await page.goto('/#/notebook')
  await page.getByText('导入 JSON 笔记', { exact: true }).click()
  const input = page.getByRole('button', { name: '确认导入到我的笔记', exact: true })
  const file = page.getByLabel('选择笔记 JSON 文件')
  const data = Buffer.from(JSON.stringify({ version: 1, items: [note] }))
  await file.setInputFiles({ name: 'original-notebook.json', mimeType: 'application/json', buffer: data })
  await expect(input).toBeVisible()
  await input.click()
  await expect.poll(() => fixture.marks.length).toBe(1)
  await expect(input).toHaveCount(0)
  await file.setInputFiles({ name: 'original-notebook.json', mimeType: 'application/json', buffer: data })
  await input.click()
  await expect(input).toHaveCount(0)
  expect(fixture.marks).toHaveLength(1)
  await file.setInputFiles({ name: 'wrong-book.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ items: [{ ...note, bookTitle: 'A different book' }] })) })
  await expect(page.getByRole('alert')).toContainText('与本机书名或格式不一致')
  await expect(input).toHaveCount(0)
})

test('PDF crop hides margins without changing saved highlight coordinates', async ({ page }) => {
  const mark: ReadingMark = { id: 951031, bookFileId: bookID, kind: 'highlight', position: { pageIndex: 0, rects: [{ x: .2, y: .3, width: .3, height: .05 }] }, overallProgress: .1, label: 'Original cropped highlight', body: 'Original crop annotation', quote: 'Original crop text', color: 'green', createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z' }
  const fixture = await harness(page, 'pdf', { marks: [mark] })
  await open(page, 'pdf')
  await expect(page.locator('[data-pdf-page="1"].rendered')).toBeVisible()
  await page.locator('.pdf-toolbar').getByRole('button', { name: '裁边', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'PDF 裁边', exact: true })
  await panel.getByRole('slider', { name: '裁切左边', exact: true }).focus()
  await page.keyboard.press('Home')
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight')
  await expect(panel.getByRole('slider', { name: '裁切左边', exact: true })).toHaveValue('10')
  await expect.poll(() => page.locator('.pdf-page-content').evaluate(element => Number.parseFloat((element as HTMLElement).style.left))).toBeLessThan(0)
  const ratio = await page.locator('[data-pdf-page="1"]').evaluate(element => element.getBoundingClientRect().width / element.querySelector('.pdf-page-content')!.getBoundingClientRect().width)
  expect(ratio).toBeCloseTo(.9, 2)
  expect(fixture.marks[0].position).toEqual(mark.position)
  await panel.getByRole('button', { name: '恢复完整页面', exact: true }).click()
  await expect.poll(() => page.locator('.pdf-page-content').evaluate(element => (element as HTMLElement).style.left)).toBe('0px')
})

test('unsaved annotation guards close and navigation without losing a cancelled draft', async ({ page }) => {
  await harness(page, 'pdf')
  await open(page, 'pdf')
  await page.locator('.pdf-toolbar').getByRole('button', { name: '书签/高亮', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '书签、高亮和笔记' })
  await panel.getByRole('textbox', { name: '新笔记内容' }).fill('Original unsaved draft')
  page.once('dialog', dialog => dialog.dismiss())
  await panel.getByRole('button', { name: '关闭侧栏', exact: true }).click()
  await expect(panel.getByRole('textbox', { name: '新笔记内容' })).toHaveValue('Original unsaved draft')
  await page.keyboard.press('Tab')
  page.once('dialog', dialog => dialog.dismiss())
  await page.getByRole('button', { name: '← 返回书库', exact: true }).click()
  await expect(panel).toBeVisible()
  page.once('dialog', dialog => dialog.accept())
  await panel.getByRole('button', { name: '关闭侧栏', exact: true }).click()
  await expect(panel).toHaveCount(0)
})

test('full-text search displays citations and opens an original page without creating a note', async ({ page }) => {
  const fixture = await harness(page, 'pdf')
  await page.route('**/api/v1/search/index', route => route.fulfill({ json: { eligibleBooks: 1, indexedBooks: 1, passageCount: 2 } }))
  await page.route('**/api/v1/search/text?**', route => route.fulfill({ json: { page: 1, hasMore: false, items: [{ bookFileId: bookID, bookTitle: 'Original knowledge fixture', bookFormat: 'pdf', label: '第 2 页', position: { pageIndex: 1 }, excerpt: 'Original excerpt from page two', coverage: 'PDF 已提取 2 页' }] } }))
  await page.goto('/#/search')
  await page.getByRole('textbox', { name: '正文关键词', exact: true }).fill('Original')
  await page.getByRole('button', { name: '检索正文', exact: true }).click()
  await expect(page.locator('.text-search-results')).toContainText('第 2 页')
  await page.getByRole('button', { name: '打开出处', exact: true }).click()
  await expect(page.locator('[data-pdf-page="2"].rendered')).toBeVisible()
  expect(fixture.mutations).toHaveLength(0)
})

test('smart shelf editor previews rules and never offers manual membership controls', async ({ page }) => {
  await harness(page, 'pdf')
  let shelf: unknown
  let finishSave!: () => void
  const saving = new Promise<void>(resolve => { finishSave = resolve })
  await page.route('**/api/v1/shelves*', async route => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON()
      await saving
      shelf = { ...input, id: 951050, kind: 'smart', bookCount: 0, containsBook: false, createdAt: '2026-10-05T00:00:00Z' }
      return route.fulfill({ status: 201, json: shelf })
    }
    return route.fulfill({ json: { items: shelf ? [shelf] : [] } })
  })
  await page.route('**/api/v1/shelves/951050/books?**', route => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 24, totalPages: 0 } }))
  await page.goto('/#/shelves')
  await page.getByRole('button', { name: '＋ 新建书架', exact: true }).click()
  await page.getByRole('textbox', { name: '书架名称', exact: true }).fill('Original smart shelf')
  await page.getByRole('combobox', { name: '书架类型', exact: true }).selectOption('smart')
  await expect(page.getByRole('button', { name: '保存书架', exact: true })).toBeDisabled()
  await page.getByRole('combobox', { name: '智能书架阅读状态', exact: true }).selectOption('unread')
  await page.getByRole('button', { name: '保存书架', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '书架类型', exact: true })).toBeDisabled()
  await expect(page.getByRole('combobox', { name: '智能书架阅读状态', exact: true })).toBeDisabled()
  await expect(page.getByRole('checkbox', { name: '只收录我收藏的书籍', exact: true })).toBeDisabled()
  finishSave()
  await expect(page.locator('.smart-shelf-summary')).toBeVisible()
  await expect(page.locator('.shelf-book-picker')).toHaveCount(0)
  await expect(page.locator('.shelf-order-actions')).toHaveCount(0)
})

test('replacing a shelf draft keeps the replacement protected after confirmation', async ({ page }) => {
  await harness(page, 'pdf')
  await page.goto('/#/shelves')
  const create = page.getByRole('button', { name: '＋ 新建书架', exact: true })
  const name = page.getByRole('textbox', { name: '书架名称', exact: true })
  await create.click()
  await name.fill('Original first draft')
  page.once('dialog', dialog => dialog.accept())
  await create.click()
  await name.fill('Original replacement draft')
  page.once('dialog', dialog => dialog.dismiss())
  await page.locator('.shelf-editor').getByRole('button', { name: '取消', exact: true }).click()
  await expect(name).toHaveValue('Original replacement draft')
  page.once('dialog', dialog => dialog.dismiss())
  await page.evaluate(() => { window.location.hash = '#/search' })
  await expect(page).toHaveURL(/#\/shelves$/)
  await expect(name).toHaveValue('Original replacement draft')
})

import { expect, test, type Download, type Page } from '@playwright/test'
import type { NotebookEntry } from '../src/types'

test.use({ serviceWorkers: 'block' })

const userID = 950000
const bookID = 950100

async function downloadText(download: Download) {
  const stream = await download.createReadStream()
  if (!stream) throw new Error('Synthetic download stream unavailable')
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function mockExports(page: Page, options: { hold?: boolean; fail?: number } = {}) {
  const marks: (NotebookEntry & { ownerID: number; accessible: boolean })[] = Array.from({ length: 26 }, (_, index) => ({
    id: 950200 + index, bookFileId: bookID, bookTitle: '合成导出书名', bookFormat: 'epub', kind: 'highlight', color: 'green',
    position: { cfi: `epubcfi(/6/2!/4/${index + 1}:0)` }, overallProgress: .5, label: `原创位置 ${index + 1}`,
    body: `已提交关键词 原创想法 ${index + 1}`, quote: `原创摘录 ${index + 1}`, createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z',
    ownerID: userID, accessible: true,
  }))
  marks.push({ ...marks[0], id: 950300, ownerID: 950001, body: 'OTHER_PRIVATE_ACCOUNT_NOTE' })
  marks.push({ ...marks[0], id: 950301, accessible: false, body: 'REVOKED_PRIVATE_NOTE' })
  const requests = { exports: [] as URLSearchParams[], unexpected: [] as string[] }
  let release = () => {}
  const gate = options.hold ? new Promise<void>((resolve) => { release = resolve }) : Promise.resolve()
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (route.request().method() !== 'GET') {
      requests.unexpected.push(`${route.request().method()} ${path}`)
      await route.fulfill({ status: 501, json: { error: { message: 'Synthetic fixture blocks all mutations.' } } })
      return
    }
    if (path === '/api/v1/auth/me') {
      await route.fulfill({ status: 200, json: { user: { id: userID, username: '合成导出测试', role: 'reader' }, csrfToken: 'synthetic-export-csrf' } })
      return
    }
    if (path === '/api/v1/notebook' || path === '/api/v1/notebook/export') {
      const filters = url.searchParams
      const items = marks.filter((mark) => mark.ownerID === userID && mark.accessible &&
        (!filters.get('bookId') || mark.bookFileId === Number(filters.get('bookId'))) &&
        (!filters.get('kind') || mark.kind === filters.get('kind')) &&
        (!filters.get('color') || mark.color === filters.get('color')) &&
        `${mark.bookTitle}${mark.body}${mark.quote}${mark.label}`.includes(filters.get('q') ?? ''),
      ).map(({ ownerID: _ownerID, accessible: _accessible, ...mark }) => mark)
      if (path === '/api/v1/notebook') {
        const pageNumber = Number(filters.get('page') ?? 1)
        await route.fulfill({ status: 200, json: { items: items.slice((pageNumber - 1) * 24, pageNumber * 24), total: items.length, page: pageNumber, pageSize: 24, totalPages: Math.ceil(items.length / 24) } })
        return
      }
      requests.exports.push(new URLSearchParams(filters))
      await gate
      if (options.fail === -1) {
        await route.abort('failed')
        return
      }
      if (options.fail) {
        await route.fulfill({ status: options.fail, json: { error: { code: options.fail === 413 ? 'notebook_export_too_large' : 'unavailable', message: options.fail === 413 ? '导出最多支持 5000 条记录或 16 MiB，请缩小筛选后重试。' : '测试：导出暂不可用' } } })
        return
      }
      const format = filters.get('format')
      const payload = { version: 1, generatedAt: '2026-10-04T00:00:00Z', filters: { q: filters.get('q') ?? '', kind: filters.get('kind') ?? '', color: filters.get('color') ?? '', ...(filters.get('bookId') ? { bookId: Number(filters.get('bookId')) } : {}) }, items }
      const body = format === 'json' ? JSON.stringify(payload) : '# PEUFMReader 阅读笔记\n\n'+items.map((item) => `## ${item.bookTitle}\n\n${item.label}\n\n${item.quote}\n\n${item.body}\n`).join('\n')
      await route.fulfill({ status: 200, headers: { 'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="notebook.${format === 'json' ? 'json' : 'md'}"`, 'Cache-Control': 'private, no-store' }, body })
      return
    }
    requests.unexpected.push(`GET ${path}`)
    await route.fulfill({ status: 501, json: { error: { message: 'Synthetic fixture blocks undeclared API requests.' } } })
  })
  return { requests, release: () => release() }
}

test('filtered cross-book JSON includes every page and preserves unsaved edits during download', async ({ page }) => {
  const fixture = await mockExports(page, { hold: true })
  let download: Download | undefined
  try {
    await page.goto(`/#/notebook?bookId=${bookID}`)
    await expect(page.locator('.notebook-card')).toHaveCount(24)
    await expect(page.getByRole('link', { name: '导出本书 Markdown', exact: true })).toBeVisible()
    await page.getByRole('textbox', { name: '搜索笔记', exact: true }).fill('已提交关键词')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await page.getByRole('combobox', { name: '记录类型', exact: true }).selectOption('highlight')
    await page.getByRole('combobox', { name: '高亮颜色', exact: true }).selectOption('green')
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(page.locator('.notebook-card')).toHaveCount(2)
    await page.getByRole('textbox', { name: '搜索笔记', exact: true }).fill('尚未提交的关键词')
    await page.getByRole('button', { name: '编辑批注', exact: true }).first().click()
    await page.getByRole('textbox', { name: '编辑笔记内容', exact: true }).fill('导出不能清掉尚未保存的原创草稿')
    const downloading = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出 JSON', exact: true }).click()
    await expect.poll(() => fixture.requests.exports.length).toBe(1)
    for (const name of ['导出 JSON', '导出 Markdown', '搜索', '保存笔记', '清空筛选', '上一页']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeDisabled()
    }
    await expect(page.getByRole('textbox', { name: '编辑笔记内容', exact: true })).toBeDisabled()
    fixture.release()
    download = await downloading
  } finally {
    fixture.release()
  }
  if (!download) throw new Error('Synthetic JSON download did not start')
  expect(download.suggestedFilename()).toBe('notebook.json')
  const payload = JSON.parse(await downloadText(download)) as { version: number; generatedAt: string; items: NotebookEntry[]; filters: Record<string, unknown> }
  expect(payload.version).toBe(1)
  expect(payload.generatedAt).toBeTruthy()
  expect(payload.items).toHaveLength(26)
  expect(payload.filters).toEqual({ q: '已提交关键词', kind: 'highlight', color: 'green', bookId: bookID })
  expect(payload.items.every((item) => item.body.includes('已提交关键词') && item.kind === 'highlight' && item.color === 'green')).toBe(true)
  expect(JSON.stringify(payload)).not.toMatch(/OTHER_PRIVATE_ACCOUNT_NOTE|REVOKED_PRIVATE_NOTE/)
  expect(fixture.requests.exports[0].has('page')).toBe(false)
  expect(fixture.requests.exports[0].has('pageSize')).toBe(false)
  await expect(page.getByRole('textbox', { name: '搜索笔记', exact: true })).toHaveValue('尚未提交的关键词')
  await expect(page.getByRole('textbox', { name: '编辑笔记内容', exact: true })).toHaveValue('导出不能清掉尚未保存的原创草稿')
  await expect(page.getByRole('textbox', { name: '编辑笔记内容', exact: true })).toBeEnabled()
  await expect(page.locator('.workspace-feedback')).toContainText('笔记导出已开始下载')
  const stored = await page.evaluate(async () => {
    const local = Object.values(localStorage).join(' ')
    const cacheURLs: string[] = []
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) cacheURLs.push(request.url)
    return { local, cacheURLs }
  })
  expect(stored.local).not.toContain('原创草稿')
  expect(stored.cacheURLs.some((url) => url.includes('/notebook/export'))).toBe(false)
  expect(fixture.requests.unexpected).toEqual([])
})

test('Markdown export uses a fixed safe filename and contains all matching records', async ({ page }) => {
  const { requests } = await mockExports(page)
  await page.goto('/#/notebook')
  await expect(page.locator('.notebook-card')).toHaveCount(24)
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 Markdown', exact: true }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe('notebook.md')
  const text = await downloadText(download)
  expect(text.match(/## 合成导出书名/g)).toHaveLength(26)
  expect(text).not.toMatch(/OTHER_PRIVATE_ACCOUNT_NOTE|REVOKED_PRIVATE_NOTE/)
  expect(requests.exports[0].get('bookId')).toBeNull()
  expect(requests.unexpected).toEqual([])
})

for (const status of [413, 503, -1]) {
  test(`a ${status} export failure leaves the filter and draft intact without a loading retry`, async ({ page }) => {
    const { requests } = await mockExports(page, { fail: status })
    await page.goto('/#/notebook')
    await page.getByRole('combobox', { name: '高亮颜色', exact: true }).selectOption('green')
    await expect(page.locator('.notebook-card')).toHaveCount(24)
    await page.getByRole('button', { name: '编辑批注', exact: true }).first().click()
    await page.getByRole('textbox', { name: '编辑笔记内容', exact: true }).fill('失败后仍然保留的合成草稿')
    let downloadCount = 0
    page.on('download', () => { downloadCount++ })
    await page.getByRole('button', { name: '导出 JSON', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText(status === 413 ? '请缩小筛选' : status === -1 ? '无法连接服务器' : '测试：导出暂不可用')
    await expect(page.getByRole('textbox', { name: '编辑笔记内容', exact: true })).toHaveValue('失败后仍然保留的合成草稿')
    await expect(page.getByRole('combobox', { name: '高亮颜色', exact: true })).toHaveValue('green')
    await expect(page.getByRole('button', { name: '导出 JSON', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: '重试加载', exact: true })).toHaveCount(0)
    expect(downloadCount).toBe(0)
    expect(requests.exports).toHaveLength(1)
    expect(requests.unexpected).toEqual([])
  })
}

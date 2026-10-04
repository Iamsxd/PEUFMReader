import { expect, test, type Page } from '@playwright/test'
import type { NotebookEntry } from '../src/types'

test.use({ serviceWorkers: 'block' })

// These original records and intercepted requests never access a real account or book.
const originalMarks: NotebookEntry[] = [
  {
    id: 940010,
    bookFileId: 940100,
    bookTitle: '合成阅读札记',
    bookFormat: 'pdf',
    kind: 'note',
    position: { pageIndex: 0 },
    overallProgress: 0.2,
    label: '第 1 页',
    body: '最初的阅读想法',
    quote: '',
    color: '',
    createdAt: '2026-10-04T00:00:00Z',
    updatedAt: '2026-10-04T00:00:00Z',
  },
  {
    id: 940011,
    bookFileId: 940101,
    bookTitle: '合成蓝色篇章',
    bookFormat: 'epub',
    kind: 'highlight',
    position: { href: 'original.xhtml', chapterIndex: 0 },
    overallProgress: 0.5,
    label: '原创章节',
    body: '蓝色的思考',
    quote: '只用于自动化验证的原创摘录。',
    color: 'blue',
    createdAt: '2026-10-04T00:00:00Z',
    updatedAt: '2026-10-04T00:00:00Z',
  },
  {
    id: 940012,
    bookFileId: 940102,
    bookTitle: '合成书签页',
    bookFormat: 'pdf',
    kind: 'bookmark',
    position: { pageIndex: 1 },
    overallProgress: 0.7,
    label: '第 2 页',
    body: '',
    quote: '',
    color: '',
    createdAt: '2026-10-04T00:00:00Z',
    updatedAt: '2026-10-04T00:00:00Z',
  },
]

async function mockNotebook(
  page: Page,
  options: { empty?: boolean; pageSize?: number; holdPatch?: boolean; patchFailures?: number } = {},
) {
  let marks = options.empty ? [] : originalMarks.map((mark) => ({ ...mark }))
  let remainingFailures = options.patchFailures ?? 0
  let releasePatch = () => {}
  const patchGate = options.holdPatch ? new Promise<void>((resolve) => { releasePatch = resolve }) : Promise.resolve()
  const requests = { notebook: [] as string[], writes: [] as string[], unexpected: [] as string[] }

  // All API calls are intercepted, including unexpected ones: never fall through to a running server.
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const method = route.request().method()
    if (method !== 'GET') requests.writes.push(`${method} ${path}`)
    if (method === 'GET' && path === '/api/v1/auth/me') {
      await route.fulfill({
        status: 200,
        json: { user: { id: 940000, username: '合成笔记测试', role: 'reader' }, csrfToken: 'synthetic-notebook-csrf' },
      })
      return
    }
    if (method === 'GET' && path === '/api/v1/notebook') {
      requests.notebook.push(url.searchParams.toString())
      const q = url.searchParams.get('q') ?? ''
      const kind = url.searchParams.get('kind')
      const color = url.searchParams.get('color')
      const bookID = url.searchParams.get('bookId')
      const pageNumber = Number(url.searchParams.get('page') ?? 1)
      const pageSize = options.pageSize ?? 24
      const filtered = marks.filter((mark) =>
        (!bookID || mark.bookFileId === Number(bookID)) &&
        (!kind || mark.kind === kind) &&
        (!color || mark.color === color) &&
        `${mark.bookTitle}${mark.label}${mark.body}${mark.quote}`.includes(q),
      )
      await route.fulfill({
        status: 200,
        json: {
          items: filtered.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
          total: filtered.length,
          page: pageNumber,
          pageSize,
          totalPages: Math.ceil(filtered.length / pageSize),
        },
      })
      return
    }
    if (/^\/api\/v1\/reading-marks\/\d+$/.test(path) && (method === 'PATCH' || method === 'DELETE')) {
      const id = Number(path.split('/').pop())
      if (method === 'PATCH') {
        await patchGate
        if (remainingFailures > 0) {
          remainingFailures--
          await route.fulfill({ status: 503, json: { error: { code: 'synthetic_failure', message: '测试：保存暂不可用' } } })
          return
        }
        const input = route.request().postDataJSON() as Pick<NotebookEntry, 'body' | 'label' | 'color'>
        marks = marks.map((mark) => mark.id === id ? { ...mark, ...input } : mark)
        await route.fulfill({ status: 200, json: marks.find((mark) => mark.id === id) })
        return
      }
      marks = marks.filter((mark) => mark.id !== id)
      await route.fulfill({ status: 204 })
      return
    }
    requests.unexpected.push(`${method} ${path}`)
    await route.fulfill({ status: 501, json: { error: { code: 'blocked_by_fixture', message: '测试夹具阻止未声明的 API 请求。' } } })
  })
  return { requests, releasePatch: () => releasePatch() }
}

function noteCard(page: Page) {
  return page.locator('.notebook-card').filter({ has: page.getByRole('heading', { name: '合成阅读札记', exact: true }) })
}

async function editNote(page: Page, body: string) {
  await noteCard(page).getByRole('button', { name: '编辑批注', exact: true }).click()
  await page.getByRole('textbox', { name: '编辑笔记内容', exact: true }).fill(body)
}

test('a slow notebook save locks conflicting controls and rejects repeated submissions', async ({ page }) => {
  const fixture = await mockNotebook(page, { pageSize: 2, holdPatch: true })
  try {
    await page.goto('/#/notebook')
    await expect(page.locator('.notebook-card')).toHaveCount(2)
    await page.getByRole('textbox', { name: '搜索笔记', exact: true }).fill('合成')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await expect(page.getByRole('button', { name: '清空筛选', exact: true })).toBeVisible()
    await editNote(page, '慢请求中也不能丢掉的新想法')
    await page.getByRole('button', { name: '保存笔记', exact: true }).click()
    await expect.poll(() => fixture.requests.writes.length).toBe(1)

    await expect(page.getByRole('textbox', { name: '编辑笔记内容', exact: true })).toBeDisabled()
    await expect(page.getByRole('textbox', { name: '搜索笔记', exact: true })).toBeDisabled()
    for (const name of ['搜索', '清空筛选', '保存笔记', '取消', '下一页']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeDisabled()
    }
    for (const name of ['记录类型', '高亮颜色']) {
      await expect(page.getByRole('combobox', { name, exact: true })).toBeDisabled()
    }
    for (const button of await page.getByRole('button', { name: /^(编辑批注|删除|回到原文)$/ }).all()) {
      await expect(button).toBeDisabled()
    }
    await expect(page.locator('.notebook-grid')).toHaveAttribute('aria-busy', 'true')
    // Exercise the synchronous guard as well as disabled buttons.
    await noteCard(page).locator('form').evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(fixture.requests.writes).toEqual(['PATCH /api/v1/reading-marks/940010'])
  } finally {
    fixture.releasePatch()
  }
  await expect(page.locator('.workspace-feedback')).toContainText('笔记已保存。')
  await expect(noteCard(page).locator('.notebook-body')).toHaveText('慢请求中也不能丢掉的新想法')
  await expect(page.getByRole('button', { name: '搜索', exact: true })).toBeEnabled()
  expect(fixture.requests.unexpected).toEqual([])
})

test('a failed notebook save keeps the draft and offers no misleading loading retry', async ({ page }) => {
  const { requests } = await mockNotebook(page, { patchFailures: 1 })
  await page.goto('/#/notebook')
  await editNote(page, '保存失败也要保留这段原创文字')
  await page.getByRole('button', { name: '保存笔记', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('测试：保存暂不可用')
  await expect(page.getByRole('textbox', { name: '编辑笔记内容', exact: true })).toHaveValue('保存失败也要保留这段原创文字')
  await expect(page.getByRole('textbox', { name: '编辑笔记内容', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '重试加载', exact: true })).toHaveCount(0)
  expect(requests.notebook).toHaveLength(1)
  expect(requests.writes).toHaveLength(1)

  await page.getByRole('button', { name: '保存笔记', exact: true }).click()
  await expect(page.locator('.workspace-feedback')).toContainText('笔记已保存。')
  await expect(noteCard(page).locator('.notebook-body')).toHaveText('保存失败也要保留这段原创文字')
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(requests.writes).toHaveLength(2)
  expect(requests.unexpected).toEqual([])
})

test('successful notebook save and delete are announced without removing other records', async ({ page }) => {
  const { requests } = await mockNotebook(page)
  await page.goto('/#/notebook')
  await editNote(page, '一个明确保存的新想法')
  await page.getByRole('button', { name: '保存笔记', exact: true }).click()
  const feedback = page.locator('.workspace-feedback')
  await expect(feedback).toHaveAttribute('role', 'status')
  await expect(feedback).toHaveAttribute('aria-live', 'polite')
  await expect(feedback).toHaveAttribute('aria-atomic', 'true')
  await expect(feedback).toContainText('笔记已保存。')
  await expect(noteCard(page).locator('.notebook-body')).toHaveText('一个明确保存的新想法')
  page.once('dialog', (dialog) => dialog.accept())
  await noteCard(page).getByRole('button', { name: '删除', exact: true }).click()
  await expect(feedback).toContainText('笔记已删除。')
  await expect(page.locator('.notebook-card')).toHaveCount(2)
  await expect(page.getByRole('heading', { name: '合成蓝色篇章', exact: true })).toBeVisible()
  expect(requests.writes).toEqual(['PATCH /api/v1/reading-marks/940010', 'DELETE /api/v1/reading-marks/940010'])
  expect(requests.unexpected).toEqual([])
})

test('rejecting an unsaved-edit confirmation preserves both the filter and draft', async ({ page }) => {
  const { requests } = await mockNotebook(page)
  await page.goto('/#/notebook')
  await editNote(page, '还没有保存的原创想法')
  const dialogs: string[] = []
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message())
    await dialog.dismiss()
  })
  await page.getByRole('combobox', { name: '记录类型', exact: true }).selectOption('highlight')
  await expect(page.getByRole('combobox', { name: '记录类型', exact: true })).toHaveValue('')
  await expect(page.getByRole('textbox', { name: '编辑笔记内容', exact: true })).toHaveValue('还没有保存的原创想法')
  // Pressing edit again on this same record must not silently reset its draft or prompt again.
  await noteCard(page).getByRole('button', { name: '编辑批注', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '编辑笔记内容', exact: true })).toHaveValue('还没有保存的原创想法')
  expect(dialogs).toEqual(['批注有未保存的修改，确定放弃吗？'])
  expect(requests.notebook).toHaveLength(1)
  expect(requests.writes).toEqual([])
  expect(requests.unexpected).toEqual([])
})

test('a first-time empty notebook gives reading guidance rather than a filter dead end', async ({ page }) => {
  const { requests } = await mockNotebook(page, { empty: true })
  await page.goto('/#/notebook')
  await expect(page.getByRole('heading', { name: '还没有阅读记录', exact: true })).toBeVisible()
  await expect(page.locator('.empty-state')).toContainText('阅读时添加高亮、笔记或书签')
  await expect(page.getByRole('button', { name: '清空筛选', exact: true })).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(requests.writes).toEqual([])
  expect(requests.unexpected).toEqual([])
})

test('clearing an empty search resets keyword, kind and color in both themes at 320px', async ({ page }) => {
  const { requests } = await mockNotebook(page)
  await page.setViewportSize({ width: 320, height: 760 })
  await page.goto('/#/notebook')
  for (const theme of ['edition', 'night']) {
    await page.getByRole('combobox', { name: '界面主题', exact: true }).selectOption(theme)
    await expect(page.locator('.notebook-card')).toHaveCount(3)
    await page.getByRole('textbox', { name: '搜索笔记', exact: true }).fill('没有这个原创摘录')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await expect(page.getByRole('heading', { name: '还没有符合条件的记录', exact: true })).toBeVisible()
    await page.getByRole('combobox', { name: '记录类型', exact: true }).selectOption('note')
    await page.getByRole('combobox', { name: '高亮颜色', exact: true }).selectOption('blue')
    await expect(page.getByRole('heading', { name: '还没有符合条件的记录', exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    await page.getByRole('button', { name: '清空筛选', exact: true }).click()
    await expect(page.locator('.notebook-card')).toHaveCount(3)
    await expect(page.getByRole('textbox', { name: '搜索笔记', exact: true })).toHaveValue('')
    await expect(page.getByRole('combobox', { name: '记录类型', exact: true })).toHaveValue('')
    await expect(page.getByRole('combobox', { name: '高亮颜色', exact: true })).toHaveValue('')
    await expect(page.getByRole('button', { name: '清空筛选', exact: true })).toHaveCount(0)
    const lastQuery = new URLSearchParams(requests.notebook.at(-1))
    for (const name of ['q', 'kind', 'color']) expect(lastQuery.has(name)).toBe(false)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  }
  expect(requests.writes).toEqual([])
  expect(requests.unexpected).toEqual([])
})

import { expect, test } from '@playwright/test'
import { minimalPDF } from './support/pdf'

// Opt in only for the disposable localhost instance created for this task.
// Never run this writing test against an existing NAS library.
test.use({ serviceWorkers: 'block' })
test('scratch instance persists shelves and notes through real browser/API round trips', async ({
  page,
  baseURL,
}, info) => {
  test.skip(process.env.E2E_WORKSPACE_SCRATCH !== '1', 'Requires a disposable workspace instance, not production.')
  expect(baseURL).toBe('http://127.0.0.1:5189')
  const auth = await page.request.post('/api/v1/auth/login', {
    data: { username: process.env.E2E_ADMIN_USERNAME, password: process.env.E2E_ADMIN_PASSWORD },
  })
  expect(auth.ok()).toBe(true)
  const { csrfToken } = await auth.json()
  const headers = { 'X-CSRF-Token': csrfToken }
  const key = `${info.project.name}-${Date.now()}`
  const uploaded = await page.request.post('/api/v1/book-files', {
    headers,
    multipart: {
      file: {
        name: `${key}.pdf`,
        mimeType: 'application/pdf',
        buffer: minimalPDF([`Original scratch page one ${key}`, `Original scratch page two ${key}`]),
      },
    },
  })
  expect(uploaded.ok()).toBe(true)
  const { bookFile: book } = await uploaded.json()
  const savedMark = await page.request.post(`/api/v1/book-files/${book.id}/marks`, {
    headers,
    data: {
      kind: 'highlight',
      position: { pageIndex: 1, yRatio: 0 },
      overallProgress: 0.5,
      label: '第 2 页',
      quote: `Original scratch quotation ${key}`,
      color: 'green',
      body: '初始测试批注',
    },
  })
  expect(savedMark.status()).toBe(201)
  await page.goto(`/#/book/${book.id}`)
  await page.locator('.shelf-membership summary').click()
  await page.getByRole('textbox', { name: '新书架名称' }).fill(key)
  await page.getByRole('button', { name: '创建并加入' }).click()
  await expect(page.getByRole('checkbox', { name: new RegExp(key) })).toBeChecked()
  const shelfResponse = await page.request.get(`/api/v1/shelves?bookId=${book.id}`)
  const shelf = (await shelfResponse.json()).items.find((item: { name: string }) => item.name === key)
  expect(shelf.containsBook).toBe(true)
  await page.getByRole('button', { name: '查看本书笔记' }).click()
  await expect(page.locator('.notebook-card')).toHaveCount(1)
  await expect(page.locator('.notebook-card blockquote')).toHaveText(`Original scratch quotation ${key}`)
  await page.getByRole('button', { name: '编辑批注' }).click()
  await page.getByRole('textbox', { name: '编辑笔记内容' }).fill('真实接口往返保存成功')
  await page.getByRole('button', { name: '保存笔记' }).click()
  await expect(page.locator('.notebook-body')).toHaveText('真实接口往返保存成功')
  await page.reload()
  await expect(page.locator('.notebook-body')).toHaveText('真实接口往返保存成功')
  await page.getByRole('button', { name: '回到原文' }).click()
  await expect(page.locator('.pdf-page-shell.rendered').first()).toBeVisible()
  if ((await page.locator('.pdf-toolbar').getAttribute('aria-hidden')) === 'true') {
    if (info.project.name === 'mobile-chromium') await page.locator('.pdf-reader-viewport').tap()
    else await page.getByRole('button', { name: '显示 PDF 阅读工具', exact: true }).click()
  }
  await expect(page.getByRole('spinbutton', { name: '当前页码' })).toHaveValue('2')
  await page.goto(`/#/shelves?shelf=${shelf.id}`)
  await page.reload()
  await expect(page.locator('.shelf-book')).toHaveCount(1)
  const secondUpload = await page.request.post('/api/v1/book-files', {
    headers,
    multipart: {
      file: {
        name: `${key}-batch.pdf`,
        mimeType: 'application/pdf',
        buffer: minimalPDF([`Original scratch batch candidate ${key}`]),
      },
    },
  })
  expect(secondUpload.ok()).toBe(true)
  const { bookFile: secondBook } = await secondUpload.json()
  await page.locator('.shelf-add-books > summary').click()
  await page.getByRole('textbox', { name: '搜索要添加的书籍' }).fill(secondBook.title)
  await page.getByRole('button', { name: '查找书籍', exact: true }).click()
  await page.getByRole('checkbox', { name: `勾选《${secondBook.title}》`, exact: true }).check()
  await page.getByRole('button', { name: '添加已选（1）', exact: true }).click()
  await expect(page.locator('.shelf-book')).toHaveCount(2)
  await expect(page.locator('.workspace-feedback')).toContainText('已添加 1 本书')
  await page.reload()
  await expect(page.locator('.shelf-book')).toHaveCount(2)
  const membership = await page.request.get(`/api/v1/shelves/${shelf.id}/memberships?ids=${book.id},${secondBook.id}`)
  expect(await membership.json()).toEqual({ bookIds: [book.id, secondBook.id] })
  const repeated = await page.request.post(`/api/v1/shelves/${shelf.id}/books`, { headers, data: { bookIds: [book.id, secondBook.id] } })
  expect(repeated.status()).toBe(200)
  expect(await repeated.json()).toEqual({ addedBookIds: [], alreadyPresentBookIds: [book.id, secondBook.id] })
  const removed = await page.request.delete(`/api/v1/shelves/${shelf.id}`, { headers })
  expect(removed.status()).toBe(204)
  expect((await page.request.get(`/api/v1/book-files/${book.id}`)).ok()).toBe(true)
  const marks = await page.request.get(`/api/v1/book-files/${book.id}/marks`)
  expect((await marks.json()).items).toHaveLength(1)
})

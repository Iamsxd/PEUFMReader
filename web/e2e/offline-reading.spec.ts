import { expect, test } from '@playwright/test'
import { login } from './support/auth'
import { minimalPDF } from './support/pdf'

test('a saved PDF remains readable after the mobile browser goes offline', async ({ page, context }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile-'), 'mobile offline regression')
  await login(page)

  const book = await page.evaluate(async () => {
    const response = await fetch('/api/v1/book-files?format=pdf&pageSize=1&sort=title')
    const body = await response.json() as { items: Array<{ id: number; title: string }> }
    return body.items[0]
  })
  test.skip(!book, 'The current library has no PDF available for the offline regression.')

  await page.route(`**/api/v1/book-files/${book.id}/content`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/pdf',
    body: minimalPDF(),
  }))
  await page.goto(`/#/book/${book.id}`)
  await expect(page.locator('.book-detail-page h1')).toHaveText(book.title)
  await page.getByRole('button', { name: '↓ 保存到此设备' }).click()
  await expect(page.getByText(/已保存到当前设备/)).toBeVisible()
  await page.evaluate(() => navigator.serviceWorker.ready)

  const more = page.locator('details.navigation-menu')
  await more.locator('summary').click()
  await more.getByRole('button', { name: /离线书籍/ }).click()
  await expect(page.getByRole('heading', { name: '离线书籍', exact: true })).toBeVisible()
  await expect(page.locator('.offline-book-record')).toContainText(book.title)

  await context.setOffline(true)
  try {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: '离线书籍', exact: true })).toBeVisible()
    await page.locator('.offline-book-record .book-open').click()
    await expect(page.getByRole('toolbar', { name: 'PDF 阅读工具' })).toBeVisible()
    await expect(page.locator('.pdf-page-shell.rendered').first()).toBeVisible()
  } finally {
    await context.setOffline(false)
  }
})

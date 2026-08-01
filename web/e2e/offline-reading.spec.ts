import { expect, test } from '@playwright/test'
import { login } from './support/auth'

function minimalPDF(): Buffer {
  const stream = 'BT /F1 18 Tf 72 72 Td (Offline test) Tj ET'
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
  ]
  let content = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(content, 'ascii'))
    content += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(content, 'ascii')
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  content += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  content += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(content, 'ascii')
}

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
  await expect(page.getByRole('heading', { name: '离线书籍' })).toBeVisible()
  await expect(page.locator('.offline-book-record')).toContainText(book.title)

  await context.setOffline(true)
  try {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: '离线书籍' })).toBeVisible()
    await page.locator('.offline-book-record .book-open').click()
    await expect(page.getByRole('toolbar', { name: 'PDF 阅读工具' })).toBeVisible()
    await expect(page.locator('.pdf-page-shell.rendered').first()).toBeVisible()
  } finally {
    await context.setOffline(false)
  }
})

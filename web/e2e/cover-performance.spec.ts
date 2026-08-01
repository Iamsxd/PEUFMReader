import { expect, test } from '@playwright/test'
import type { CatalogPage } from '../src/types'
import { login } from './support/auth'

test.describe('responsive cover delivery', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('serves a bounded WebP thumbnail and rejects unsupported widths', async ({ page }) => {
    const catalogResponse = await page.request.get('/api/v1/book-files?page=1&pageSize=100&sort=newest')
    expect(catalogResponse.ok()).toBeTruthy()
    const catalog = await catalogResponse.json() as CatalogPage
    const book = catalog.items.find((item) => item.coverUrl)
    test.skip(!book?.coverUrl, 'The current library does not contain a book with a cover.')

    const thumbnailURL = withWidth(book!.coverUrl!, 320)
    const thumbnail = await page.request.get(thumbnailURL)
    expect(thumbnail.status()).toBe(200)
    expect(thumbnail.headers()['content-type']).toContain('image/webp')
    const bytes = await thumbnail.body()
    expect(bytes.byteLength).toBeGreaterThan(20)
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP')

    const dimensions = await page.evaluate(async (url) => {
      const response = await fetch(url)
      const bitmap = await createImageBitmap(await response.blob())
      const result = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
      return result
    }, thumbnailURL)
    expect(dimensions.width).toBeLessThanOrEqual(320)
    expect(dimensions.height).toBeGreaterThan(0)

    const invalid = await page.request.get(withWidth(book!.coverUrl!, 321))
    expect(invalid.status()).toBe(400)
  })
})

function withWidth(coverURL: string, width: number) {
  const separator = coverURL.includes('?') ? '&' : '?'
  return `${coverURL}${separator}width=${width}`
}

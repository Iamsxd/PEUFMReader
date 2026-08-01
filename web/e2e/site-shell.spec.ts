import { expect, test } from '@playwright/test'

test('publishes the site icon and mobile application metadata', async ({ page, request }) => {
  await page.goto('/')

  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/favicon.svg')
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/site.webmanifest')
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/)

  const icon = await request.get('/favicon.svg')
  expect(icon.ok()).toBeTruthy()
  expect(icon.headers()['content-type']).toContain('image/svg+xml')

  const manifest = await request.get('/site.webmanifest')
  expect(manifest.ok()).toBeTruthy()
  expect((await manifest.json()).short_name).toBe('PEUFMReader')
})

test('site shell does not overflow the mobile viewport', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile-'), 'mobile viewport assertion')
  await page.goto('/')

  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
})

import { expect, test } from '@playwright/test'

test('publishes the site icon and mobile application metadata', async ({ page, request }) => {
  await page.goto('/')

  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/favicon.svg')
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/icons/apple-touch-icon.png')
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/site.webmanifest')
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/)

  const icon = await request.get('/favicon.svg')
  expect(icon.ok()).toBeTruthy()
  expect(icon.headers()['content-type']).toContain('image/svg+xml')

  const manifest = await request.get('/site.webmanifest')
  expect(manifest.ok()).toBeTruthy()
  const manifestBody = await manifest.json() as { short_name: string; icons: Array<{ src: string; sizes: string }> }
  expect(manifestBody.short_name).toBe('PEUFMReader')
  expect(manifestBody.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ src: '/icons/icon-192.png', sizes: '192x192' }),
    expect.objectContaining({ src: '/icons/icon-512.png', sizes: '512x512' }),
    expect.objectContaining({ src: '/icons/icon-maskable-512.png', sizes: '512x512' }),
  ]))

  for (const path of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png']) {
    const png = await request.get(path)
    expect(png.ok()).toBeTruthy()
    expect(png.headers()['content-type']).toContain('image/png')
  }

  const serviceWorker = await request.get('/sw.js')
  expect(serviceWorker.ok()).toBeTruthy()
  expect(await serviceWorker.text()).not.toContain('__BUILD_REVISION__')

  const offlineAssets = await request.get('/offline-assets.json')
  expect(offlineAssets.ok()).toBeTruthy()
  const offlineManifest = await offlineAssets.json() as { files: string[] }
  expect(offlineManifest.files.some((path) => path.includes('/PDFReader-'))).toBeTruthy()
  expect(offlineManifest.files.some((path) => path.includes('/EPUBReader-'))).toBeTruthy()
})

test('site shell does not overflow the mobile viewport', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile-'), 'mobile viewport assertion')
  await page.goto('/')

  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
})

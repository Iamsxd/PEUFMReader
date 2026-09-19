import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'

// Run against Vite (E2E_BASE_URL=http://127.0.0.1:5178); all APIs are mocked,
// while the actual import UI, worker hashing and network upload decision run.
test('upload UI skips renamed content before transfer and retains distinct content', async ({ page }) => {
  test.skip(!process.env.E2E_UPLOAD_HARNESS, 'requires the Vite upload harness')
  const content = Buffer.alloc(5 * 1024 * 1024 + 11, 65)
  const hash = createHash('sha256').update(content).digest('hex')
  const book = { id: 1, title: 'Existing book' }
  const batch = { id: 1, totalItems: 2, source: 'browser-upload', createdAt: new Date().toISOString(), importedCount: 1, duplicateCount: 1, failedCount: 0, pendingCount: 0, completedAt: new Date().toISOString() }
  let uploaded = 0
  let confirmations = 0
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let response: unknown = { items: [], page: 1, totalPages: 1 }
    if (path.endsWith('/preflight')) response = { matchingSizes: [content.length] }
    else if (path.endsWith('/skip-duplicate')) {
      const body = request.postDataJSON()
      expect(request.postDataBuffer()!.length).toBeLessThan(1024)
      expect(body.size).toBe(content.length)
      confirmations++
      response = body.sha256 === hash ? { duplicate: true, bookFile: book, importJobId: 1 } : { duplicate: false }
    } else if (path === '/api/v1/book-files' && request.method() === 'POST') {
      uploaded++
      response = { duplicate: false, bookFile: book, importJobId: 2 }
    } else if (path === '/api/v1/import-batches' && request.method() === 'POST') response = batch
    else if (path === '/api/v1/import-batches/1') response = { batch, jobs: [] }
    await route.fulfill({ json: response })
  })
  await page.goto('/e2e/support/upload-harness.html')
  await expect(page.getByRole('heading', { name: '导入电子书' })).toBeVisible()
  await page.locator('input[type=file]').setInputFiles([
    { name: 'renamed.pdf', mimeType: 'application/pdf', buffer: content },
    { name: 'renamed.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(content.length, 66) },
  ])
  await expect(page.locator('#notice')).toContainText('新增 1 本，重复 1 本，失败 0 本')
  await expect(page.locator('.upload-queue')).toContainText('书库已存在，未上传')
  expect(confirmations).toBe(2)
  expect(uploaded).toBe(1)
  await expect(page.locator('#error')).toBeEmpty()
})

test('local hashing keeps the main thread responsive without Web Crypto', async ({ page }, testInfo) => {
  test.skip(!process.env.E2E_UPLOAD_HARNESS, 'requires the Vite upload harness')
  await page.addInitScript(() => Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined }))
  await page.route((url) => url.pathname.startsWith('/api/'), (route) => route.fulfill({ json: { items: [], page: 1, totalPages: 1 } }))
  await page.goto('/e2e/support/upload-harness.html')
  const measurement = await page.evaluate(async () => {
    const moduleURL = '/src/uploadPreflight.ts'
    const { hashUpload } = await import(moduleURL)
    const file = new File([new Uint8Array(32 * 1024 * 1024).fill(67)], 'synthetic.pdf')
    let ticks = 0
    let lastProgress = 0
    const interval = setInterval(() => ticks++, 10)
    const started = performance.now()
    try {
      const hash = await hashUpload(file, (progress: number) => { lastProgress = progress })
      return { hash, elapsedMs: Math.round(performance.now() - started), ticks, lastProgress }
    } finally { clearInterval(interval) }
  })
  expect(measurement.hash).toBe(createHash('sha256').update(Buffer.alloc(32 * 1024 * 1024, 67)).digest('hex'))
  expect(measurement.lastProgress).toBe(100)
  expect(measurement.ticks).toBeGreaterThan(0)
  await testInfo.attach('hash-performance.json', { body: JSON.stringify(measurement), contentType: 'application/json' })
})

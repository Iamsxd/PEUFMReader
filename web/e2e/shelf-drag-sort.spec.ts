import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test'
import type { ShelfDrop } from '../src/shelfOrder'

test.use({ serviceWorkers: 'block' })

// Original state-only fixtures. Every API request is intercepted, including mistakes,
// so these tests cannot mutate a real account, shelf, book or reading record.
const originalBooks = Array.from({ length: 8 }, (_, index) => ({
  id: 960100 + index,
  workId: 960100 + index,
  editionId: 960100 + index,
  title: `原创排序篇章 ${index + 1}`,
  authors: ['原创测试作者'],
  categories: [],
  format: 'pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  originalFilename: 'synthetic-sort-fixture.pdf',
  storageMode: 'managed',
  reviewRequired: false,
  textAvailable: true,
  createdAt: '2026-10-04T00:00:00Z',
}))

async function mockShelf(page: Page, options: { failures?: number; hold?: boolean; count?: number; pageSize?: number } = {}) {
  const books = originalBooks.slice(0, options.count ?? 3)
  let ids = books.map((book) => book.id)
  let failures = options.failures ?? 0
  let release = () => {}
  const gate = options.hold ? new Promise<void>((resolve) => { release = resolve }) : Promise.resolve()
  const requests = {
    order: [] as ShelfDrop[],
    arrows: [] as { bookId: number; direction: 'earlier' | 'later' }[],
    writes: [] as string[],
    unexpected: [] as string[],
  }
  await page.route('**/api/**', async (route) => {
    const { pathname: path, searchParams } = new URL(route.request().url())
    const method = route.request().method()
    if (method !== 'GET') requests.writes.push(`${method} ${path}`)
    if (method === 'GET' && path === '/api/v1/auth/me') {
      await route.fulfill({ status: 200, json: { user: { id: 960000, username: '合成排序验证', role: 'reader' }, csrfToken: 'synthetic-sort-csrf' } })
      return
    }
    if (method === 'GET' && path === '/api/v1/shelves') {
      await route.fulfill({ status: 200, json: { items: [{ id: 50, name: '原创有序清单', description: '只用于浏览器排序验证', bookCount: ids.length, createdAt: '2026-10-04T00:00:00Z' }] } })
      return
    }
    if (method === 'GET' && path === '/api/v1/shelves/50/books') {
      const pageNumber = Number(searchParams.get('page') ?? 1)
      const pageSize = options.pageSize ?? books.length
      const items = ids.slice((pageNumber - 1) * pageSize, pageNumber * pageSize).map((id) => books.find((book) => book.id === id))
      await route.fulfill({ status: 200, json: { items, total: ids.length, page: pageNumber, pageSize, totalPages: Math.ceil(ids.length / pageSize) } })
      return
    }
    if (method === 'PATCH' && path === '/api/v1/shelves/50/order') {
      const input = route.request().postDataJSON() as ShelfDrop
      requests.order.push({ ...input })
      await gate
      if (failures > 0) {
        failures--
        await route.fulfill({ status: 503, json: { error: { code: 'synthetic_failure', message: '测试：排序暂不可用' } } })
        return
      }
      if (!ids.includes(input.bookId) || !ids.includes(input.targetBookId) || input.bookId === input.targetBookId || !['before', 'after'].includes(input.placement)) {
        await route.fulfill({ status: 400, json: { error: { code: 'invalid_drop', message: '测试：无效落点' } } })
        return
      }
      ids = ids.filter((id) => id !== input.bookId)
      ids.splice(ids.indexOf(input.targetBookId) + (input.placement === 'after' ? 1 : 0), 0, input.bookId)
      await route.fulfill({ status: 204 })
      return
    }
    if (method === 'PATCH' && /^\/api\/v1\/shelves\/50\/books\/\d+$/.test(path)) {
      const bookId = Number(path.split('/').pop())
      const { direction } = route.request().postDataJSON() as { direction: 'earlier' | 'later' }
      requests.arrows.push({ bookId, direction })
      const index = ids.indexOf(bookId)
      const next = index + (direction === 'earlier' ? -1 : 1)
      if (index >= 0 && next >= 0 && next < ids.length) [ids[index], ids[next]] = [ids[next], ids[index]]
      await route.fulfill({ status: 204 })
      return
    }
    requests.unexpected.push(`${method} ${path}`)
    await route.fulfill({ status: 501, json: { error: { code: 'blocked_by_fixture', message: '测试夹具阻止未声明的 API 请求。' } } })
  })
  return { books, requests, ids: () => [...ids], release: () => release() }
}

const card = (page: Page, id: number) => page.locator(`.shelf-book[data-book-id="${id}"]`)
const handle = (page: Page, id: number) => card(page, id).locator('.shelf-drag-handle')

async function expectOrder(page: Page, ids: number[]) {
  await expect.poll(() => page.locator('.shelf-book').evaluateAll((cards) => cards.map((element) => Number((element as HTMLElement).dataset.bookId)))).toEqual(ids)
}

async function coordinates(page: Page, source: Locator, target: Locator, placement: ShelfDrop['placement']) {
  // Center both cards in the unobscured viewport before starting the drag.
  // scrollIntoView alone can leave a valid-looking drop underneath mobile nav.
  // No scrolling is synthesized during a handle drag: off-page moves remain
  // the job of the existing arrows.
  await target.scrollIntoViewIfNeeded()
  await source.scrollIntoViewIfNeeded()
  const targetID = await target.getAttribute('data-book-id')
  expect(targetID).not.toBeNull()
  await source.evaluate((element, targetBookID) => {
    const sourceCard = element.closest('.shelf-book')!
    const targetCard = document.querySelector(`.shelf-book[data-book-id="${targetBookID}"]`)!
    const sourceBounds = sourceCard.getBoundingClientRect()
    const targetBounds = targetCard.getBoundingClientRect()
    const navigation = document.querySelector('.library-sidebar')?.getBoundingClientRect()
    const safeTop = 110
    const safeBottom = navigation && navigation.width >= innerWidth * 0.8 && navigation.top > innerHeight / 2
      ? navigation.top - 16 : innerHeight - 16
    const top = Math.min(sourceBounds.top, targetBounds.top)
    const bottom = Math.max(sourceBounds.bottom, targetBounds.bottom)
    const centeredTop = safeTop + (safeBottom - safeTop - (bottom - top)) / 2
    window.scrollBy({ top: top - centeredTop, behavior: 'instant' })
  }, targetID)
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  const points = {
    start: { x: sourceBox!.x + sourceBox!.width / 2, y: sourceBox!.y + sourceBox!.height / 2 },
    end: { x: targetBox!.x + targetBox!.width / 2, y: targetBox!.y + targetBox!.height * (placement === 'before' ? 0.25 : 0.75) },
  }
  // Verify actual hit targets; coordinates behind sticky/fixed UI are not drops.
  expect(await source.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), points.start)).toBe(true)
  expect(await target.evaluate((element, point) => document.elementFromPoint(point.x, point.y)?.closest('.shelf-book') === element, points.end)).toBe(true)
  return points
}

async function startMouseDrag(page: Page, sourceID: number, targetID: number, placement: ShelfDrop['placement']) {
  const points = await coordinates(page, handle(page, sourceID), card(page, targetID), placement)
  await page.mouse.move(points.start.x, points.start.y)
  await page.mouse.down()
  await page.mouse.move(points.end.x, points.end.y, { steps: 5 })
  return points
}

async function dropMouse(page: Page, sourceID: number, targetID: number, placement: ShelfDrop['placement']) {
  await startMouseDrag(page, sourceID, targetID, placement)
  await expect(card(page, targetID)).toHaveClass(new RegExp(`drop-${placement}`))
  await page.mouse.up()
}

async function openMouseShelf(page: Page, options: Parameters<typeof mockShelf>[1] = {}) {
  await page.setViewportSize({ width: 1280, height: 1200 })
  const fixture = await mockShelf(page, options)
  await page.goto('/#/shelves?shelf=50')
  await expect(page.locator('.shelf-book')).toHaveCount(Math.min(fixture.books.length, options.pageSize ?? fixture.books.length))
  return fixture
}

async function enableTouch(page: Page): Promise<CDPSession> {
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  return session
}

async function touchAt(session: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', point?: { x: number; y: number }) {
  await session.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ ...point, id: 7 }] : [] })
}

test('mouse handle drags save both before and after placements without touching book files', async ({ page }) => {
  const fixture = await openMouseShelf(page)
  const [a, b, c] = fixture.books.map((book) => book.id)
  await dropMouse(page, a, c, 'after')
  await expectOrder(page, [b, c, a])
  await expect(page.locator('.workspace-feedback')).toContainText('阅读顺序已保存。')
  await dropMouse(page, a, b, 'before')
  await expectOrder(page, [a, b, c])
  expect(fixture.requests.order).toEqual([
    { bookId: a, targetBookId: c, placement: 'after' },
    { bookId: a, targetBookId: b, placement: 'before' },
  ])
  expect(fixture.requests.writes).toEqual(['PATCH /api/v1/shelves/50/order', 'PATCH /api/v1/shelves/50/order'])
  expect(fixture.requests.unexpected).toEqual([])
})

test('a failed drop keeps the original order and can be explicitly retried', async ({ page }) => {
  const fixture = await openMouseShelf(page, { failures: 1 })
  const [a, b, c] = fixture.books.map((book) => book.id)
  await dropMouse(page, a, c, 'after')
  await expect(page.getByRole('alert')).toContainText('测试：排序暂不可用')
  await expect(page.locator('.shelf-drag-status')).toContainText('保存失败，阅读顺序未改变。请重试。')
  await expectOrder(page, [a, b, c])
  await expect(handle(page, a)).toBeEnabled()
  expect(fixture.ids()).toEqual([a, b, c])
  expect(fixture.requests.order).toHaveLength(1)
  await dropMouse(page, a, c, 'after')
  await expectOrder(page, [b, c, a])
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(fixture.requests.order).toHaveLength(2)
  expect(fixture.requests.unexpected).toEqual([])
})

test('a pending drop locks conflicting controls and duplicate pointer events send only once', async ({ page }) => {
  const fixture = await openMouseShelf(page, { hold: true, count: 4, pageSize: 3 })
  const [a, b, c] = fixture.books.map((book) => book.id)
  try {
    await startMouseDrag(page, a, b, 'after')
    await expect(handle(page, a)).toBeEnabled()
    await expect(handle(page, b)).toBeDisabled()
    await expect(card(page, a).getByRole('button', { name: '阅读', exact: true })).toBeDisabled()
    await page.mouse.up()
    await expect.poll(() => fixture.requests.order.length).toBe(1)
    await expectOrder(page, [a, b, c])
    for (const control of await page.locator('.shelf-book button').all()) await expect(control).toBeDisabled()
    for (const name of ['＋ 新建书架', '编辑书架', '删除书架']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled()
    // The picker stays collapsed: inspect its mounted hidden input directly
    // without expanding it or initiating unrelated catalog/membership traffic.
    await expect(page.locator('.shelf-add-books input[aria-label="搜索要添加的书籍"]')).toBeDisabled()
    await expect(page.getByRole('navigation', { name: '书架分页', exact: true }).getByRole('button', { name: '下一页', exact: true })).toBeDisabled()
    await expect(page.getByRole('navigation', { name: '个人书架', exact: true }).getByRole('button')).toBeDisabled()
    // Deliberately replay events at the old source while the request is in flight.
    // This exercises the event guard in addition to the disabled appearance.
    await handle(page, a).evaluate((element) => {
      const common = { bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX: 100, clientY: 200 }
      element.dispatchEvent(new PointerEvent('pointerdown', common))
      element.dispatchEvent(new PointerEvent('pointermove', common))
      element.dispatchEvent(new PointerEvent('pointerup', common))
      element.dispatchEvent(new PointerEvent('pointerup', common))
    })
    expect(fixture.requests.order).toHaveLength(1)
    expect(fixture.requests.writes).toEqual(['PATCH /api/v1/shelves/50/order'])
  } finally { fixture.release() }
  await expectOrder(page, [b, a, c])
  await expect(handle(page, a)).toBeEnabled()
  expect(fixture.requests.unexpected).toEqual([])
})

test('Escape and pointercancel remove the insertion cue without submitting a drop', async ({ page }) => {
  const fixture = await openMouseShelf(page)
  const [a, b, c] = fixture.books.map((book) => book.id)
  await startMouseDrag(page, a, c, 'after')
  await expect(card(page, c)).toHaveClass(/drop-after/)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(page.locator('.shelf-drag-status')).toContainText('已取消排序')
  await expect(page.locator('.is-dragging, .drop-before, .drop-after')).toHaveCount(0)
  await startMouseDrag(page, a, c, 'after')
  await expect(card(page, c)).toHaveClass(/drop-after/)
  await handle(page, a).dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true })
  await page.mouse.up()
  await expect(page.locator('.shelf-drag-status')).toContainText('已取消排序')
  await expect(page.locator('.is-drag-sorting, .is-dragging, .drop-before, .drop-after')).toHaveCount(0)
  await expectOrder(page, [a, b, c])
  expect(fixture.requests.writes).toEqual([])
  expect(fixture.requests.unexpected).toEqual([])
})

test('clicks, adjacent no-op drops, outside drops and non-primary mouse buttons do not write', async ({ page }) => {
  const fixture = await openMouseShelf(page)
  const [a, b, c] = fixture.books.map((book) => book.id)
  await handle(page, a).click()
  await startMouseDrag(page, a, b, 'before')
  await expect(card(page, b)).not.toHaveClass(/drop-before/)
  await page.mouse.up()
  await startMouseDrag(page, a, c, 'after')
  await page.mouse.move(2, 2)
  await page.mouse.up()
  await handle(page, a).click({ button: 'right' })
  await expect(page.locator('.is-drag-sorting')).toHaveCount(0)
  await expectOrder(page, [a, b, c])
  expect(fixture.requests.writes).toEqual([])
  expect(fixture.requests.unexpected).toEqual([])
})

test('touch PointerEvents sort at 320px in both themes and leave card scrolling enabled', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 })
  const fixture = await mockShelf(page)
  const [a, b, c] = fixture.books.map((book) => book.id)
  await page.goto('/#/shelves?shelf=50')
  await expect(page.locator('.shelf-book')).toHaveCount(3)
  await page.evaluate(() => document.addEventListener('pointerdown', (event) => {
    if ((event.target as Element).closest('.shelf-drag-handle')) document.documentElement.dataset.sortPointerType = event.pointerType
  }))
  const touch = await enableTouch(page)
  try {
    for (const [theme, sourceID, targetID, placement, expected] of [
      ['edition', a, b, 'after', [b, a, c]],
      ['night', a, b, 'before', [a, b, c]],
    ] as const) {
      await page.getByRole('combobox', { name: '界面主题', exact: true }).selectOption(theme)
      const points = await coordinates(page, handle(page, sourceID), card(page, targetID), placement)
      await touchAt(touch, 'touchStart', points.start)
      await touchAt(touch, 'touchMove', points.end)
      await expect(card(page, targetID)).toHaveClass(new RegExp(`drop-${placement}`))
      await touchAt(touch, 'touchEnd')
      await expectOrder(page, [...expected])
      await expect(page.locator('html')).toHaveAttribute('data-sort-pointer-type', 'touch')
      expect(await handle(page, a).evaluate((element) => getComputedStyle(element).touchAction)).toBe('none')
      expect(await card(page, a).evaluate((element) => getComputedStyle(element).touchAction)).toBe('auto')
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    }
  } finally { await touch.detach() }
  expect(fixture.requests.order).toEqual([
    { bookId: a, targetBookId: b, placement: 'after' },
    { bookId: a, targetBookId: b, placement: 'before' },
  ])
  expect(fixture.requests.unexpected).toEqual([])
})

test('the existing arrow controls remain keyboard-accessible and move across page boundaries', async ({ page }) => {
  const fixture = await openMouseShelf(page, { count: 4, pageSize: 2 })
  const [a, b, c, d] = fixture.books.map((book) => book.id)
  const arrow = (id: number, direction: '提前' | '延后') => card(page, id).getByRole('button', { name: `将《${fixture.books.find((book) => book.id === id)!.title}》${direction}`, exact: true })
  const pages = page.getByRole('navigation', { name: '书架分页', exact: true })
  await expect(arrow(a, '提前')).toBeDisabled()
  await expect(arrow(b, '延后')).toBeEnabled()
  await arrow(b, '延后').focus()
  await page.keyboard.press('Enter')
  await expectOrder(page, [a, c])
  expect(fixture.ids()).toEqual([a, c, b, d])
  await pages.getByRole('button', { name: '下一页', exact: true }).click()
  await expectOrder(page, [b, d])
  await expect(arrow(d, '延后')).toBeDisabled()
  await expect(arrow(b, '提前')).toBeEnabled()
  await arrow(b, '提前').focus()
  await page.keyboard.press('Space')
  await expectOrder(page, [c, d])
  expect(fixture.ids()).toEqual([a, b, c, d])
  expect(fixture.requests.arrows).toEqual([{ bookId: b, direction: 'later' }, { bookId: b, direction: 'earlier' }])
  expect(fixture.requests.order).toEqual([])
  expect(fixture.requests.unexpected).toEqual([])
})

test('swiping ordinary card text scrolls normally without starting a sort', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 })
  const fixture = await mockShelf(page, { count: 8 })
  await page.goto('/#/shelves?shelf=50')
  await expect(page.locator('.shelf-book')).toHaveCount(8)
  const title = card(page, fixture.books[0].id).getByRole('heading')
  await title.scrollIntoViewIfNeeded()
  const box = await title.boundingBox()
  expect(box).not.toBeNull()
  const start = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
  const before = await page.evaluate(() => scrollY)
  const touch = await enableTouch(page)
  try {
    await touchAt(touch, 'touchStart', start)
    for (let step = 1; step <= 6; step++) await touchAt(touch, 'touchMove', { x: start.x, y: start.y - step * 30 })
    await touchAt(touch, 'touchEnd')
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(before + 60)
  } finally { await touch.detach() }
  await expect(page.locator('.is-drag-sorting, .is-dragging, .drop-before, .drop-after')).toHaveCount(0)
  expect(fixture.requests.writes).toEqual([])
  expect(fixture.requests.unexpected).toEqual([])
})

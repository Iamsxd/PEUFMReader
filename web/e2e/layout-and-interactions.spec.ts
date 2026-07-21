import { expect, test, type Page, type TestInfo } from '@playwright/test'

async function login(page: Page) {
  await page.goto('/')
  const loginButton = page.getByRole('button', { name: '登录' })
  if (!await loginButton.isVisible().catch(() => false)) return
  const username = process.env.E2E_ADMIN_USERNAME ?? process.env.ADMIN_USERNAME ?? 'admin'
  const password = process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD
  if (!password) throw new Error('Set E2E_ADMIN_PASSWORD or ADMIN_PASSWORD before running browser tests.')
  await page.getByLabel('用户名').fill(username)
  await page.getByLabel('密码').fill(password)
  await loginButton.click()
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
}

async function expectNoPageOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))
  expect(overflow.body).toBeLessThanOrEqual(1)
  expect(overflow.root).toBeLessThanOrEqual(1)
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
}

test.beforeEach(async ({ page }) => login(page))

test('primary navigation stays usable and ordered', async ({ page }, testInfo) => {
  const navigation = page.getByRole('navigation', { name: '主导航' })
  const names = ['首页', '推荐', '收藏', '全部书籍', '分类']
  for (const name of names) await expect(navigation.getByRole('button', { name, exact: true })).toBeVisible()
  const visibleOrder = await navigation.locator('.app-navigation-primary > button').allTextContents()
  expect(visibleOrder).toEqual(names)

  await navigation.getByRole('button', { name: '推荐', exact: true }).click()
  await expect(page.getByRole('heading', { name: '为你推荐' })).toBeVisible()
  await navigation.getByRole('button', { name: '收藏', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我的收藏' })).toBeVisible()
  await navigation.getByRole('button', { name: '全部书籍', exact: true }).click()
  await expect(page.getByRole('heading', { name: '全部书籍' })).toBeVisible()
  await navigation.getByRole('button', { name: '分类', exact: true }).click()
  await expect(page.getByRole('heading', { name: '书籍分类' })).toBeVisible()
  await expectNoPageOverflow(page)
  await capture(page, testInfo, 'primary-navigation')
})

test('recommendation feedback is interactive and responsive', async ({ page }, testInfo) => {
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '推荐', exact: true }).click()
  await expect(page.getByRole('heading', { name: '为你推荐' })).toBeVisible()
  const interested = page.getByRole('button', { name: '✓ 感兴趣' }).first()
  test.skip(await interested.count() === 0, 'The current library has no recommendation candidate.')
  await interested.click()
  await expect(page.getByRole('button', { name: '✓ 感兴趣' }).first()).toHaveClass(/active/)
  await expectNoPageOverflow(page)
  await capture(page, testInfo, 'recommendation-feedback')
})

test('admin workspaces do not collapse into one oversized page', async ({ page }, testInfo) => {
  const more = page.locator('details.navigation-menu')
  await more.locator('summary').click()
  const admin = more.getByRole('button', { name: /管理后台/ })
  test.skip(await admin.count() === 0, 'The configured E2E account is not an administrator.')
  await admin.click()
  await expect(page.getByRole('heading', { name: '管理后台' })).toBeVisible()
  const workspaces = page.getByRole('navigation', { name: '管理后台工作区' })
  for (const name of ['书籍导入', '书目与分类', '用户与权限', '任务与运维']) {
    await workspaces.getByRole('button', { name: new RegExp(name) }).click()
    await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible()
    if (name === '用户与权限') {
      await expect(page.getByTestId('group-permission-manager')).toBeVisible()
      await expect(page.getByRole('heading', { name: '书库组与用户组' })).toBeVisible()
    }
  }
  await expectNoPageOverflow(page)
  await capture(page, testInfo, 'admin-workspaces')
})

test('book detail and reader controls remain reachable', async ({ page }, testInfo) => {
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '全部书籍', exact: true }).click()
  await expect(page.getByRole('heading', { name: '全部书籍' })).toBeVisible()
  const firstBook = page.locator('.book-card .book-open').first()
  test.skip(await firstBook.count() === 0, 'The current library has no books to open.')
  await firstBook.click()
  await expect(page.locator('.book-detail-page h1')).toBeVisible()
  await page.getByRole('button', { name: /开始阅读|继续阅读|重新阅读/ }).click()
  const readerToolbar = page.getByRole('toolbar', { name: /PDF 阅读工具|EPUB 阅读工具/ })
  await expect(readerToolbar).toBeVisible()
  await expect(readerToolbar.getByRole('button', { name: /书签\/高亮/ })).toBeVisible()
  await capture(page, testInfo, 'reader-controls')
})

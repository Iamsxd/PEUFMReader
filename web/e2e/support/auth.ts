import { expect, type Page } from '@playwright/test'

export async function login(page: Page) {
  await page.goto('/')
  const navigation = page.getByRole('navigation', { name: '主导航' })
  const loginButton = page.getByRole('button', { name: '登录' })
  await expect.poll(async () => await navigation.isVisible().catch(() => false) || await loginButton.isVisible().catch(() => false)).toBe(true)
  if (await navigation.isVisible().catch(() => false)) return

  const username = process.env.E2E_ADMIN_USERNAME ?? process.env.ADMIN_USERNAME ?? 'admin'
  const password = process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD
  if (!password) throw new Error('Set E2E_ADMIN_PASSWORD or ADMIN_PASSWORD before running browser tests.')
  await page.getByLabel('用户名').fill(username)
  await page.getByLabel('密码').fill(password)
  await loginButton.click()
  await expect(navigation).toBeVisible()
}

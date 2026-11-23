import type { Page } from '@playwright/test'
import { APP_THEMES, AUTO_THEME, type AppThemePreference } from '../../src/theme'

const labelFor = (theme: AppThemePreference) => theme === 'auto' ? AUTO_THEME.label : APP_THEMES[theme].label

/** The radio for one skin. A closed gallery hides it from the accessibility tree, so use the DOM for state checks. */
export function appThemeOption(page: Page, theme: AppThemePreference) {
  return page.locator(`.theme-gallery input[name="app-theme"][value="${theme}"]`)
}

/** Open the gallery, pick a skin and close it again, like a user would. */
export async function chooseAppTheme(page: Page, theme: AppThemePreference) {
  const menu = page.locator('details.theme-switch')
  if (!await menu.evaluate((element: HTMLDetailsElement) => element.open)) await menu.locator('summary').click()
  await page.getByRole('radiogroup', { name: '界面主题' }).getByRole('radio', { name: labelFor(theme), exact: true }).check()
  await page.keyboard.press('Escape')
}

/** Open the reader appearance panel (if needed) and pick a reading skin by label. */
export async function chooseReaderTheme(page: Page, label: string) {
  const toolbar = page.locator('.reader-toolbar[role="toolbar"]')
  const panel = page.locator('.reader-appearance-panel')
  if (!await panel.isVisible()) await toolbar.getByRole('button', { name: '外观', exact: true }).click()
  await panel.getByRole('button', { name: label, exact: true }).click()
}

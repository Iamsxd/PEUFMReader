import { mkdir, readFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const source = await readFile(new URL('../public/favicon.svg', import.meta.url), 'utf8')
await mkdir(new URL('../public/icons/', import.meta.url), { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  for (const [filename, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}svg{display:block;width:100%;height:100%}</style>${source}`)
    await page.screenshot({ path: new URL(`../public/icons/${filename}`, import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1)), omitBackground: true })
  }
  await page.setViewportSize({ width: 512, height: 512 })
  await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#24563a;display:grid;place-items:center}svg{display:block;width:80%;height:80%}</style>${source}`)
  await page.screenshot({ path: new URL('../public/icons/icon-maskable-512.png', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1)) })
} finally {
  await browser.close()
}

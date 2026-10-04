export type EPUBPageFlow = 'paged' | 'continuous'
export type EPUBPageLayout = 'single' | 'spread'
export type EPUBTheme = 'paper' | 'sepia' | 'night'
export type EPUBFontFamily = 'serif' | 'sans' | 'system'

export interface EPUBTypographyPreferences {
  fontFamily: EPUBFontFamily
  lineHeight: number
  paragraphSpacing: number
  sideMargin: number
  maxLineWidth: number
  respectBookStyles: boolean
}

export interface EPUBReaderPreferences {
  flow: EPUBPageFlow
  layout: EPUBPageLayout
  fontSize: number
  theme: EPUBTheme
}

export interface EPUBNavigationItem {
  id?: string
  href: string
  label: string
  subitems?: EPUBNavigationItem[]
}

export interface EPUBTOCEntry {
  id: string
  href: string
  label: string
  depth: number
}

export const EPUB_PREFERENCES_KEY = 'peufmreader.epub.preferences.v1'
// Keep typography independent of the existing reading preferences and app theme.
// These are device defaults, not a server-side or per-book reading profile.
export const EPUB_TYPOGRAPHY_KEY = 'peufmreader.epub.typography.v1'
export const DEFAULT_EPUB_TYPOGRAPHY: EPUBTypographyPreferences = {
  fontFamily: 'serif',
  lineHeight: 1.7,
  paragraphSpacing: 0.8,
  sideMargin: 4,
  maxLineWidth: 72,
  respectBookStyles: false,
}
export const EPUB_FONT_FAMILIES: Record<EPUBFontFamily, string> = {
  serif: '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif',
  sans: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif',
  system: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
}
export const EPUB_MIN_FONT_SIZE = 70
export const EPUB_MAX_FONT_SIZE = 180

const defaultPreferences: EPUBReaderPreferences = {
  flow: 'paged',
  layout: 'single',
  fontSize: 100,
  theme: 'paper',
}

export function clampEPUBFontSize(value: number): number {
  if (!Number.isFinite(value)) return defaultPreferences.fontSize
  return Math.min(EPUB_MAX_FONT_SIZE, Math.max(EPUB_MIN_FONT_SIZE, Math.round(value)))
}

// epub.js treats an explicit `openAs: 'epub'` value as a URL, even when the
// input is an ArrayBuffer from the offline cache. Keep cached archives on its
// binary path so it does not request "/[object ArrayBuffer]".
export function resolveEPUBOpenAs(contentData?: ArrayBuffer): 'binary' | 'epub' {
  return contentData === undefined ? 'epub' : 'binary'
}

export function parseEPUBPreferences(value: string | null): EPUBReaderPreferences {
  if (!value) return { ...defaultPreferences }
  try {
    const candidate = JSON.parse(value) as Partial<EPUBReaderPreferences>
    return {
      flow: candidate.flow === 'continuous' ? 'continuous' : 'paged',
      layout: candidate.layout === 'spread' ? 'spread' : 'single',
      fontSize: clampEPUBFontSize(typeof candidate.fontSize === 'number' ? candidate.fontSize : defaultPreferences.fontSize),
      theme: candidate.theme === 'sepia' || candidate.theme === 'night' ? candidate.theme : 'paper',
    }
  } catch {
    return { ...defaultPreferences }
  }
}

function clampTypographyNumber(value: unknown, fallback: number, minimum: number, maximum: number, step: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Number((Math.round(Math.min(maximum, Math.max(minimum, value)) / step) * step).toFixed(2))
}

export function parseEPUBTypography(value: string | null): EPUBTypographyPreferences {
  if (!value) return { ...DEFAULT_EPUB_TYPOGRAPHY }
  try {
    const candidate = JSON.parse(value) as Partial<EPUBTypographyPreferences> | null
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return { ...DEFAULT_EPUB_TYPOGRAPHY }
    return {
      fontFamily: candidate.fontFamily === 'sans' || candidate.fontFamily === 'system' ? candidate.fontFamily : 'serif',
      lineHeight: clampTypographyNumber(candidate.lineHeight, DEFAULT_EPUB_TYPOGRAPHY.lineHeight, 1.2, 2.4, 0.1),
      paragraphSpacing: clampTypographyNumber(candidate.paragraphSpacing, DEFAULT_EPUB_TYPOGRAPHY.paragraphSpacing, 0, 2, 0.1),
      sideMargin: clampTypographyNumber(candidate.sideMargin, DEFAULT_EPUB_TYPOGRAPHY.sideMargin, 0, 12, 1),
      maxLineWidth: clampTypographyNumber(candidate.maxLineWidth, DEFAULT_EPUB_TYPOGRAPHY.maxLineWidth, 36, 96, 2),
      respectBookStyles: candidate.respectBookStyles === true,
    }
  } catch {
    return { ...DEFAULT_EPUB_TYPOGRAPHY }
  }
}

export function getEPUBTypographyRules(preferences: EPUBTypographyPreferences): Record<string, Record<string, string>> {
  const safetyRules = {
    'html, body': { 'box-sizing': 'border-box' },
    img: { 'max-width': '100%', height: 'auto' },
  }
  // EPUB.js owns body padding/columns. Limit text blocks instead of replacing
  // its inline geometry, which could otherwise break pagination and RTL books.
  if (preferences.respectBookStyles) return safetyRules
  return {
    ...safetyRules,
    'body, p, li, dt, dd, blockquote': {
      'font-family': `${EPUB_FONT_FAMILIES[preferences.fontFamily]} !important`,
      'line-height': `${preferences.lineHeight} !important`,
    },
    'p, h1, h2, h3, h4, h5, h6, blockquote, ul, ol': {
      'box-sizing': 'border-box',
      'max-width': `min(${preferences.maxLineWidth}ch, ${100 - preferences.sideMargin * 2}%) !important`,
      'margin-left': 'auto !important',
      'margin-right': 'auto !important',
    },
    p: { 'margin-top': '0 !important', 'margin-bottom': `${preferences.paragraphSpacing}em !important` },
  }
}

export function findCurrentEPUBTOCEntry(toc: EPUBTOCEntry[], href: string): EPUBTOCEntry | undefined {
  if (!href) return undefined
  const exact = toc.find((entry) => entry.href === href)
  if (exact) return exact
  const normalize = (value: string) => {
    try { return decodeURI(value.split('#')[0]).replace(/^(?:\.\/|\/)+/, '') } catch { return value.split('#')[0] }
  }
  const current = normalize(href)
  const matching = toc.filter((entry) => {
    const target = normalize(entry.href)
    return target === current || current.endsWith(`/${target}`)
  })
  // A rendered location usually has only the chapter href, not a fragment.
  // Prefer its chapter entry; do not claim an arbitrary nested section is active.
  return matching.find((entry) => !entry.href.includes('#')) ?? matching[0]
}

export function normalizeEPUBWheelDelta(deltaX: number, deltaY: number, deltaMode: number, viewportHeight: number): number {
  const dominantDelta = Math.abs(deltaY) >= Math.abs(deltaX) ? deltaY : deltaX
  if (deltaMode === 1) return dominantDelta * 16
  if (deltaMode === 2) return dominantDelta * Math.max(1, viewportHeight)
  return dominantDelta
}

export function resolveEPUBProgress(generated: number | undefined, reported: number | undefined, fallback: number): number {
  for (const value of [generated, reported, fallback]) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) return value
  }
  return 0
}

export function flattenEPUBNavigation(items: EPUBNavigationItem[], depth = 0): EPUBTOCEntry[] {
  const result: EPUBTOCEntry[] = []
  for (const [index, item] of items.entries()) {
    if (item.href && item.label.trim()) {
      result.push({ id: item.id || `${depth}-${index}-${item.href}`, href: item.href, label: item.label.trim(), depth })
    }
    if (item.subitems?.length) result.push(...flattenEPUBNavigation(item.subitems, depth + 1))
  }
  return result
}

export function getEPUBRestoreTargets(position: Record<string, unknown>): Array<string | number> {
  const targets: Array<string | number> = []
  if (typeof position.cfi === 'string' && position.cfi.trim()) targets.push(position.cfi)
  if (typeof position.href === 'string' && position.href.trim() && !targets.includes(position.href)) targets.push(position.href)
  if (typeof position.chapterIndex === 'number' && Number.isInteger(position.chapterIndex) && position.chapterIndex >= 0) targets.push(position.chapterIndex)
  return targets
}

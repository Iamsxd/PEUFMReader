export type EPUBPageFlow = 'paged' | 'continuous'
export type EPUBPageLayout = 'single' | 'spread'
export type EPUBTheme = 'paper' | 'sepia' | 'night'

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

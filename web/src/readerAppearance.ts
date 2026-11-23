// Reading-surface skins shared by the EPUB and PDF readers. They are independent
// from the application skin: a dark library can still read on warm paper.
export type ReaderTheme = 'paper' | 'sepia' | 'green' | 'mist' | 'night' | 'oled'
export type ReaderTone = 'light' | 'dark'

export interface ReaderThemeDefinition {
  label: string
  description: string
  tone: ReaderTone
  /** EPUB page and text colours. */
  page: string
  ink: string
  link: string
  /** Area around EPUB pages (spread gutter, loading state). */
  stage: string
  /** Area around rendered PDF pages. */
  pdfStage: string
  /** Applied to rendered PDF canvases; `none` keeps the original page colours. */
  pdfFilter: string
}

export const READER_THEMES = {
  paper: { label: '日间', description: '暖白纸张', tone: 'light', page: '#f8f5ed', ink: '#19231d', link: '#27613f', stage: '#f8f5ed', pdfStage: '#dcd9d1', pdfFilter: 'none' },
  sepia: { label: '护眼', description: '羊皮纸黄', tone: 'light', page: '#eee2c8', ink: '#3d3022', link: '#765322', stage: '#d8c7a7', pdfStage: '#cdbb98', pdfFilter: 'sepia(.42) saturate(1.2) brightness(.96)' },
  green: { label: '豆沙绿', description: '柔和绿底', tone: 'light', page: '#cfe6d0', ink: '#1d3324', link: '#245c37', stage: '#bcd8be', pdfStage: '#aac6ad', pdfFilter: 'sepia(.3) hue-rotate(55deg) saturate(1.25) brightness(.93)' },
  mist: { label: '雾蓝', description: '清冷灰蓝', tone: 'light', page: '#e4eaf0', ink: '#1c2833', link: '#2c5b85', stage: '#d3dce5', pdfStage: '#c3cdd8', pdfFilter: 'sepia(.22) hue-rotate(175deg) saturate(.85) brightness(.97)' },
  night: { label: '夜间', description: '深色低亮', tone: 'dark', page: '#18211c', ink: '#d8ded9', link: '#91c8a1', stage: '#111813', pdfStage: '#0e1411', pdfFilter: 'invert(.9) hue-rotate(180deg) brightness(.95) contrast(.92)' },
  oled: { label: '纯黑', description: 'OLED 省电', tone: 'dark', page: '#000000', ink: '#c9c9c9', link: '#9bbcff', stage: '#000000', pdfStage: '#000000', pdfFilter: 'invert(1) hue-rotate(180deg) contrast(.9)' },
} as const satisfies Record<ReaderTheme, ReaderThemeDefinition>

export const READER_THEME_IDS = Object.keys(READER_THEMES) as ReaderTheme[]

export function isReaderTheme(value: unknown): value is ReaderTheme {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(READER_THEMES, value)
}

export function parseReaderTheme(value: unknown, fallback: ReaderTheme = 'paper'): ReaderTheme {
  return isReaderTheme(value) ? value : fallback
}

/** epub.js theme rules for one reader skin. */
export function getEPUBThemeRules(theme: ReaderTheme): Record<string, Record<string, string>> {
  const definition = READER_THEMES[theme]
  return {
    'html, body': { color: definition.ink, background: definition.page },
    a: { color: definition.link },
    '::selection': { background: definition.tone === 'dark' ? '#ffffff33' : '#2d604133' },
  }
}

// Device-wide comfort settings shared by every format.
export interface ReaderComfort {
  /** 40–100: a dimming overlay over the page, below the reader controls. */
  brightness: number
  /** 0–60: amber night-light overlay strength. */
  warmth: number
}

export const READER_COMFORT_KEY = 'peufmreader.reader.comfort.v1'
export const DEFAULT_READER_COMFORT: ReaderComfort = { brightness: 100, warmth: 0 }
export const READER_COMFORT_EVENT = 'peufmreader:reader-comfort'

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.round(Math.min(maximum, Math.max(minimum, value)))
}

export function parseReaderComfort(value: string | null): ReaderComfort {
  if (!value) return { ...DEFAULT_READER_COMFORT }
  try {
    const candidate = JSON.parse(value) as Partial<ReaderComfort> | null
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return { ...DEFAULT_READER_COMFORT }
    return {
      brightness: clampInteger(candidate.brightness, DEFAULT_READER_COMFORT.brightness, 40, 100),
      warmth: clampInteger(candidate.warmth, DEFAULT_READER_COMFORT.warmth, 0, 60),
    }
  } catch {
    return { ...DEFAULT_READER_COMFORT }
  }
}

export function loadReaderComfort(): ReaderComfort {
  try { return parseReaderComfort(window.localStorage.getItem(READER_COMFORT_KEY)) } catch { return { ...DEFAULT_READER_COMFORT } }
}

export function saveReaderComfort(comfort: ReaderComfort): void {
  try { window.localStorage.setItem(READER_COMFORT_KEY, JSON.stringify(comfort)) } catch { /* best effort */ }
}

/** Overlay colours for the comfort layer; transparent when nothing is applied. */
export function getReaderComfortOverlay(comfort: ReaderComfort): { dim: number; warmth: number } {
  return {
    dim: Number(((100 - comfort.brightness) / 100 * 0.85).toFixed(3)),
    warmth: Number((comfort.warmth / 100 * 0.45).toFixed(3)),
  }
}

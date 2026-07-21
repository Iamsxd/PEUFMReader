declare module 'epubjs' {
  export interface LocationCollection {
    generate(chars?: number): Promise<string[]>
    cfiFromPercentage(percentage: number): string
    percentageFromCfi(cfi: string): number
  }

  export interface ThemeManager {
    default(styles: Record<string, Record<string, string>>): void
    register(name: string, styles: Record<string, Record<string, string>>): void
    select(name: string): void
    fontSize(size: string): void
  }

  export interface Contents {
    document: Document
  }

  export interface Hook {
    register(callback: (contents: Contents) => void): void
    deregister(callback: (contents: Contents) => void): void
  }

  export interface Rendition {
    themes: ThemeManager
    hooks: { content: Hook }
    annotations: {
      highlight(cfiRange: string, data?: object, callback?: (...args: unknown[]) => void, className?: string, styles?: Record<string, string>): void
      remove(cfiRange: string, type: 'highlight'): void
    }
    display(target?: string | number): Promise<unknown>
    prev(): Promise<unknown>
    next(): Promise<unknown>
    flow(flow: 'paginated' | 'scrolled-continuous'): void
    spread(spread: 'none' | 'auto', minWidth?: number): void
    on<TArgs extends unknown[]>(event: string, callback: (...args: TArgs) => void): void
    off<TArgs extends unknown[]>(event: string, callback: (...args: TArgs) => void): void
    destroy(): void
  }

  export interface Book {
    ready: Promise<Book>
    loaded: { navigation: Promise<Navigation> }
    spine: Spine
    locations: LocationCollection
    load(path: string): Promise<Document>
    renderTo(element: Element, options: Record<string, unknown>): Rendition
    destroy(): void
  }

  export interface NavigationItem {
    id?: string
    href: string
    label: string
    subitems: NavigationItem[]
  }

  export interface Navigation {
    toc: NavigationItem[]
  }

  export interface SectionSearchResult {
    cfi: string
    excerpt: string
  }

  export interface Section {
    index: number
    href: string
    linear: boolean
    load(request: (path: string) => Promise<Document>): Promise<unknown>
    find(query: string): SectionSearchResult[]
    unload(): void
  }

  export interface Spine {
    spineItems: Section[]
  }

  export interface BookOptions {
    requestCredentials?: boolean
    openAs?: 'epub' | 'binary' | 'base64' | 'opf' | 'json' | 'directory'
    requestMethod?: (url: string, type?: string, withCredentials?: boolean, headers?: Record<string, string>) => Promise<unknown>
  }

  export default function ePub(input: string | ArrayBuffer, options?: BookOptions): Book
}

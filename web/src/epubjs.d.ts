declare module 'epubjs' {
  export interface LocationCollection {
    generate(chars?: number): Promise<string[]>
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
    display(target?: string): Promise<unknown>
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
    locations: LocationCollection
    renderTo(element: Element, options: Record<string, unknown>): Rendition
    destroy(): void
  }

  export interface BookOptions {
    requestCredentials?: boolean
  }

  export default function ePub(input: string | ArrayBuffer, options?: BookOptions): Book
}

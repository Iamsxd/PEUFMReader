declare module 'epubjs' {
  export interface LocationCollection {
    generate(chars?: number): Promise<string[]>
    percentageFromCfi(cfi: string): number
  }

  export interface ThemeManager {
    default(styles: Record<string, Record<string, string>>): void
  }

  export interface Rendition {
    themes: ThemeManager
    display(target?: string): Promise<unknown>
    prev(): Promise<unknown>
    next(): Promise<unknown>
    on(event: string, callback: (...args: never[]) => void): void
    off(event: string, callback: (...args: never[]) => void): void
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

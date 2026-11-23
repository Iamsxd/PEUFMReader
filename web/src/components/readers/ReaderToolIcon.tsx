export type ReaderToolIconName = 'toc' | 'search' | 'marks' | 'speech' | 'appearance' | 'typography' | 'text' | 'crop' | 'back' | 'forward' | 'collapse'

const paths: Record<ReaderToolIconName, string> = {
  toc: 'M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z M20 20l-4-4',
  marks: 'M6 3h12v18l-6-4-6 4Z',
  speech: 'M4 10v4 M8 7v10 M12 4v16 M16 7v10 M20 10v4',
  appearance: 'M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.5-.2-.8-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-4.1-4-7.4-9-7.4Z M7.5 11.5h.01 M10 7.5h.01 M14.5 7.5h.01',
  typography: 'M4 7V5h11v2 M9.5 5v14 M7 19h5 M14 13v-1.5h6V13 M17 11.5V19 M15.5 19h3',
  text: 'M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5',
  crop: 'M6 2v14a2 2 0 0 0 2 2h14 M18 22V8a2 2 0 0 0-2-2H2',
  back: 'M9 14 4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  forward: 'm15 14 5-5-5-5 M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  collapse: 'm18 15-6-6-6 6',
}

export function ReaderToolIcon({ name }: { name: ReaderToolIconName }) {
  return <svg className="reader-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}

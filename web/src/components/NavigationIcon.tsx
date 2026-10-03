type IconName = 'home' | 'books' | 'recommendations' | 'favorites' | 'categories' | 'statistics' | 'notebook' | 'shelves' | 'more'

const paths: Record<IconName, string> = {
  home: 'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  books: 'M4 4h6v16H4z M14 4h6v16h-6z M7 7v4 M17 7v4',
  recommendations: 'm12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7Z',
  favorites: 'M20.8 5.8a5.5 5.5 0 0 0-7.8 0L12 7l-1-1.2a5.5 5.5 0 0 0-7.8 7.8L12 22l8.8-8.4a5.5 5.5 0 0 0 0-7.8Z',
  categories: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  statistics: 'M4 20V10 M12 20V4 M20 20v-7',
  notebook: 'M5 3h14v18H5z M8 7h8 M8 11h8 M8 15h5',
  shelves: 'M3 20h18 M5 4h4v12H5z M12 4h4v12h-4z M18 6l3 10',
  more: 'M4 6h16 M4 12h16 M4 18h16',
}

export function NavigationIcon({ name }: { name: IconName }) {
  return <svg className="navigation-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}

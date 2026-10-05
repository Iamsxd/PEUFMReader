import { adminAPI } from './admin'
import { authAPI } from './auth'
import { catalogAPI } from './catalog'
import { readingAPI } from './reading'
import { searchAPI } from './search'

export const api = {
  ...authAPI,
  ...catalogAPI,
  ...adminAPI,
  ...readingAPI,
  ...searchAPI,
}

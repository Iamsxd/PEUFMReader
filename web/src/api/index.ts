import { adminAPI } from './admin'
import { authAPI } from './auth'
import { catalogAPI } from './catalog'
import { readingAPI } from './reading'

export const api = {
  ...authAPI,
  ...catalogAPI,
  ...adminAPI,
  ...readingAPI,
}

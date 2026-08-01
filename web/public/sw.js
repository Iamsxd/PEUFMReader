const SHELL_CACHE = 'peufmreader-shell-__BUILD_REVISION__'
const SHELL_PREFIX = 'peufmreader-shell-'

self.addEventListener('install', (event) => {
  event.waitUntil(Promise.all([
    fetch('/', { cache: 'no-store' }),
    fetch('/offline-assets.json', { cache: 'no-store' }).then((response) => response.json()),
  ]).then(async ([entry, manifest]) => {
    if (!entry.ok || !Array.isArray(manifest.files)) throw new Error('Offline shell manifest is unavailable.')
    const cache = await caches.open(SHELL_CACHE)
    await cache.put('/', entry)
    await cache.addAll(manifest.files)
  }))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(
    names.filter((name) => name.startsWith(SHELL_PREFIX) && name !== SHELL_CACHE).map((name) => caches.delete(name)),
  )))
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/opds')) return

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) void caches.open(SHELL_CACHE).then((cache) => cache.put('/', response.clone()))
      return response
    }).catch(async () => (await caches.match('/')) || Response.error()))
    return
  }

  if (!['style', 'script', 'worker', 'font', 'image', 'manifest'].includes(request.destination)) return
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok) void caches.open(SHELL_CACHE).then((cache) => cache.put(request, response.clone()))
    return response
  })))
})

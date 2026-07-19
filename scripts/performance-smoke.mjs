const baseURL = (process.env.BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '')
const username = process.env.ADMIN_USERNAME || 'admin'
const password = process.env.ADMIN_PASSWORD
const requestCount = Number(process.env.REQUEST_COUNT || 200)
const concurrency = Number(process.env.CONCURRENCY || 10)

if (!password) throw new Error('ADMIN_PASSWORD is required')
if (!Number.isInteger(requestCount) || requestCount < 1 || !Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error('REQUEST_COUNT and CONCURRENCY must be positive integers')
}

const login = await fetch(`${baseURL}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password }),
})
if (!login.ok) throw new Error(`Login failed with HTTP ${login.status}`)
const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
if (!cookie) throw new Error('Login response did not include a session cookie')

const endpoints = [
  ['/api/v1/home', 'home'],
  ['/api/v1/book-files?page=1&pageSize=24&sort=newest', 'catalog-newest'],
  ['/api/v1/book-files?q=Performance%20Book%202999&page=1&pageSize=24&sort=relevance', 'catalog-search'],
  ['/api/v1/book-files?category=technology&page=1&pageSize=24&sort=title', 'catalog-category'],
]

const results = []
for (const [path, label] of endpoints) {
  for (let warmup = 0; warmup < 5; warmup += 1) await request(path)
  const durations = []
  let next = 0
  let failures = 0
  const started = performance.now()
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < requestCount) {
      next += 1
      const requestStarted = performance.now()
      try {
        await request(path)
      } catch {
        failures += 1
      }
      durations.push(performance.now() - requestStarted)
    }
  }))
  const elapsed = performance.now() - started
  durations.sort((a, b) => a - b)
  results.push({
    endpoint: label,
    requests: requestCount,
    concurrency,
    failures,
    requestsPerSecond: round(requestCount / (elapsed / 1000)),
    p50Ms: round(percentile(durations, 0.5)),
    p95Ms: round(percentile(durations, 0.95)),
    maxMs: round(durations.at(-1) || 0),
  })
}

console.log(JSON.stringify({ baseURL, results }, null, 2))

async function request(path) {
  const response = await fetch(`${baseURL}${path}`, { headers: { Cookie: cookie } })
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`)
  await response.arrayBuffer()
}

function percentile(values, fraction) {
  if (values.length === 0) return 0
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)]
}

function round(value) {
  return Math.round(value * 10) / 10
}


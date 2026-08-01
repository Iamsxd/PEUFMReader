import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const outputRoot = new URL('../dist/', import.meta.url)
const outputPath = outputRoot.pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1))

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(path))
    else files.push(path)
  }
  return files
}

const paths = (await walk(outputPath))
  .filter((path) => !['index.html', 'offline-assets.json'].includes(relative(outputPath, path)))
  .sort()
const files = paths.map((path) => `/${relative(outputPath, path).split(sep).join('/')}`)
const digest = createHash('sha256')
for (const [index, path] of paths.entries()) {
  digest.update(files[index]).update(await readFile(path))
}
const revision = digest.digest('hex').slice(0, 12)
const workerPath = join(outputPath, 'sw.js')
const worker = await readFile(workerPath, 'utf8')
await writeFile(workerPath, worker.replace('__BUILD_REVISION__', revision))
await writeFile(join(outputPath, 'offline-assets.json'), `${JSON.stringify({ revision, files }, null, 2)}\n`)

process.stdout.write(`offline assets: ${files.length} files, revision ${revision}\n`)

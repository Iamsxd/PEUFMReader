import { minimalPDF } from './pdf'

/** Original, in-memory fixtures; never read or upload files from a user's library. */
export function refinementPDF(pageHeights: number[] = [4000, 4000, 4000]): Buffer {
  const pageCount = pageHeights.length
  const fontID = 3 + pageCount
  const pageIDs = Array.from({ length: pageCount }, (_, index) => 3 + index)
  const contentIDs = pageIDs.map((_, index) => fontID + 1 + index)
  const streams = pageIDs.map((_, index) => {
    const lines = Array.from({ length: Math.round(pageHeights[index] * 0.03) }, (_, line) => {
      const text = `Original page ${index + 1}, line ${line + 1}: an anchor for reader regression.`
      return `BT /F1 12 Tf 42 ${pageHeights[index] - 60 - line * 31} Td (${text}) Tj ET`
    })
    return lines.join('\n')
  })
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    `<</Type/Pages/Kids[${pageIDs.map(id => `${id} 0 R`).join(' ')}]/Count ${pageCount}>>`,
    ...pageIDs.map((_, index) => `<</Type/Page/Parent 2 0 R/MediaBox[0 0 600 ${pageHeights[index]}]/Resources<</Font<</F1 ${fontID} 0 R>>>>/Contents ${contentIDs[index]} 0 R>>`),
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    ...streams.map(stream => `<</Length ${Buffer.byteLength(stream, 'ascii')}>>\nstream\n${stream}\nendstream`),
  ]
  let content = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(content, 'ascii'))
    content += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(content, 'ascii')
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  content += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  content += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(content, 'ascii')
}

/** Short speech sources keep Web Speech callbacks deterministic and fast. */
export function refinementSpeechPDF(): Buffer {
  return minimalPDF([
    'Original speech page One begins this continuous reading sample.',
    'Original speech page Two continues without a manual page turn.',
    'Original speech page Three completes this original sample.',
  ])
}

export function refinementEPUB(options: { speech?: boolean } = {}): Buffer {
  const chapters = ['One', 'Two', 'Three']
  const files: Array<[string, string]> = [
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ['OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">reader-refinements-original</dc:identifier><dc:title>Reader Refinements Original</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-10-04T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map(name => `<item id="${name.toLowerCase()}" href="${name.toLowerCase()}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${chapters.map(name => `<itemref idref="${name.toLowerCase()}"/>`).join('')}</spine></package>`],
    ['OEBPS/nav.xhtml', `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${chapters.map(name => `<li><a href="${name.toLowerCase()}.xhtml">Chapter ${name}</a></li>`).join('')}</ol></nav></body></html>`],
    ...chapters.map((name, chapterIndex): [string, string] => {
      const paragraphs = options.speech ? `<p>Original speech chapter ${name} is a short continuous reading sample.</p>` : Array.from({ length: 28 }, (_, index) => {
        const unique = chapterIndex === 2 && index === 12 ? ' NeedleInThirdChapter marks this exact search destination.' : ''
        return `<p id="paragraph-${index}">Chapter ${name}, original paragraph ${index + 1}. This is a synthetic passage written for layout regression. We keep enough words on each page to exercise typography, chapter navigation, and restoring the same reading anchor after reflow.${unique} The window opens toward a quiet imaginary garden, and the reader continues at their own pace.</p>`
      }).join('')
      return [`OEBPS/${name.toLowerCase()}.xhtml`, `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${name}</title><style>body { font-family: serif; line-height: 1.4; } p { margin-bottom: .4em; }</style></head><body><h1>Chapter ${name}</h1>${paragraphs}</body></html>`]
    }),
  ]
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [path, text] of files) {
    const name = Buffer.from(path)
    const data = Buffer.from(text)
    const crc = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(name.length, 26)
    local.push(header, name, data)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)
    offset += header.length + name.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const value of data) {
    crc ^= value
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

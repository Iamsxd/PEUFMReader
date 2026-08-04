export function minimalPDF(pageTexts: string[] = ['Reader controls test']): Buffer {
  const texts = pageTexts.length > 0 ? pageTexts : ['Reader controls test']
  const pageCount = texts.length
  const fontID = 3 + pageCount
  const pageIDs = texts.map((_, index) => 3 + index)
  const contentIDs = texts.map((_, index) => fontID + 1 + index)
  const streams = texts.map((text) => `BT /F1 18 Tf 72 72 Td (${text.replace(/[()\\]/g, '')}) Tj ET`)
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    `<</Type/Pages/Kids[${pageIDs.map((id) => `${id} 0 R`).join(' ')}]/Count ${pageCount}>>`,
    ...pageIDs.map((_, index) => `<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Resources<</Font<</F1 ${fontID} 0 R>>>>/Contents ${contentIDs[index]} 0 R>>`),
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    ...streams.map((stream) => `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`),
  ]
  let content = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(content, 'ascii'))
    content += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(content, 'ascii')
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  content += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  content += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(content, 'ascii')
}

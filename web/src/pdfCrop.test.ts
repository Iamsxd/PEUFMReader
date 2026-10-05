import { describe, expect, it } from 'vitest'
import { NO_PDF_CROP, parsePDFCrop } from './pdfCrop'
describe('PDF per-book crop', () => {
  it('preserves old documents and rejects invalid margins', () => {
    expect(parsePDFCrop(null)).toEqual(NO_PDF_CROP)
    expect(parsePDFCrop('{broken')).toEqual(NO_PDF_CROP)
    expect(parsePDFCrop('{"top":0.1,"right":5,"bottom":-1,"left":"0.1"}')).toEqual({top:.1,right:.2,bottom:0,left:0})
  })
})

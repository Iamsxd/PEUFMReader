export interface PDFCrop { top: number; right: number; bottom: number; left: number }
export const NO_PDF_CROP: PDFCrop = { top: 0, right: 0, bottom: 0, left: 0 }
export function parsePDFCrop(value: string | null): PDFCrop {
  try {
    const raw = JSON.parse(value ?? '{}') as Partial<PDFCrop>
    return Object.fromEntries(Object.keys(NO_PDF_CROP).map(key => {
      const number = raw[key as keyof PDFCrop]
      return [key, typeof number === 'number' && Number.isFinite(number) ? Math.max(0, Math.min(.2, number)) : 0]
    })) as unknown as PDFCrop
  } catch { return { ...NO_PDF_CROP } }
}
export function fullPDFPageBounds(shell: Element): DOMRect {
  return (shell.querySelector('.pdf-page-content') ?? shell).getBoundingClientRect()
}

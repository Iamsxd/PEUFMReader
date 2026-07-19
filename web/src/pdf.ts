export class PDFContentError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message)
    this.name = 'PDFContentError'
  }
}

export async function fetchPDFBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/pdf' },
    signal,
  })
  if (!response.ok) {
    throw new PDFContentError(`PDF 文件请求失败（HTTP ${response.status}）`, response.status)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
    throw new PDFContentError('服务器返回的内容不是有效 PDF。')
  }
  return bytes
}

export function describePDFError(reason: unknown): string {
  if (reason instanceof PDFContentError) return reason.message
  if (reason instanceof Error) {
    switch (reason.name) {
      case 'PasswordException':
        return '该 PDF 受密码保护，当前版本无法打开。'
      case 'InvalidPDFException':
        return 'PDF 文件结构无效或不完整。'
      case 'MissingPDFException':
        return '服务器上的 PDF 文件不存在。'
      case 'UnexpectedResponseException':
        return 'PDF 文件请求返回了异常响应。'
    }
  }
  return 'PDF 加载失败，请刷新后重试。'
}

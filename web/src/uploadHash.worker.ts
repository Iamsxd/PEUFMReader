import { hashBlob } from './uploadHash'

self.onmessage = async (event: MessageEvent<File>) => {
  try {
    const hash = await hashBlob(event.data, (progress) => self.postMessage({ progress }))
    self.postMessage({ hash })
  } catch {
    self.postMessage({ error: '无法读取文件进行本地校验' })
  }
}

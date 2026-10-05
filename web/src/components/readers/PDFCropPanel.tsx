import { NO_PDF_CROP, type PDFCrop } from '../../pdfCrop'

interface Props {
  crop: PDFCrop
  onChange: (crop: PDFCrop) => void
  onClose: () => void
  onChromeActivity: () => void
}
const edges = [{ key: 'top', label: '上' }, { key: 'right', label: '右' }, { key: 'bottom', label: '下' }, { key: 'left', label: '左' }] as const
export function PDFCropPanel({ crop, onChange, onClose, onChromeActivity }: Props) {
  return <aside className="reader-side-panel" aria-label="PDF 裁边" onPointerDown={onChromeActivity}>
    <header><strong>本书页边裁切</strong><button onClick={onClose} aria-label="关闭侧栏">×</button></header>
    <div className="pdf-crop-controls">
      <p>只隐藏显示留白，不修改原文件。四边各最多 20%；批注与阅读位置仍使用原页坐标。</p>
      {edges.map(({ key, label }) => <label key={key}>{label}边 {Math.round(crop[key] * 100)}%
        <input type="range" aria-label={`裁切${label}边`} min="0" max="20" value={Math.round(crop[key] * 100)} onChange={event => onChange({ ...crop, [key]: Number(event.target.value) / 100 })} />
      </label>)}
      <button onClick={() => onChange({ ...NO_PDF_CROP })}>恢复完整页面</button>
      <small>此设置仅保存在当前账号的此设备，适用于本书所有页。</small>
    </div>
  </aside>
}

import { useEffect, useState } from 'react'
import type { HighlightColor } from '../../types'

export interface PendingHighlight {
  position: Record<string, unknown>
  overallProgress: number
  label: string
  quote: string
}

interface Props {
  selection: PendingHighlight
  busy: boolean
  onSave: (color: HighlightColor, body: string) => void
  onCancel: () => void
}

const COLORS: Array<{ value: HighlightColor; label: string }> = [
  { value: 'yellow', label: '黄色' },
  { value: 'green', label: '绿色' },
  { value: 'blue', label: '蓝色' },
  { value: 'pink', label: '粉色' },
  { value: 'purple', label: '紫色' },
]

export function HighlightComposer({ selection, busy, onSave, onCancel }: Props) {
  const [color, setColor] = useState<HighlightColor>('yellow')
  const [body, setBody] = useState('')

  useEffect(() => {
    setColor('yellow')
    setBody('')
  }, [selection])

  return (
    <section className="highlight-composer" aria-label="创建文本高亮" role="dialog">
      <button className="highlight-composer-close" type="button" onClick={onCancel} aria-label="取消高亮">×</button>
      <blockquote>{selection.quote}</blockquote>
      <div className="highlight-color-picker" aria-label="高亮颜色">
        {COLORS.map((item) => (
          <button
            key={item.value}
            type="button"
            className={`highlight-color ${item.value}${color === item.value ? ' active' : ''}`}
            aria-label={item.label}
            aria-pressed={color === item.value}
            onClick={() => setColor(item.value)}
          />
        ))}
      </div>
      <input value={body} maxLength={10000} onChange={(event) => setBody(event.target.value)} placeholder="可选：添加批注" aria-label="高亮批注" />
      <button type="button" disabled={busy} onClick={() => onSave(color, body.trim())}>{busy ? '保存中…' : '保存高亮'}</button>
    </section>
  )
}

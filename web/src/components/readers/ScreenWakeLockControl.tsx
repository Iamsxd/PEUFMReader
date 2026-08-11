import { useScreenWakeLock } from '../../hooks/useScreenWakeLock'

interface Props {
  onChromeActivity: () => void
}

export function ScreenWakeLockControl({ onChromeActivity }: Props) {
  const controls = useScreenWakeLock()
  const label = controls.status === 'active' ? '常亮：开' : controls.enabled ? '常亮：待恢复' : '屏幕常亮'

  return (
    <div className={`reader-wake-lock-control ${controls.status}`}>
      <button
        type="button"
        className={controls.enabled ? 'active' : ''}
        disabled={!controls.supported || controls.status === 'requesting'}
        aria-pressed={controls.enabled}
        aria-describedby="reader-wake-lock-status"
        title={controls.message}
        onClick={() => {
          onChromeActivity()
          controls.toggle()
        }}
      >{label}</button>
      <span id="reader-wake-lock-status" role="status" aria-live="polite">{controls.message}</span>
    </div>
  )
}

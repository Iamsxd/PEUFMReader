import type { BrowserSpeechControls } from '../../hooks/useSpeechSynthesis'

interface Props {
  controls: BrowserSpeechControls
  sourceDescription: string
  onClose: () => void
  onChromeActivity: () => void
}

const RATE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

export function SpeechPanel({ controls, sourceDescription, onClose, onChromeActivity }: Props) {
  const active = controls.status === 'speaking' || controls.status === 'paused'
  return (
    <aside className="reader-side-panel" aria-label="浏览器即时朗读" onPointerDown={onChromeActivity}>
      <header>
        <strong>即时朗读</strong>
        <button onClick={onClose} aria-label="关闭侧栏">×</button>
      </header>
      <div className="reader-speech-panel">
        <p className="reader-speech-source">{controls.sourceLabel || sourceDescription}</p>
        {!controls.supported && <p className="reader-panel-error">当前浏览器不支持 Web Speech API，请升级 Safari、Chrome 或 Edge。</p>}

        <label>
          <span>音色</span>
          <select
            value={controls.selectedVoiceURI}
            disabled={!controls.supported}
            onChange={(event) => controls.selectVoice(event.target.value)}
          >
            <option value="">系统默认</option>
            {controls.voices.map((voice) => (
              <option key={voice.voiceURI} value={voice.voiceURI}>
                {voice.name} · {voice.lang}{voice.localService ? ' · 本地' : ''}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>语速</span>
          <select value={controls.rate} disabled={!controls.supported} onChange={(event) => controls.selectRate(Number(event.target.value))}>
            {RATE_OPTIONS.map((rate) => <option key={rate} value={rate}>{Number(rate.toFixed(2))}×</option>)}
          </select>
        </label>

        <div className="reader-speech-actions">
          <button className="primary" disabled={!controls.supported || controls.status === 'loading'} onClick={() => void controls.start()}>
            {controls.status === 'loading' ? '读取中…' : active ? '重新朗读' : '开始朗读'}
          </button>
          <button disabled={!active} onClick={controls.pauseOrResume}>{controls.status === 'paused' ? '继续' : '暂停'}</button>
          <button disabled={!active && controls.status !== 'loading'} onClick={controls.stop}>停止</button>
        </div>

        {(controls.progressLabel || controls.error) && (
          <p className={controls.error ? 'reader-panel-error' : 'reader-speech-progress'} role="status" aria-live="polite">
            {controls.error || controls.progressLabel}
          </p>
        )}
        <p className="reader-speech-note">朗读不经过 PEUFMReader 或 NAS；音色是否完全离线由当前浏览器和操作系统决定。更换音色或语速会停止当前朗读。</p>
      </div>
    </aside>
  )
}

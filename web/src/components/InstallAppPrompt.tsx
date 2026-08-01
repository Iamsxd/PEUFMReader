import { useEffect, useState } from 'react'
import { dismissInstallSuggestion, installSuggestionDismissed, isIOSDevice, isStandaloneDisplay, type BeforeInstallPromptEvent } from '../pwa'

export function InstallAppPrompt() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [standalone, setStandalone] = useState(isStandaloneDisplay)
  const [dismissed, setDismissed] = useState(installSuggestionDismissed)
  const ios = isIOSDevice()

  useEffect(() => {
    const displayMode = window.matchMedia('(display-mode: standalone)')
    const updateStandalone = () => setStandalone(isStandaloneDisplay())
    const captureInstall = (event: Event) => {
      event.preventDefault()
      setInstallEvent(event as BeforeInstallPromptEvent)
    }
    const installed = () => {
      setStandalone(true)
      setInstallEvent(null)
    }
    window.addEventListener('beforeinstallprompt', captureInstall)
    window.addEventListener('appinstalled', installed)
    displayMode.addEventListener?.('change', updateStandalone)
    document.documentElement.classList.toggle('standalone-app', standalone)
    return () => {
      window.removeEventListener('beforeinstallprompt', captureInstall)
      window.removeEventListener('appinstalled', installed)
      displayMode.removeEventListener?.('change', updateStandalone)
      document.documentElement.classList.remove('standalone-app')
    }
  }, [standalone])

  async function install() {
    if (!installEvent) return
    await installEvent.prompt()
    const choice = await installEvent.userChoice
    if (choice.outcome === 'accepted') setStandalone(true)
    else dismiss()
    setInstallEvent(null)
  }

  function dismiss() {
    dismissInstallSuggestion()
    setDismissed(true)
  }

  if (standalone || dismissed || (!installEvent && !ios)) return null
  return (
    <aside className="install-app-prompt" role="status" aria-label="安装 PEUFMReader">
      <img src="/icons/icon-192.png" alt="" width="48" height="48" />
      <div>
        <strong>把 PEUFMReader 添加到主屏幕</strong>
        <span>{installEvent ? '独立窗口打开，像普通应用一样进入书库。' : '在 Safari 中点“分享”，再选择“添加到主屏幕”。'}</span>
      </div>
      {installEvent && <button className="primary" type="button" onClick={() => void install()}>立即安装</button>}
      <button className="quiet" type="button" onClick={dismiss}>暂不提示</button>
    </aside>
  )
}

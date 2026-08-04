export interface ReaderCenterTapInput {
  startX: number
  startY: number
  endX: number
  endY: number
  viewportWidth: number
  viewportHeight: number
  hasSelection?: boolean
  interactiveTarget?: boolean
}

const MAX_TAP_MOVEMENT_PX = 14
export const MOBILE_READER_CHROME_QUERY = '(max-width: 720px), (hover: none) and (pointer: coarse)'

export function isReaderCenterTap(input: ReaderCenterTapInput): boolean {
  if (input.viewportWidth <= 0 || input.viewportHeight <= 0 || input.hasSelection || input.interactiveTarget) return false

  const movement = Math.hypot(input.endX - input.startX, input.endY - input.startY)
  if (movement > MAX_TAP_MOVEMENT_PX) return false

  const horizontalPosition = input.endX / input.viewportWidth
  const verticalPosition = input.endY / input.viewportHeight
  return horizontalPosition >= 0.25
    && horizontalPosition <= 0.75
    && verticalPosition >= 0.18
    && verticalPosition <= 0.82
}

export function isInteractiveReaderTarget(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => Element | null } | null
  return Boolean(element?.closest?.('a, button, input, select, textarea, label, summary, [role="button"], [contenteditable="true"]'))
}

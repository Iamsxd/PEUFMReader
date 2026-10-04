export const MAX_READER_NAVIGATION_ENTRIES = 50

export interface ReaderNavigationOptions<Position> {
  equals?: (left: Position, right: Position) => boolean
  isValid?: (position: Position) => boolean
  /** Smaller histories are supported, but never more than 50 positions. */
  maxEntries?: number
}

export interface ReaderNavigationHistory<Position> {
  readonly canBack: boolean
  readonly canForward: boolean
  /** Record the origin of a successful, explicit jump, not ordinary page turns. */
  record(currentPosition: Position, destination?: Position): boolean
  /** Preview before an asynchronous display; a failed display must not commit history. */
  peekBack(currentPosition?: Position): Position | undefined
  peekForward(currentPosition?: Position): Position | undefined
  goBack(currentPosition: Position): Position | undefined
  goForward(currentPosition: Position): Position | undefined
  clear(): void
}

function isUsablePosition(position: unknown): boolean {
  if (position == null) return false
  if (typeof position === 'string') return position.trim().length > 0
  if (typeof position === 'number') return Number.isFinite(position)
  return true
}

/**
 * An in-memory history scoped to one reader/book. Positions should be immutable
 * snapshots (e.g. a CFI string or { page, yRatio }), never live view objects.
 * Capture the actual visible origin before a jump. For asynchronous readers,
 * preview a target and commit goBack/goForward with that captured origin only
 * after display succeeds. No React, browser storage, or server state is used.
 */
export function createReaderNavigationHistory<Position>(
  options: ReaderNavigationOptions<Position> = {},
): ReaderNavigationHistory<Position> {
  const equals = options.equals ?? Object.is
  const isValid = (position: Position) => isUsablePosition(position) && (options.isValid?.(position) ?? true)
  const requestedLimit = options.maxEntries
  const limit = typeof requestedLimit === 'number' && Number.isFinite(requestedLimit) && requestedLimit >= 1
    ? Math.min(MAX_READER_NAVIGATION_ENTRIES, Math.floor(requestedLimit))
    : MAX_READER_NAVIGATION_ENTRIES
  const back: Position[] = []
  const forward: Position[] = []

  function pushDistinct(stack: Position[], position: Position): boolean {
    if (stack.length && equals(stack[stack.length - 1], position)) return false
    stack.push(position)
    if (stack.length > limit) stack.splice(0, stack.length - limit)
    return true
  }

  function targetIndex(stack: Position[], currentPosition?: Position): number {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (currentPosition === undefined || !equals(stack[index], currentPosition)) return index
    }
    return -1
  }

  function peek(stack: Position[], currentPosition?: Position): Position | undefined {
    const index = targetIndex(stack, currentPosition)
    return index >= 0 ? stack[index] : undefined
  }

  function navigate(from: Position[], to: Position[], currentPosition: Position): Position | undefined {
    if (!isValid(currentPosition)) return undefined
    const index = targetIndex(from, currentPosition)
    if (index < 0) return undefined
    const target = from[index]
    // Also discard entries now equal to the actual position after normal paging.
    from.splice(index)
    pushDistinct(to, currentPosition)
    return target
  }

  return {
    get canBack() { return back.length > 0 },
    get canForward() { return forward.length > 0 },
    record(currentPosition, destination) {
      if (!isValid(currentPosition)) return false
      if (destination !== undefined && (!isValid(destination) || equals(currentPosition, destination))) return false
      const changed = pushDistinct(back, currentPosition) || forward.length > 0
      forward.length = 0
      return changed
    },
    peekBack(currentPosition) { return peek(back, currentPosition) },
    peekForward(currentPosition) { return peek(forward, currentPosition) },
    goBack(currentPosition) { return navigate(back, forward, currentPosition) },
    goForward(currentPosition) { return navigate(forward, back, currentPosition) },
    clear() {
      back.length = 0
      forward.length = 0
    },
  }
}

import { useEffect, useRef, useState, type PointerEvent, type MouseEvent } from 'react'
import { meaningfulShelfDrop, type ShelfDrop } from '../shelfOrder'

interface Drag {
  pointerID: number
  handle: HTMLButtonElement
  bookId: number
  x: number
  y: number
  started: boolean
  target: ShelfDrop | null
}

export function useShelfDragSort(scope: string, disabled: boolean, ids: number[], onDrop: (drop: ShelfDrop) => void) {
  const listRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [status, setStatus] = useState('')
  const cancelRef = useRef<() => void>(() => {})

  function clear() {
    const current = dragRef.current
    dragRef.current = null
    if (current?.handle.hasPointerCapture(current.pointerID)) current.handle.releasePointerCapture(current.pointerID)
    setDrag(null)
    return current
  }
  cancelRef.current = () => {
    if (clear()) setStatus('已取消排序，阅读顺序未改变。')
  }

  useEffect(() => {
    cancelRef.current()
  }, [scope, disabled])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dragRef.current) {
        event.preventDefault()
        cancelRef.current()
      }
    }
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('keydown', escape)
      const current = dragRef.current
      dragRef.current = null
      if (current?.handle.hasPointerCapture(current.pointerID)) current.handle.releasePointerCapture(current.pointerID)
    }
  }, [])

  function updateTarget(event: PointerEvent<HTMLButtonElement>) {
    const current = dragRef.current
    if (!current || current.pointerID !== event.pointerId) return
    const started = current.started || Math.hypot(event.clientX - current.x, event.clientY - current.y) >= 5
    const card = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.shelf-book[data-book-id]')
    let target: ShelfDrop | null = null
    if (started && card && listRef.current?.contains(card)) {
      const targetBookId = Number(card.dataset.bookId)
      const bounds = card.getBoundingClientRect()
      const placement = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
      const candidate = { bookId: current.bookId, targetBookId, placement } as ShelfDrop
      if (meaningfulShelfDrop(ids, candidate)) target = candidate
    }
    const next = { ...current, started, target }
    dragRef.current = next
    setDrag(next)
    if (started) setStatus(target ? `松开后移动到目标书籍${target.placement === 'before' ? '之前' : '之后'}。按 Esc 取消。` : '拖到本页另一张书籍卡片的上半或下半部分，松开保存。')
  }

  function handleProps(bookId: number) {
    return {
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        if (disabled || dragRef.current || !event.isPrimary || event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        const next: Drag = { pointerID: event.pointerId, handle: event.currentTarget, bookId, x: event.clientX, y: event.clientY, started: false, target: null }
        dragRef.current = next
        setDrag(next)
        setStatus('拖动握柄调整本页顺序；也可使用提前和延后按钮。')
      },
      onPointerMove: updateTarget,
      onPointerUp(event: PointerEvent<HTMLButtonElement>) {
        if (dragRef.current?.pointerID !== event.pointerId) return
        updateTarget(event)
        const current = clear()
        if (current?.started && current.target && !disabled) {
          setStatus('正在保存新的阅读顺序…')
          onDrop(current.target)
        } else setStatus('阅读顺序未改变。')
      },
      onPointerCancel(event: PointerEvent<HTMLButtonElement>) { if (dragRef.current?.pointerID === event.pointerId) cancelRef.current() },
      onLostPointerCapture(event: PointerEvent<HTMLButtonElement>) { if (dragRef.current?.pointerID === event.pointerId) cancelRef.current() },
      onClick(event: MouseEvent<HTMLButtonElement>) { event.preventDefault() },
    }
  }
  return { listRef, active: !!drag, sourceID: drag?.bookId, target: drag?.target, status, setStatus, handleProps }
}

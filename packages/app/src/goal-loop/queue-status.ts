export type QueueStatusItem = {
  identifier: string
  title: string
}

export type QueueStatusSnapshot = {
  items: QueueStatusItem[]
  index: number
  done: boolean
  ok: boolean
  reason?: string
}

type Listener = (snapshot: QueueStatusSnapshot | null) => void

let current: QueueStatusSnapshot | null = null
const listeners = new Set<Listener>()

function copy(snapshot: QueueStatusSnapshot | null): QueueStatusSnapshot | null {
  if (!snapshot) return null
  return { ...snapshot, items: snapshot.items.map((item) => ({ ...item })) }
}

function emit() {
  const snapshot = copy(current)
  for (const cb of Array.from(listeners)) {
    try {
      cb(snapshot)
    } catch {
      // Listener errors must never break queue tracking.
    }
  }
}

export function setQueue(items: Array<{ identifier: string; title: string }>, startIndex?: number): void {
  if (items.length === 0) {
    current = null
    emit()
    return
  }
  const copied = items.map((item) => ({ identifier: item.identifier, title: item.title }))
  const maxIndex = copied.length - 1
  const requested = startIndex ?? 0
  const index = Math.min(Math.max(requested, 0), maxIndex)
  current = { items: copied, index, done: false, ok: true }
  emit()
}

export function advance(identifier: string): void {
  if (!current || current.done) return
  const active = current.items[current.index]
  if (!active || active.identifier !== identifier) return
  if (current.index >= current.items.length - 1) {
    current = { ...current, done: true, ok: true }
  } else {
    current = { ...current, index: current.index + 1 }
  }
  emit()
}

export function halt(reason?: string): void {
  if (!current || current.done) return
  current = reason === undefined ? { ...current, done: true, ok: false } : { ...current, done: true, ok: false, reason }
  emit()
}

export function clear(): void {
  if (!current) return
  current = null
  emit()
}

export function get(): QueueStatusSnapshot | null {
  return copy(current)
}

export function subscribe(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
